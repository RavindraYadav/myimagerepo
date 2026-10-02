// Wiring. All the rules live in logic.js; all the network lives in github.js.
//
// One discipline runs through this file: captions are arbitrary text written by
// an LLM, so they are only ever put on the page with textContent. No innerHTML
// anywhere, on a page that holds a token.

import * as gh from './github.js';
import {
  canApprove, captionProblem, cropBox, EDITABLE, formatSlot, imageName, isDue,
  makeSerializer, matchRun, MAX_CAPTION, NEEDS_CAPTION, opState, ratioOk,
  STATUS_HELP,
} from './logic.js';

const ACTION_WF = 'instagram-post-action.yml';
const QUEUE_WF = 'publish-now.yml';
const $ = (sel) => document.querySelector(sel);

const state = {
  cfg: null, branch: null, posts: [], runs: [], ops: [], cropped: null,
};

// --- chrome --------------------------------------------------------------

function say(message, kind = 'warn') {
  const el = $('#banner');
  el.textContent = message;
  el.className = kind;
  el.hidden = !message;
}

function show(view) {
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== `view-${view}`;
  }
  for (const tab of document.querySelectorAll('#tabs button')) {
    tab.classList.toggle('on', tab.dataset.view === view);
  }
  if (view === 'runs') refreshRuns();
  if (view === 'new') refreshMedia();
}

document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => show(b.dataset.view));
});
$('#refresh').addEventListener('click', () => refreshAll());

// --- ops: optimistic state with a two-gate clear -------------------------

const serializer = makeSerializer(async (job) => {
  const { dispatchedAt } = await gh.dispatch(state.cfg, job.workflow,
    job.inputs, state.branch);
  const op = { ...job, dispatchedAt, run: null };
  state.ops.push(op);
  renderQueue();
  // Hold the serializer until this run finishes. Every repo-writing workflow
  // shares one concurrency group, and GitHub cancels earlier PENDING runs in a
  // group — so overlapping dispatches lose the middle ones outright.
  await settle(op);
  return op;
});

async function settle(op) {
  for (let i = 0; ; i += 1) {
    await sleep([2000, 3000, 5000, 8000, 13000][i] ?? 15000);
    try {
      const { data } = await gh.workflowRuns(state.cfg, op.workflow);
      op.run = matchRun(data && data.workflow_runs, op.dispatchedAt);
    } catch { /* transient; the timeout below is the backstop */ }

    if (op.run && op.run.status === 'completed') await loadQueue();
    const post = state.posts.find((p) => p.id === op.postId);
    const next = opState(op, op.run, post);
    renderQueue();
    if (next !== 'pending') {
      op.state = next;
      if (next === 'done') {
        setTimeout(() => {
          state.ops = state.ops.filter((o) => o !== op);
          renderQueue();
        }, 1500);
      }
      return next;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function submit(job) {
  serializer.submit(job).catch((e) => say(e.message));
  if (serializer.depth > 1) {
    say(`${serializer.depth} actions queued — sending one at a time so none is dropped.`, 'info');
  }
}

const opFor = (id) => state.ops.find((o) => o.postId === id);

// --- queue ---------------------------------------------------------------

async function loadQueue() {
  const res = await gh.getFile(state.cfg, 'posts/queue.yaml', state.branch);
  if (res.notModified) return;
  state.posts = jsyaml.load(res.data) || [];
}

function renderQueue() {
  const list = $('#queue-list');
  list.textContent = '';
  const counts = {};
  for (const p of state.posts) counts[p.status] = (counts[p.status] || 0) + 1;
  $('#queue-summary').textContent = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`).join(' · ');
  $('#queue-empty').hidden = state.posts.length > 0;

  const order = { pending: 0, publishing: 1, failed: 2, approved: 3, published: 4, rejected: 5 };
  const sorted = [...state.posts].sort((a, b) =>
    (order[a.status] ?? 9) - (order[b.status] ?? 9)
    || new Date(a.publish_at) - new Date(b.publish_at));

  for (const post of sorted) list.append(renderPost(post));
}

function renderPost(post) {
  const node = $('#tpl-post').content.cloneNode(true);
  const el = node.querySelector('.post');
  el.dataset.status = post.status;

  const img = node.querySelector('.card');
  img.src = gh.imageUrl(state.cfg, post.image);
  img.alt = '';
  // There is a one-run window where the file has moved between posts/media and
  // posts/published but the queue entry has not caught up. One swap, and a
  // whole class of "why is the image broken" disappears.
  img.onerror = () => {
    const swapped = post.image.includes('/published/')
      ? post.image.replace('/published/', '/media/')
      : post.image.replace('/media/', '/published/');
    if (img.dataset.swapped) { img.style.visibility = 'hidden'; return; }
    img.dataset.swapped = '1';
    img.src = gh.imageUrl(state.cfg, swapped);
  };

  node.querySelector('.when').textContent =
    formatSlot(post.publish_at) + (isDue(post) && post.status === 'approved' ? ' — due now' : '');
  node.querySelector('.status').textContent =
    `${post.status} — ${STATUS_HELP[post.status] || ''}`;

  if (post.error) {
    const err = node.querySelector('.error');
    err.textContent = post.error;
    err.hidden = false;
  }

  const caption = node.querySelector('.caption');
  caption.value = post.caption === NEEDS_CAPTION ? '' : post.caption;
  caption.placeholder = post.caption === NEEDS_CAPTION
    ? 'No caption yet — write one before approving' : '';
  const editable = EDITABLE.includes(post.status);
  caption.disabled = !editable;

  const note = node.querySelector('.caption-note');
  const approve = node.querySelector('.approve');
  const now = node.querySelector('.now');
  const reject = node.querySelector('.reject');

  function sync() {
    const problem = captionProblem(caption.value);
    note.textContent = problem
      || `${caption.value.length} / ${MAX_CAPTION}`;
    note.classList.toggle('warn', !!problem);
    const busy = !!opFor(post.id);
    approve.disabled = now.disabled = !!problem || post.status !== 'pending' || busy;
    reject.disabled = post.status !== 'pending' || busy;
  }
  caption.addEventListener('input', sync);
  sync();

  // The caption rides along with the approval, so a watcher-queued image goes
  // from "no caption" to approved in ONE run instead of two.
  const captionInput = () =>
    (caption.value !== post.caption && caption.value.trim() ? caption.value : '');

  approve.addEventListener('click', () => act(post, 'approved', { caption: captionInput() }));
  now.addEventListener('click', () => {
    if (!confirm(`Publish "${post.id}" to Instagram within the minute?`)) return;
    act(post, 'approve-and-post', { caption: captionInput() });
  });
  reject.addEventListener('click', () => {
    if (!confirm(`Reject "${post.id}"? It will never publish.`)) return;
    act(post, 'rejected', {});
  });

  const more = node.querySelector('.more');
  const at = node.querySelector('.at');
  node.querySelector('.move').addEventListener('click', () => {
    if (!at.value) return say('Pick a date and time first.');
    act(post, 'reschedule', { publish_at: `${at.value}:00Z` });
  });
  if (!editable) more.querySelector('.move').disabled = true;

  // Repair only appears for the one state a human must resolve by hand.
  if (post.status === 'publishing' || post.status === 'failed') {
    const repair = node.querySelector('.repair');
    repair.hidden = false;
    more.open = true;
    const mediaId = node.querySelector('.media-id');
    node.querySelector('.mark-published').addEventListener('click', () => {
      if (!mediaId.value.trim()) return say('Check the account and enter the media id it published under.');
      act(post, 'repair', { to_status: 'published', published_id: mediaId.value.trim() });
    });
    node.querySelector('.mark-failed').addEventListener('click', () =>
      act(post, 'repair', { to_status: 'failed' }));
  }

  const op = opFor(post.id);
  if (op) {
    const line = node.querySelector('.op');
    line.hidden = false;
    line.textContent = {
      pending: 'Sending…',
      done: 'Done.',
      failed: 'That did not apply. Check Runs, then try again.',
      unknown: 'The run finished but the queue has not changed. Check Runs.',
    }[op.state || 'pending'];
    line.classList.toggle('warn', op.state === 'failed' || op.state === 'unknown');
    el.classList.add('busy');
  }
  return node;
}

function act(post, action, extra) {
  const inputs = { post_id: post.id, action, caption: '', publish_at: '',
                   to_status: '', published_id: '', ...extra };
  submit({ workflow: ACTION_WF, postId: post.id, action,
           caption: inputs.caption, toStatus: inputs.to_status, inputs });
  renderQueue();
}

// --- runs ----------------------------------------------------------------

async function refreshRuns() {
  try {
    const res = await gh.listRuns(state.cfg);
    if (!res.notModified) state.runs = (res.data && res.data.workflow_runs) || [];
  } catch (e) { return say(e.message); }

  const list = $('#runs-list');
  list.textContent = '';
  for (const run of state.runs) {
    const node = $('#tpl-run').content.cloneNode(true);
    const outcome = run.status === 'completed' ? run.conclusion : run.status;
    node.querySelector('.dot').dataset.outcome = outcome;
    node.querySelector('.name').textContent = run.name;
    node.querySelector('.meta').textContent =
      `${outcome} · ${new Date(run.created_at).toLocaleString()}`;

    const steps = node.querySelector('.steps');
    if (run.conclusion && run.conclusion !== 'success') {
      node.querySelector('.run').addEventListener('click', async () => {
        if (!steps.hidden) { steps.hidden = true; return; }
        const { data } = await gh.listJobs(state.cfg, run.id);
        const failed = (data.jobs || []).flatMap((j) => j.steps || [])
          .filter((s) => s.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped');
        steps.textContent = failed.length
          ? 'Failed: ' + failed.map((s) => s.name).join(', ') : 'No failed step recorded.';
        steps.hidden = false;
      });
    }
    list.append(node);
  }

  // The operator has been repeatedly blind to failures, so a recent red run is
  // a persistent banner, not something you have to go looking for.
  const bad = state.runs.find((r) => r.conclusion && r.conclusion !== 'success'
    && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
  if (bad) say(`"${bad.name}" failed — open Runs for the reason.`);
}

// --- new post ------------------------------------------------------------

let mediaNames = [];
async function refreshMedia() {
  try { mediaNames = await gh.listMedia(state.cfg); } catch { mediaNames = []; }
}

$('#file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadForUpload(file);
});
$('#ratio').addEventListener('change', () => { if (sourceBitmap) drawCrop(); });

let sourceBitmap = null;

async function loadForUpload(file) {
  sourceBitmap = await createImageBitmap(file);
  const row = $('#crop-row');
  const fits = ratioOk(sourceBitmap.width, sourceBitmap.height);
  row.hidden = false;
  $('#crop-note').textContent = fits
    ? `${sourceBitmap.width}×${sourceBitmap.height} — fits Instagram as is.`
    : `${sourceBitmap.width}×${sourceBitmap.height} is outside Instagram's 4:5 to 1.91:1 range, so it would be rejected. Cropping it.`;
  drawCrop();
}

function drawCrop() {
  const ratio = Number($('#ratio').value);
  const fits = ratioOk(sourceBitmap.width, sourceBitmap.height);
  const canvas = $('#preview');
  // Re-encoding through the canvas is not cosmetic: it makes the output JPEG
  // unconditionally (phones hand us HEIC, and Meta needs JPEG) and drops EXIF
  // — including the GPS coordinates phone photos carry, which would otherwise
  // be committed to a PUBLIC repo.
  const box = fits
    ? { x: 0, y: 0, w: sourceBitmap.width, h: sourceBitmap.height }
    : cropBox(sourceBitmap.width, sourceBitmap.height, ratio);
  canvas.width = box.w;
  canvas.height = box.h;
  canvas.getContext('2d').drawImage(sourceBitmap, box.x, box.y, box.w, box.h,
    0, 0, box.w, box.h);
  canvas.hidden = false;
  canvas.toBlob((blob) => { state.cropped = blob; validateNew(); }, 'image/jpeg', 0.9);
}

const captionBox = $('#new-caption');
captionBox.addEventListener('input', validateNew);
$('#new-at').addEventListener('input', validateNew);

function validateNew() {
  $('#new-count').textContent = captionBox.value.length;
  const problem = captionProblem(captionBox.value);
  $('#new-count').classList.toggle('warn', captionBox.value.length > MAX_CAPTION);
  $('#create').disabled = !state.cropped || !!problem;
  return problem;
}

$('#create').addEventListener('click', async () => {
  const button = $('#create');
  const status = $('#new-status');
  button.disabled = true;

  try {
    const date = new Date().toISOString().slice(0, 10);
    const name = imageName(captionBox.value, date, mediaNames);
    status.textContent = `Uploading ${name}…`;

    const base64 = await blobToBase64(state.cropped);
    // The upload must land BEFORE the dispatch. If it fails we stop here, so a
    // post is never queued against an image that is not there.
    await gh.uploadImage(state.cfg, name, base64, `Add ${name} [skip ci]`);
    mediaNames.push(name);

    const postNow = $('#post-now').checked;
    const at = $('#new-at').value;
    if (postNow && !confirm('Publish this to Instagram within the minute?')) {
      status.textContent = 'Uploaded, but not queued.';
      button.disabled = false;
      return;
    }

    status.textContent = 'Queueing…';
    await gh.dispatch(state.cfg, QUEUE_WF, {
      image: name,
      caption: captionBox.value,
      // Blank means "next free slot" — cli queue already works that out from
      // the schedule. Re-implementing slot selection here would be exactly the
      // duplicated logic this whole design avoids.
      publish_at: postNow ? 'now' : (at ? `${at}:00Z` : ''),
      approve_and_publish: postNow,
    }, state.branch);

    status.textContent = postNow
      ? 'Sent. It will publish within a minute — watch Runs.'
      : 'Queued as pending. Approve it from the Queue tab.';
    captionBox.value = '';
    $('#file').value = '';
    $('#preview').hidden = true;
    $('#crop-row').hidden = true;
    state.cropped = null;
    sourceBitmap = null;
    setTimeout(() => refreshAll(), 20000);
  } catch (e) {
    status.textContent = '';
    say(e.message);
    button.disabled = false;
  }
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// --- settings ------------------------------------------------------------

const FIELDS = ['owner', 'repo', 'mediaRepo', 'codeToken', 'mediaToken', 'expires'];

$('#save-settings').addEventListener('click', async () => {
  const cfg = {};
  for (const f of FIELDS) cfg[f] = $(`#${f}`).value.trim();
  if (!cfg.owner || !cfg.repo || !cfg.codeToken) {
    return say('GitHub user, code repo and the code-repo token are all required.');
  }
  cfg.mediaBranch = 'main';
  await gh.saveSettings(cfg);
  state.cfg = cfg;
  $('#settings-status').textContent = 'Saved.';
  say('');
  await refreshAll();
});

$('#forget').addEventListener('click', async () => {
  if (!confirm('Remove the tokens and settings from this device?')) return;
  await gh.forgetSettings();
  location.reload();
});

// --- boot ----------------------------------------------------------------

async function refreshAll() {
  if (!state.cfg) return;
  try {
    if (!state.branch) state.branch = await gh.defaultBranch(state.cfg);
    await loadQueue();
    renderQueue();
    await refreshRuns();
    if (state.cfg.expires) {
      const days = Math.round((new Date(state.cfg.expires) - Date.now()) / 86400000);
      if (days <= 7) {
        say(days < 0 ? 'Your token has expired. Generate a new one and paste it in Settings.'
                     : `Your token expires in ${days} day${days === 1 ? '' : 's'}.`);
      }
    }
  } catch (e) {
    say(e.message);
  }
}

// Idle costs nothing: no background timers. A forgotten-open tab must not burn
// the rate-limit budget.
let timer = null;
function startPolling() {
  stopPolling();
  timer = setInterval(() => { if (!document.hidden) refreshAll(); }, 60000);
}
function stopPolling() { if (timer) clearInterval(timer); timer = null; }

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else { refreshAll(); startPolling(); }
});

(async function boot() {
  state.cfg = await gh.loadSettings();
  if (!state.cfg) {
    show('settings');
    say('Add your repos and a token to get started.', 'info');
    return;
  }
  for (const f of FIELDS) {
    if (state.cfg[f] && !f.endsWith('Token')) $(`#${f}`).value = state.cfg[f];
  }
  await refreshAll();
  startPolling();
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* fine without it */ });
}
