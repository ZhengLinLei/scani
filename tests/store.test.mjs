import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, safeName, asText, validId, captureIndex } from '../server/store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'scani-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  await store.init();
  return store;
}
test('creates, persists, reopens and deletes a session', async (t) => {
  const store = await fixture(t);
  const session = await store.create({ name: 'My book', format: 'txt' });
  assert.equal(validId(session.id), true);
  assert.deepEqual(await store.get(session.id), session);
  session.pages.push({ id: 'page', text: 'A real page.' });
  await store.save(session);
  const restarted = new Store(store.root);
  assert.equal((await restarted.get(session.id)).pages[0].text, 'A real page.');
  await store.delete(session.id);
  await assert.rejects(store.get(session.id), { status: 404 });
});
test('rejects invalid formats and path traversal', async (t) => {
  const store = await fixture(t);
  await assert.rejects(store.create({ name: 'book', format: 'html' }), { status: 400 });
  for (const id of ['../secret', '', 'session.json', '%2e%2e', null]) {
    assert.throws(() => store.folder(id), { status: 404 });
  }
});
test('concurrent mutation cannot overwrite a page; lock releases after failure', async (t) => {
  const store = await fixture(t);
  const session = await store.create({ format: 'pdf' });
  let release;
  const held = store.exclusive(
    session.id,
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  // Wait for the first callback to acquire and read the session.
  while (!release) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await assert.rejects(
    store.exclusive(session.id, () => {}),
    { status: 409 }
  );
  release();
  await held;
  await assert.rejects(
    store.exclusive(session.id, () => {
      throw new Error('disk failure');
    }),
    /disk failure/
  );
  assert.equal(await store.exclusive(session.id, () => 42), 42);
});
test('TXT preserves Unicode and separates pages in scan order', () => {
  assert.equal(
    asText({ pages: [{ text: '  Capítulo uno — café.\n' }, { text: '第二頁' }] }),
    'Capítulo uno — café.\n\n\f\n\n第二頁\n'
  );
  assert.equal(safeName('../../a\r\n"book"'), 'abook');
  assert.equal(safeName(''), 'Untitled scan');
});

test('failed metadata write preserves the last saved session and releases its lock', async (t) => {
  const store = await fixture(t);
  const session = await store.create({ name: 'Original', format: 'txt' });
  const temporaryFile = join(store.folder(session.id), 'session.json.tmp');
  await mkdir(temporaryFile);
  await assert.rejects(
    store.exclusive(session.id, async (current) => {
      current.name = 'Should not persist';
      await store.save(current);
    })
  );
  assert.equal((await store.get(session.id)).name, 'Original');
  await rm(temporaryFile, { recursive: true });
  await store.exclusive(session.id, async (current) => {
    current.name = 'Recovered';
    await store.save(current);
  });
  assert.equal((await store.get(session.id)).name, 'Recovered');
});

test('rescanning a specific page keeps its slot and supports finished sessions', () => {
  for (const finished of [false, true]) {
    const pages = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
    const session = { finished, pages };
    assert.equal(captureIndex(session, 'second'), 1);
    assert.deepEqual(session.pages, [{ id: 'first' }, { id: 'second' }, { id: 'third' }]);
    assert.equal(session.finished, finished);
    assert.throws(() => captureIndex(session, 'missing'), { status: 404 });
    assert.throws(() => captureIndex(session, ['second']), { status: 404 });
  }
  assert.equal(captureIndex({ finished: false, pages: [] }), -1);
  assert.throws(() => captureIndex({ finished: true, pages: [] }), { status: 409 });
});

test('a full session can replace a page but cannot append another', () => {
  const session = { finished: false, pages: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) };
  assert.equal(captureIndex(session, '99'), 99);
  assert.throws(() => captureIndex(session), { status: 409 });
});
