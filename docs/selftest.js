// One runnable check over the logic that carries real risk. No framework.
// Run headless:  node docs/selftest.js      Or open docs/selftest.html.
import { parseDraft } from './llm.js';
import {
  canApprove, captionProblem, cropBox, imageName, makeSerializer, matchRun,
  MAX_CAPTION, NEEDS_CAPTION, opState, ratioOk, slug,
} from './logic.js';

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  if (!cond) console.error('FAIL: ' + name);
}

// --- filenames: the rule cli queue enforces ---
check('slug strips punctuation', slug('AI in test automation!') === 'ai-in-test-automation');
check('slug caps at 40 chars', slug('x'.repeat(80)).length <= 40);
check('slug never returns empty', slug('!!!') === 'post');
check('name is a lowercase .jpg',
  /^[a-z0-9-]+\.jpg$/.test(imageName('Hello There', '2026-10-05')));
check('name avoids a collision',
  imageName('a', '2026-10-05', ['2026-10-05-a.jpg']) === '2026-10-05-a-2.jpg');
check('name avoids two collisions',
  imageName('a', '2026-10-05', ['2026-10-05-a.jpg', '2026-10-05-a-2.jpg'])
    === '2026-10-05-a-3.jpg');

// --- aspect ratio: the likeliest upload failure ---
check('1080x1350 (the renderer output) is fine', ratioOk(1080, 1350));
check('square is fine', ratioOk(1000, 1000));
check('a 3:4 phone photo is REJECTED', !ratioOk(1200, 1600));
check('a tall panorama is rejected', !ratioOk(500, 2000));
check('a wide panorama is rejected', !ratioOk(3000, 500));
const box = cropBox(1200, 1600, 4 / 5);
check('crop keeps full width when too tall', box.w === 1200);
check('crop centres vertically', box.y === Math.round((1600 - box.h) / 2));
check('crop hits the target ratio', Math.abs(box.w / box.h - 0.8) < 0.01);
const wide = cropBox(2000, 1000, 1);
check('crop trims width when too wide', wide.w === 1000 && wide.h === 1000);

// --- captions ---
check('empty caption refused', captionProblem('  ') !== null);
check('the sentinel is refused', captionProblem(NEEDS_CAPTION) !== null);
check('a normal caption passes', captionProblem('hello') === null);
check('2200 chars passes', captionProblem('x'.repeat(MAX_CAPTION)) === null);
check('2201 chars refused', captionProblem('x'.repeat(MAX_CAPTION + 1)) !== null);
check('cannot approve without a caption',
  !canApprove({ status: 'pending', caption: NEEDS_CAPTION }));
check('cannot approve a published post',
  !canApprove({ status: 'published', caption: 'ok' }));
check('can approve a captioned pending post',
  canApprove({ status: 'pending', caption: 'ok' }));

// --- the two-gate clear ---
const op = { action: 'approved', dispatchedAt: 1000 };
const ok = { status: 'completed', conclusion: 'success' };
check('no run yet is pending, not failed',
  opState(op, null, null, 2000) === 'pending');
check('running is pending',
  opState(op, { status: 'in_progress' }, null, 2000) === 'pending');
check('green run + queue agrees = done',
  opState(op, ok, { status: 'approved' }, 2000) === 'done');
check('green run but queue did NOT change = unknown, not done',
  opState(op, ok, { status: 'pending' }, 2000) === 'unknown');
check('red run = failed',
  opState(op, { status: 'completed', conclusion: 'failure' }, null, 2000) === 'failed');
check('cancelled is failed, never a silent success',
  opState(op, { status: 'completed', conclusion: 'cancelled' }, null, 2000) === 'failed');
check('a stuck op gives up after 10 minutes',
  opState(op, null, null, 1000 + 11 * 60 * 1000) === 'unknown');
check('approve-and-post accepts having already published',
  opState({ action: 'approve-and-post', dispatchedAt: 1000 }, ok,
    { status: 'published' }, 2000) === 'done');

// --- run matching ---
const runs = [
  { id: 1, created_at: '2026-10-05T12:00:00Z' },
  { id: 2, created_at: '2026-10-05T12:05:00Z' },
];
check('matches the newest run after the watermark',
  matchRun(runs, Date.parse('2026-10-05T12:01:00Z')).id === 2);
check('ignores runs from before the dispatch',
  matchRun(runs, Date.parse('2026-10-05T12:10:00Z')) === null);
check('tolerates a couple of seconds of clock skew',
  matchRun(runs, Date.parse('2026-10-05T12:05:01Z')).id === 2);

// --- LLM draft parsing: models wrap JSON in fences more often than not ---
const good = '{"headline":"H","body":"a\\nb","caption":"C"}';
check('parses plain JSON', parseDraft(good).headline === 'H');
check('strips a markdown fence', parseDraft('```json\n' + good + '\n```').caption === 'C');
check('ignores prose around the object',
  parseDraft('Sure!\n' + good + '\nHope that helps.').headline === 'H');
check('keeps newlines in the body', parseDraft(good).body === 'a\nb');
check('body defaults to empty',
  parseDraft('{"headline":"H","caption":"C"}').body === '');
let threw = false;
try { parseDraft('no json here'); } catch { threw = true; }
check('refuses a reply with no JSON', threw);
threw = false;
try { parseDraft('{"headline":"H"}'); } catch { threw = true; }
check('refuses a draft with no caption', threw);

// --- the serializer: the one genuinely new hazard ---
const order = [];
let inFlight = 0;
let overlapped = false;
const s = makeSerializer(async (job) => {
  inFlight += 1;
  if (inFlight > 1) overlapped = true;
  await new Promise((r) => setTimeout(r, 5));
  order.push(job);
  inFlight -= 1;
  return job;
});

Promise.all([s.submit('a'), s.submit('b'), s.submit('c')]).then(() => {
  check('never two dispatches in flight at once', !overlapped);
  check('order is preserved', order.join('') === 'abc');
  report();
});

function report() {
  const failed = results.filter((r) => !r.ok);
  const line = `${results.length - failed.length}/${results.length} passed`;
  if (typeof document !== 'undefined') {
    document.body.textContent = failed.length
      ? `${line} — FAILED: ${failed.map((f) => f.name).join('; ')}` : line;
    document.body.className = failed.length ? 'bad' : 'good';
  } else {
    console.log(line);
    if (failed.length) process.exit(1);
  }
}
