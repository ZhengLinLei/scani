import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createCaptureHandler } from '../server/capture.mjs';

async function fixture(t, repairText) {
  const root = await mkdtemp(join(tmpdir(), 'scani-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.init();
  const session = await store.create({ name: 'Merge', format: 'txt' });
  const state = { calls: 0, result: { text: 'The full page has readable text.\n', confidence: 92 } };
  const handler = createCaptureHandler({
    store, repairText, normalizeImage: async (image) => image,
    ocr: { recognize: async () => { state.calls++; return state.result; } },
    progress: { broadcast() {} }
  });
  async function capture(query, image = Buffer.alloc(150, 1)) {
    let body;
    const response = { status: (code) => { assert.equal(code, 201); return response; }, json: (data) => { body = data; } };
    await handler({ params: { id: session.id }, query, body: image }, response);
    return body;
  }
  return { store, session, capture, state };
}

test('capture endpoint merges a finished page in place, preserves its image and survives reopening', async (t) => {
  const { store, session, capture, state } = await fixture(t);
  const firstId = randomUUID(), secondId = randomUUID();
  await capture({ captureId: firstId });
  const initial = await store.get(session.id);
  initial.finished = true;
  await store.save(initial);
  const merged = await capture({ captureId: secondId, merge: firstId }, Buffer.alloc(150, 2));
  assert.equal(merged.pages.length, 1);
  assert.equal(merged.pages[0].id, firstId);
  assert.equal(merged.pages[0].captureCount, 2);
  assert.equal(merged.finished, true);
  assert.equal('recognition' in merged.pages[0], false);
  assert.deepEqual(await readFile(store.imagePath(session.id, firstId)), Buffer.alloc(150, 1));
  const reopened = await new Store(store.root).get(session.id);
  assert.deepEqual(reopened.pages[0].recognition.ids, [firstId, secondId]);
  assert.equal((await readdir(store.folder(session.id))).filter((name) => name.endsWith('.jpg')).length, 1);
  // Simulate a lost HTTP response: retry with the same capture ID.
  const retried = await capture({ captureId: secondId, merge: firstId });
  assert.deepEqual(retried, merged);
  assert.equal(state.calls, 2);
});

test('capture endpoint validates merge parameters and missing pages before OCR', async (t) => {
  const { capture, state } = await fixture(t);
  for (const query of [
    { merge: '../page', captureId: randomUUID() },
    { merge: randomUUID() },
    { merge: randomUUID(), replace: randomUUID(), captureId: randomUUID() },
    { merge: [randomUUID()], captureId: randomUUID() }
  ]) await assert.rejects(capture(query), { status: 400 });
  await assert.rejects(capture({ merge: randomUUID(), captureId: randomUUID() }), { status: 404 });
  assert.equal(state.calls, 0);
});

test('failed merge leaves the saved text and image intact and can be retried', async (t) => {
  const { store, session, capture, state } = await fixture(t);
  const id = randomUUID(), captureId = randomUUID();
  await capture({ captureId: id });
  const before = await store.get(session.id);
  state.result = { text: 'Completely different unrelated chapter somewhere else.', confidence: 92 };
  await assert.rejects(capture({ merge: id, captureId }), { status: 422 });
  assert.deepEqual(await store.get(session.id), before);
  state.result = { text: before.pages[0].text, confidence: 96 };
  const merged = await capture({ merge: id, captureId });
  assert.equal(merged.pages[0].captureCount, 2);
});

test('metadata write failure does not commit merge evidence or consume the capture ID', async (t) => {
  const { store, session, capture } = await fixture(t);
  const id = randomUUID(), captureId = randomUUID();
  await capture({ captureId: id });
  const before = await store.get(session.id);
  const temporaryFile = join(store.folder(session.id), 'session.json.tmp');
  await mkdir(temporaryFile);
  await assert.rejects(capture({ merge: id, captureId }));
  assert.deepEqual(await store.get(session.id), before);
  await rm(temporaryFile, { recursive: true });
  const merged = await capture({ merge: id, captureId });
  assert.equal(merged.pages[0].captureCount, 2);
});

test('saved manual edits and the capture limit are checked before OCR; rescan resets evidence', async (t) => {
  const { store, session, capture, state } = await fixture(t);
  const id = randomUUID();
  await capture({ captureId: id });
  let saved = await store.get(session.id);
  saved.pages[0].textEdited = true;
  await store.save(saved);
  await assert.rejects(capture({ merge: id, captureId: randomUUID() }), { status: 409 });
  assert.equal(state.calls, 1);
  saved.pages[0].textEdited = false;
  await store.save(saved);
  for (let i = 2; i <= 10; i++) await capture({ merge: id, captureId: randomUUID() });
  await assert.rejects(capture({ merge: id, captureId: randomUUID() }), { status: 409 });
  assert.equal(state.calls, 10);
  const replacement = randomUUID();
  const rescanned = await capture({ replace: id, captureId: replacement });
  assert.equal(rescanned.pages.length, 1);
  assert.equal(rescanned.pages[0].captureCount, 1);
  assert.equal(rescanned.pages[0].id, replacement);
  saved = await store.get(session.id);
  assert.deepEqual(saved.pages[0].recognition.ids, [replacement]);
  await assert.rejects(readFile(store.imagePath(session.id, id)), { code: 'ENOENT' });
});


test('AI runs after OCR merge, keeps evidence private and does not poison later captures', async (t) => {
  const inputs = [];
  const { store, session, capture, state } = await fixture(t, async (text) => {
    inputs.push(text);
    return 'Repaired wording differs completely from the photograph.';
  });
  const first = randomUUID();
  let result = await capture({ captureId: first, ai: 'true' });
  assert.equal(result.pages[0].aiStatus, 'repaired');
  assert.equal('rawText' in result.pages[0], false);
  const saved = await store.get(session.id);
  assert.equal(saved.pages[0].rawText, state.result.text);
  assert.equal(saved.pages[0].textEdited, undefined);
  const second = randomUUID();
  result = await capture({ captureId: second, merge: first, ai: 'true' });
  assert.equal(result.pages[0].captureCount, 2);
  assert.deepEqual(inputs, [state.result.text, state.result.text]);
  await capture({ captureId: second, merge: first, ai: 'true' });
  assert.equal(inputs.length, 2, 'lost response retry must not repeat AI');
  result = await capture({ captureId: randomUUID(), merge: first, ai: 'false' });
  assert.equal(result.pages[0].text, state.result.text);
  assert.equal(result.pages[0].aiStatus, undefined);
  assert.equal(inputs.length, 2);
});

test('AI failure still commits OCR and capture id; blank and disabled captures do not call AI', async (t) => {
  let calls = 0;
  const { capture, state } = await fixture(t, async () => { calls++; throw new Error('offline'); });
  const id = randomUUID();
  const result = await capture({ captureId: id, ai: 'true' });
  assert.equal(result.pages[0].text, state.result.text);
  assert.equal(result.pages[0].aiStatus, 'failed');
  assert.match(result.pages[0].aiError, /OCR text is saved/);
  await capture({ captureId: id, ai: 'true' });
  assert.equal(calls, 1);
  await capture({ captureId: randomUUID() });
  state.result = { text: '', confidence: 100, blank: true };
  await capture({ captureId: randomUUID(), ai: 'true' });
  assert.equal(calls, 1);
  await assert.rejects(capture({ ai: ['true'] }), { status: 400 });
});
