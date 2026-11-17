import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTextRepair, textChunks, repairPage } from '../server/ai.mjs';

test('itsme HTTP contract sends OCR only, authenticates and deletes independent conversations', async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'DELETE') return res.end('{}');
    res.end(JSON.stringify({ reply: JSON.stringify({ text: 'Repaired transcription.' }), sessionToken: 'temporary.token' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const repair = createTextRepair({ env: { ITSME_URL: `http://127.0.0.1:${server.address().port}/`, ITSME_API_KEY: 'test-key' } });
  assert.equal(await repair('OCR text.'), 'Repaired transcription.');
  assert.equal(await repair('Another page.'), 'Repaired transcription.');
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [
    ['POST', '/api/chat'], ['DELETE', '/api/session'], ['POST', '/api/chat'], ['DELETE', '/api/session']
  ]);
  assert.equal(calls[0].headers.authorization, 'Bearer test-key');
  assert.equal(calls[0].headers['x-session-token'], undefined);
  assert.equal(calls[0].body.stream, false);
  assert.ok(calls[0].body.message.endsWith(JSON.stringify({ text: 'OCR text.' })));
  assert.equal(calls[1].headers['x-session-token'], 'temporary.token');
});

test('chunking is lossless, bounded and preserves Unicode', () => {
  for (const source of ['word '.repeat(2000), 'a'.repeat(2399) + '😀'.repeat(3000), 'Paragraph.\n\n'.repeat(800)]) {
    const chunks = textChunks(source);
    assert.equal(chunks.join(''), source);
    assert.ok(chunks.every((chunk) => chunk.length <= 2400));
    assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk)));
  }
});

test('malformed, empty, truncated and HTTP errors never replace OCR with partial output', async () => {
  for (const reply of ['Not available', '{"text":""}', '{"text":"summary"}', '{"text":"unfinished']) {
    const repair = createTextRepair({ env: {}, fetchImpl: async (_url, options) => {
      if (options.method === 'DELETE') return {};
      return { ok: true, json: async () => ({ reply, sessionToken: 'token' }) };
    } });
    const page = { text: 'Original text. '.repeat(50) };
    const original = page.text;
    await repairPage(page, repair);
    assert.equal(page.text, original);
    assert.equal(page.aiStatus, 'failed');
  }
  for (const fetchImpl of [async () => new Response('Model unavailable', { status: 503 }), async () => { throw new Error('timeout'); }]) {
    await assert.rejects(createTextRepair({ env: {}, fetchImpl })('text'), { status: 502 });
  }
});

test('AI accepts complete JSON in Markdown but rejects incomplete JSON and surrounding commentary', async () => {
  const logger = { info() {}, warn() {}, error() {} };
  const run = (reply) => createTextRepair({ env: {}, logger, fetchImpl: async () =>
    new Response(JSON.stringify({ reply })) })('hello');
  for (const reply of ['{"text":"hello"}', '```json\n{"text":"hello"}\n```',
    '```json\n{"text":"hello"}', '```\r\n{"text":"hello"}\r\n```',
    '```json\n{"text":"a ``` marker"}\n```']) {
    const expected = reply.includes('marker') ? 'a ``` marker' : 'hello';
    assert.equal(await run(reply), expected);
  }
  for (const reply of ['```json\n{"text":"hello', '```json\n{"text":"hello"',
    'Here is the result: {"text":"hello"}', '```json\n{"text":"hello"}\n```\nDone.',
    '```json\n{"text":""}\n```', null]) {
    await assert.rejects(run(reply), { status: 502 });
  }
});

test('AI logs correlate replies and failures without exposing authentication or session tokens', async () => {
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level,
    (_prefix, line) => logs.push({ level, ...JSON.parse(line) })]));
  const env = { ITSME_API_KEY: 'private-api-key' };
  const repair = createTextRepair({ env, logger, fetchImpl: async (_url, options) => {
    if (options.method === 'DELETE') return new Response('', { status: 503 });
    return new Response(JSON.stringify({ reply: '```json\n{"text":"hello', sessionToken: 'private-session-token' }));
  } });
  await assert.rejects(repair('hello'), { status: 502 });
  assert.equal(logs.find((log) => log.event === 'reply').reply, '```json\n{"text":"hello');
  assert.equal(logs.find((log) => log.event === 'failed').stage, 'reply_json');
  assert.equal(logs.find((log) => log.event === 'session_cleanup').level, 'warn');
  assert.equal(new Set(logs.map((log) => log.repairId)).size, 1);
  assert.ok(logs.every((log) => log.elapsedMs >= 0 && log.chunk === 1));
  assert.doesNotMatch(JSON.stringify(logs), /private-api-key|private-session-token/);

  logs.length = 0;
  await assert.rejects(createTextRepair({ env, logger,
    fetchImpl: async () => new Response('provider failed private-api-key', { status: 503 })
  })('hello'), { status: 502 });
  assert.equal(logs.find((log) => log.event === 'http_error').body, 'provider failed [REDACTED]');
  assert.equal(logs.find((log) => log.event === 'failed').stage, 'http_response');
});

test('chunk assembly preserves paragraphs without inserting breaks into continuous prose', async () => {
  const repair = createTextRepair({ env: {}, fetchImpl: async (_url, options) => {
    const message = JSON.parse(options.body).message;
    const input = JSON.parse(message.slice(message.indexOf('Input: ') + 7));
    return { ok: true, json: async () => ({ reply: JSON.stringify({ text: input.text }) }) };
  } });
  for (const source of ['word '.repeat(1000).trim(), 'a'.repeat(4500), ('A paragraph. '.repeat(100).trim() + '\n\n').repeat(4).trim()]) {
    assert.equal(await repair(source), source);
  }
});

test('comparison logs show copied, whitespace-only, corrected and rejected output', async () => {
  for (const [input, output, unchanged, whitespaceOnly] of [
    ['El mundo.', 'El mundo.', true, false],
    ['El\nmundo.', 'El mundo.', false, true],
    ['Untexo sobre elmundo.', 'Un texto sobre el mundo.', false, false],
    ['Original text. '.repeat(50), 'Summary', false, false]
  ]) {
    const logs = [];
    const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) =>
      [level, (_prefix, line) => logs.push(JSON.parse(line))]));
    const repair = createTextRepair({ env: {}, logger, fetchImpl: async () =>
      new Response(JSON.stringify({ reply: JSON.stringify({ text: output }) })) });
    if (output === 'Summary') await assert.rejects(repair(input), { status: 502 });
    else assert.equal(await repair(input), output);
    const comparison = logs.find((entry) => entry.event === 'comparison');
    assert.equal(comparison.input, input);
    assert.equal(comparison.output, output);
    assert.equal(comparison.unchanged, unchanged);
    assert.equal(comparison.whitespaceOnly, whitespaceOnly);
    assert.equal(comparison.lengthRatio, Number((output.length / input.length).toFixed(3)));
    assert.equal(comparison.repairId, logs.find((entry) => entry.event === 'request').repairId);
  }
});

test('a later failed chunk discards earlier repairs; retries use raw text and protect manual edits', async () => {
  let calls = 0;
  const repair = createTextRepair({ env: {}, fetchImpl: async (_url, options) => {
    if (options.method === 'DELETE') return {};
    if (++calls === 2) throw new Error('offline');
    return { ok: true, json: async () => ({ reply: JSON.stringify({ text: 'Repaired '.repeat(200) }), sessionToken: 'token' }) };
  } });
  const raw = 'Original word. '.repeat(300);
  const page = { text: raw };
  await repairPage(page, repair);
  assert.equal(page.text, raw);
  assert.equal(page.aiStatus, 'failed');
  await repairPage(page, async (text) => { assert.equal(text, raw); return 'Repaired'; });
  assert.equal(page.text, 'Repaired');
  assert.equal(page.aiStatus, 'repaired');
  assert.equal(page.aiError, undefined);
  page.text = 'Manual edit';
  page.textEdited = true;
  await repairPage(page, () => assert.fail('must protect edits'));
  assert.equal(page.text, 'Manual edit');
});
