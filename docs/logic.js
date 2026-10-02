// The parts with actual rules in them, kept pure so selftest.html can check
// them without a browser, a token or a network.

export const MAX_CAPTION = 2200;        // Instagram's limit
export const MIN_RATIO = 4 / 5;         // 0.8  — portrait floor
export const MAX_RATIO = 1.91;          // landscape ceiling
export const NEEDS_CAPTION = '(no caption yet — add one before approving)';

export const STATUS_HELP = {
  pending: 'Waiting for you. Never published.',
  approved: 'Approved. Publishes when its time passes.',
  publishing: 'A run died mid-publish. NOT retried — check the account, then record what happened.',
  published: 'Posted.',
  failed: 'The publish call errored. Never retried.',
  rejected: 'Dropped. Never publishes; its slot is freed.',
};

export const EDITABLE = ['pending', 'approved'];

// --- filenames -----------------------------------------------------------
// `cli queue` refuses anything that is not a bare, lowercase .jpg, because
// `mirror` globs posts/media/*.jpg and that glob is case-sensitive on the
// Linux runners. Deriving the name here means the user never types one, so the
// rule cannot be broken from this app.

export function slug(text) {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return cleaned.slice(0, 40).replace(/^-|-$/g, '') || 'post';
}

export function imageName(caption, date, taken = []) {
  const stem = `${date}-${slug(caption)}`;
  let name = `${stem}.jpg`;
  let n = 2;
  while (taken.includes(name)) {
    name = `${stem}-${n}.jpg`;
    n += 1;
  }
  return name;
}

// --- uploads -------------------------------------------------------------

export function ratioOk(width, height) {
  const r = width / height;
  return r >= MIN_RATIO - 1e-9 && r <= MAX_RATIO + 1e-9;
}

/** Centre-crop box for a target ratio. Mirrors src/render.py's _cover: crop to
 *  the aspect, never squash. A 3:4 phone photo is 0.75, BELOW the 0.8 floor,
 *  so the likeliest upload needs this or Instagram rejects it outright. */
export function cropBox(width, height, ratio) {
  if (width / height > ratio) {
    const w = Math.round(height * ratio);
    return { x: Math.round((width - w) / 2), y: 0, w, h: height };
  }
  const h = Math.round(width / ratio);
  return { x: 0, y: Math.round((height - h) / 2), w: width, h };
}

// --- captions ------------------------------------------------------------

export function captionProblem(caption) {
  const text = (caption || '').trim();
  if (!text) return 'A caption is required.';
  if (text === NEEDS_CAPTION) return 'Write a real caption first.';
  if (caption.length > MAX_CAPTION) {
    return `${caption.length} characters — Instagram allows ${MAX_CAPTION}.`;
  }
  return null;
}

export function canApprove(post) {
  return post.status === 'pending' && !captionProblem(post.caption);
}

// --- the pending-op state machine ----------------------------------------
// A dispatch returns 204 with no run id, and the queue takes ~30s to catch up.
// An op clears only when BOTH gates pass: the run succeeded, AND a refetched
// queue shows the post in the expected state.
//
// Both are required because a green run is not proof the change reached the
// repo — `publish --push` pushes on its own, and if THAT push fails the commit
// sits unpushed while the workflow's own check sees a clean tree. The client
// must not be more trusting than the workflow.

export const EXPECTED = {
  approved: (p) => p.status === 'approved',
  'approve-and-post': (p) => ['approved', 'publishing', 'published'].includes(p.status),
  rejected: (p) => p.status === 'rejected',
  caption: (p, op) => p.caption === op.caption,
  reschedule: (p) => true,
  repair: (p, op) => p.status === op.toStatus,
};

/** Returns the op's next state: 'pending' | 'done' | 'failed' | 'unknown'. */
export function opState(op, run, post, now = Date.now()) {
  if (run && run.status === 'completed') {
    if (run.conclusion === 'cancelled') return 'failed';
    if (run.conclusion !== 'success') return 'failed';
    const check = EXPECTED[op.action];
    // Second gate. A post that vanished cannot be confirmed either way.
    if (!post) return op.action === 'rejected' ? 'unknown' : 'unknown';
    return check && check(post, op) ? 'done' : 'unknown';
  }
  // A run not yet visible is pending, never a failure — it takes GitHub a few
  // seconds to create it after the 204.
  if (now - op.dispatchedAt > 10 * 60 * 1000) return 'unknown';
  return 'pending';
}

/** Newest dispatch-triggered run created at or after the watermark. */
export function matchRun(runs, dispatchedAt) {
  const candidates = (runs || [])
    .filter((r) => new Date(r.created_at).getTime() >= dispatchedAt - 2000)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return candidates[0] || null;
}

// --- the dispatch serializer ---------------------------------------------
// Every repo-writing workflow shares one concurrency group, and GitHub keeps
// only the NEWEST pending run per group — it cancels earlier pending ones. So
// firing four approvals in ten seconds silently loses two. Labelling issues by
// hand was slow enough that this rarely bit; a tap-tap-tap UI makes it normal.
// One in flight at a time.

export function makeSerializer(runOne) {
  const queue = [];
  let running = false;

  async function pump() {
    if (running || !queue.length) return;
    running = true;
    const { job, resolve, reject } = queue.shift();
    try { resolve(await runOne(job)); } catch (e) { reject(e); }
    running = false;
    pump();
  }

  return {
    submit(job) {
      return new Promise((resolve, reject) => {
        queue.push({ job, resolve, reject });
        pump();
      });
    },
    get depth() { return queue.length + (running ? 1 : 0); },
  };
}

// --- display -------------------------------------------------------------

export function formatSlot(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

export function isDue(post, now = Date.now()) {
  return new Date(post.publish_at).getTime() <= now;
}
