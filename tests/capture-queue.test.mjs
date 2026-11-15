import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureQueue } from '../frontend/src/app/capture-queue.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('accepts the next photo before OCR finishes and saves photos in capture order', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const started = [], saved = [], snapshots = [];
  const queue = new CaptureQueue(async (photo) => {
    started.push(photo);
    await gates[photo - 1].promise;
    saved.push(photo);
  }, (jobs) => snapshots.push(jobs));
  queue.add(1);
  queue.add(2);
  queue.add(3);
  assert.deepEqual(started, [1]);
  assert.deepEqual(queue.snapshot().map((job) => job.status), ['processing', 'queued', 'queued']);
  for (let index = 0; index < gates.length; index++) {
    gates[index].resolve();
    await tick();
    assert.deepEqual(saved, [1, 2, 3].slice(0, index + 1));
  }
  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(queue.snapshot(), []);
  assert.equal(snapshots[0][0].status, 'queued', 'published snapshots must not mutate later');
});

test('failed recognition retains the exact photo and pauses later photos until retried', async () => {
  const first = { blob: new Blob(['first']), captureId: 'stable-id', replaceId: 'original-page' };
  const second = { blob: new Blob(['second']) };
  const started = [];
  let fail = true;
  const queue = new CaptureQueue(async (photo) => {
    started.push(photo);
    if (fail) throw new Error('OCR unavailable');
  });
  queue.add(first);
  queue.add(second);
  await tick();
  assert.deepEqual(started, [first]);
  assert.equal(queue.snapshot()[0].status, 'failed');
  assert.equal(queue.snapshot()[0].error, 'OCR unavailable');
  // Capturing more pages does not bypass the failed photo.
  const third = { blob: new Blob(['third']) };
  queue.add(third);
  await tick();
  assert.equal(started.length, 1);
  fail = false;
  queue.retry();
  queue.retry();
  await tick();
  assert.deepEqual(started, [first, first, second, third]);
  assert.equal(started[0], started[1], 'retry must reuse the photo and its capture ID');
  assert.deepEqual(queue.snapshot(), []);
});

test('discarding a failed photo resumes the remaining queue without losing subsequent photos', async () => {
  const saved = [];
  const queue = new CaptureQueue(async (photo) => {
    if (photo === 'unreadable') throw new Error('No readable text');
    saved.push(photo);
  });
  queue.add('unreadable');
  queue.add('next');
  await tick();
  queue.discardFailed();
  await tick();
  assert.deepEqual(saved, ['next']);
  assert.deepEqual(queue.snapshot(), []);
});

test('retry and discard cannot start a second request while OCR is still running', async () => {
  const gate = deferred();
  let calls = 0;
  const queue = new CaptureQueue(async () => { calls++; await gate.promise; });
  queue.add(new Blob(['photo']));
  queue.retry();
  queue.discardFailed();
  assert.equal(calls, 1);
  assert.equal(queue.snapshot().length, 1);
  gate.resolve();
  await tick();
  assert.deepEqual(queue.snapshot(), []);
});
