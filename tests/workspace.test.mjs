import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_SESSION_KEY, readActiveSession, writeActiveSession } from '../frontend/src/app/workspace.mjs';

const sessionId = '12345678-1234-4234-8234-123456789abc';
const pageId = 'abcdefab-1234-4234-8234-123456789abc';

function storage(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  return values;
}

test('reload restores active session and selected page using metadata only', (t) => {
  const values = storage(t);
  assert.equal(writeActiveSession({ sessionId, pageId }), true);
  assert.deepEqual(readActiveSession(), { sessionId, pageId });
  assert.deepEqual(JSON.parse(values.get(ACTIVE_SESSION_KEY)), { sessionId, pageId });
});

test('new workspace stays new after reload even when the library has sessions', (t) => {
  storage(t);
  assert.deepEqual(readActiveSession(sessionId), { sessionId });
  writeActiveSession(null);
  assert.equal(readActiveSession(sessionId), null);
});

test('invalid storage is ignored and invalid page IDs do not lose the session', (t) => {
  const values = storage(t);
  for (const value of ['{', '[]', 'null', '{"sessionId":"../../etc"}', '42']) {
    values.set(ACTIVE_SESSION_KEY, value);
    assert.equal(readActiveSession(), null);
  }
  values.set(ACTIVE_SESSION_KEY, JSON.stringify({ sessionId, pageId: 'invalid' }));
  assert.deepEqual(readActiveSession(), { sessionId });
});

test('blocked browser storage does not break the workspace', (t) => {
  storage(t);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  assert.equal(readActiveSession(), null);
  assert.equal(writeActiveSession({ sessionId }), false);
});
