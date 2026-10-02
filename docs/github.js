// Everything that talks to GitHub. Auth, ETags and rate limits live here and
// nowhere else, so there is one place to audit how the token is used.
//
// Two tokens, because a fine-grained PAT has ONE permission set across all its
// repos and this app needs read-only on the private code repo but write on the
// public image repo:
//
//   code  — Social (private):    Metadata R, Contents READ-ONLY, Actions RW
//   media — myimagerepo (public): Metadata R, Contents RW
//
// The code token is deliberately read-only on contents. With write, anyone who
// lifted it could rewrite src/cli.py, dispatch a workflow, and read
// IG_ACCESS_TOKEN out of the runner's environment. Read-only makes this client
// structurally incapable of editing the queue, so every guard in the Python
// applies unconditionally — enforced by a token scope, not by code review.

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const DB = 'autoposter-operator';

// --- token storage -------------------------------------------------------
// IndexedDB holding AES-GCM ciphertext plus a NON-EXTRACTABLE CryptoKey, so
// the key bytes never exist in JS. Honest about what that buys: it does not
// stop live XSS, since same-origin script can call decrypt(). It stops passive
// extraction — a devtools storage dump, a browser profile backup, an extension
// reading localStorage. Storage is a security path, so it is not the place to
// save twenty lines.

function idb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function kv(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cryptoKey() {
  const existing = await kv('readonly', (s) => s.get('key'));
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await kv('readwrite', (s) => s.put(key, 'key'));
  return key;
}

export async function saveSettings(settings) {
  const key = await cryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(settings));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  await kv('readwrite', (s) => s.put({ iv, ct }, 'settings'));
}

export async function loadSettings() {
  const row = await kv('readonly', (s) => s.get('settings'));
  if (!row) return null;
  try {
    const key = await cryptoKey();
    const out = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: row.iv }, key, row.ct);
    return JSON.parse(new TextDecoder().decode(out));
  } catch {
    return null;  // key rotated or data corrupt — treat as not set up
  }
}

export async function forgetSettings() {
  await kv('readwrite', (s) => s.delete('settings'));
  await kv('readwrite', (s) => s.delete('key'));
}

// --- requests ------------------------------------------------------------

export const rateLimit = { remaining: null, reset: null };

// 304s do not count against the 5,000/hr budget, which is the whole polling
// strategy: poll often, pay almost nothing when nothing changed.
const etags = new Map();

class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
export { HttpError };

async function request(path, { token, method = 'GET', body, accept, etag } = {}) {
  const headers = { 'X-GitHub-Api-Version': '2022-11-28' };
  headers.Accept = accept || 'application/vnd.github+json';
  // Only ever a header. Never a URL or query parameter, where it would land in
  // history, logs and referrers.
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const key = method + ' ' + path;
  if (etag && etags.has(key)) headers['If-None-Match'] = etags.get(key);

  const res = await fetch(API + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });

  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null) {
    rateLimit.remaining = Number(remaining);
    rateLimit.reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
  }

  if (res.status === 304) return { notModified: true, date: res.headers.get('date') };
  if (res.status === 401) throw new HttpError(401, 'Token rejected. It may have expired — generate a new one and paste it in Settings.');
  if (res.status === 403 || res.status === 429) {
    const retry = res.headers.get('retry-after');
    throw new HttpError(res.status, retry
      ? `GitHub asked us to wait ${retry}s before retrying.`
      : 'Forbidden. Check the token has the permissions listed in Settings.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* no body */ }
    throw new HttpError(res.status, detail || `${res.status} ${res.statusText}`);
  }

  if (etag) {
    const tag = res.headers.get('etag');
    if (tag) etags.set(key, tag);
  }
  const date = res.headers.get('date');
  if (res.status === 204) return { ok: true, date };
  const text = await res.text();
  const payload = accept === 'application/vnd.github.raw'
    ? text : (text ? JSON.parse(text) : null);
  return { data: payload, date };
}

// --- reads ---------------------------------------------------------------

export async function defaultBranch(cfg) {
  // Never hardcoded. This repo's default is currently a feature branch and is
  // clearly heading for main; a hardcoded ref would break silently on the move.
  const { data } = await request(`/repos/${cfg.owner}/${cfg.repo}`, { token: cfg.codeToken });
  return data.default_branch;
}

export async function getFile(cfg, path, ref) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return request(`/repos/${cfg.owner}/${cfg.repo}/contents/${path}${q}`, {
    token: cfg.codeToken, accept: 'application/vnd.github.raw', etag: true,
  });
}

export async function listRuns(cfg, perPage = 20) {
  return request(`/repos/${cfg.owner}/${cfg.repo}/actions/runs?per_page=${perPage}`,
    { token: cfg.codeToken, etag: true });
}

export async function listJobs(cfg, runId) {
  return request(`/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}/jobs`,
    { token: cfg.codeToken });
}

export async function workflowRuns(cfg, file, perPage = 5) {
  return request(
    `/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${file}/runs`
    + `?event=workflow_dispatch&per_page=${perPage}`,
    { token: cfg.codeToken });
}

// The image repo is public, so listing and displaying need no token at all.
export async function listMedia(cfg) {
  const { data } = await request(
    `/repos/${cfg.mediaRepo}/contents/posts/media`, { etag: true });
  return (data || []).filter((f) => f.name.endsWith('.jpg')).map((f) => f.name);
}

export function imageUrl(cfg, repoPath) {
  return `${RAW}/${cfg.mediaRepo}/${cfg.mediaBranch}/${repoPath}`;
}

// --- writes --------------------------------------------------------------

export async function dispatch(cfg, file, inputs, ref) {
  // 204 with no run id, so the caller has to go and find the run. Return the
  // server's Date header as the watermark — using the client clock here would
  // mismatch runs whenever the phone's clock drifts.
  const { date } = await request(
    `/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${file}/dispatches`, {
      token: cfg.codeToken, method: 'POST', body: { ref, inputs },
    });
  return { dispatchedAt: date ? new Date(date).getTime() : Date.now() };
}

export async function uploadImage(cfg, name, base64, message) {
  // Straight into the PUBLIC image repo, with the media token. A dispatch
  // input cannot carry a ~95KB JPEG. `cli queue` already falls back to
  // src.watch.fetch_image, which pulls an image that exists only there — so
  // this puts the file exactly where that fallback already looks.
  return request(`/repos/${cfg.mediaRepo}/contents/posts/media/${name}`, {
    token: cfg.mediaToken, method: 'PUT',
    body: { message, content: base64, branch: cfg.mediaBranch },
  });
}
