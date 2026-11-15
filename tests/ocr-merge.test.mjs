import test from 'node:test';
import assert from 'node:assert/strict';
import { initialRecognition, mergeRecognition, publicSession } from '../server/ocr-merge.mjs';
import { asText } from '../server/store.mjs';

function reading(text, confidences = [], confidence = 85) {
  return { text, confidence, words: text.match(/\S+/gu)?.map((text, i) => ({ text, confidence: confidences[i] ?? confidence })) || [] };
}
function page(result) {
  return { id: 'page', createdAt: 'original-date', ...result, captureCount: 1, recognition: initialRecognition(result, 'page') };
}

test('combines the best words from different captures instead of replacing the whole reading', () => {
  const first = page(reading('El gato come pescad0.\n', [95, 96, 94, 35]));
  const second = reading('El gat0 come pescado.\n', [95, 30, 95, 97]);
  const merged = mergeRecognition(first, second, 'second');
  assert.equal(merged.text, 'El gato come pescado.\n');
  assert.equal(merged.captureCount, 2);
  assert.equal(merged.id, first.id);
  assert.equal(merged.createdAt, first.createdAt);
  assert.equal(first.text, 'El gato come pescad0.\n');
  assert.equal(first.recognition.ids.length, 1);
});

test('repeated independent readings can resolve a conflicting word by consensus', () => {
  let merged = page(reading('The cat sat here.', [95, 95, 95, 95]));
  merged = mergeRecognition(merged, reading('The dog sat here.'), 'second');
  assert.equal(merged.text, 'The cat sat here.');
  merged = mergeRecognition(merged, reading('The dog sat here.'), 'third');
  assert.equal(merged.text, 'The dog sat here.');
  assert.equal(merged.captureCount, 3);
});

test('aligns missing and extra words without joining them or duplicating a page', () => {
  let merged = page(reading('The quick fox jumps over the dog.', [], 70));
  merged = mergeRecognition(merged, reading('The quick brown fox jumps over the dog.', [], 96), 'second');
  assert.equal(merged.text, 'The quick brown fox jumps over the dog.');
  merged = mergeRecognition(merged, reading('The quick brown fox jumps over the dog.', [], 96), 'third');
  assert.equal(merged.text, 'The quick brown fox jumps over the dog.');
  assert.equal(asText({ pages: [merged] }), merged.text + '\n');
  let end = page(reading('A short full page', [], 60));
  end = mergeRecognition(end, reading('A short full page ends', [], 96), 'second');
  assert.equal(end.text, 'A short full page ends');
});

test('omissions can be confirmed, and later corrected without losing alignment', () => {
  let merged = page(reading('The quick stray brown fox jumps.', [], 60));
  merged = mergeRecognition(merged, reading('The quick brown fox jumps.', [], 96), 'second');
  assert.equal(merged.text, 'The quick brown fox jumps.');
  merged = mergeRecognition(merged, reading('The quick brown fox jumps.', [], 96), 'third');
  assert.equal(merged.text, 'The quick brown fox jumps.');
});

test('keeps paragraphs, Unicode and OCR confidence without inflating it for duplicates', () => {
  const original = page(reading('Capítulo uno: café.\n\n第二頁 aquí.\n', [], 92));
  const merged = mergeRecognition(original, reading(original.text, [], 92), 'second');
  assert.equal(merged.text, original.text);
  assert.equal(merged.confidence, 92);
  assert.strictEqual(mergeRecognition(merged, reading('ignored'), 'second'), merged);
  assert.equal(merged.captureCount, 2);
});

test('rejects different pages, blank captures and saved edits without changing prior readings', () => {
  const original = page(reading('An existing full page with readable text.'));
  for (const result of [reading('Totally unrelated content belongs elsewhere.'), reading('')]) {
    assert.throws(() => mergeRecognition(original, result, 'next'), { status: 422 });
  }
  assert.throws(() => mergeRecognition({ ...original, textEdited: true }, reading(original.text), 'next'), { status: 409 });
  assert.equal(original.captureCount, 1);
  assert.equal(original.recognition.ids.length, 1);
});

test('supports legacy pages, persistence across restarts and a bounded capture count', () => {
  let merged = { id: 'legacy', text: 'A full page of text.', confidence: 90 };
  for (let i = 2; i <= 10; i++) {
    merged = mergeRecognition(JSON.parse(JSON.stringify(merged)), reading(merged.text), `capture-${i}`);
  }
  assert.equal(merged.captureCount, 10);
  assert.throws(() => mergeRecognition(merged, reading(merged.text), 'overflow'), { status: 409 });
  assert.strictEqual(mergeRecognition(merged, reading(merged.text), 'capture-10'), merged);
  const publicData = publicSession({ finished: true, pages: [merged] });
  assert.equal(publicData.finished, true);
  assert.equal(publicData.pages.length, 1);
  assert.equal(publicData.pages[0].captureCount, 10);
  assert.equal('recognition' in publicData.pages[0], false);
});

test('aligns long pages within the bounded band and rejects excessive length differences', () => {
  const text = Array.from({ length: 2200 }, (_, i) => `word${i}`).join(' ');
  const original = page(reading(text));
  const merged = mergeRecognition(original, reading(text.replace('word1100', 'corrected'), [], 96), 'next');
  assert.ok(merged.text.includes('corrected'));
  assert.throws(() => mergeRecognition(original, reading(text + ' extra'.repeat(600)), 'too-different'), { status: 422 });
});
