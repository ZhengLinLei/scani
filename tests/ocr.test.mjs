import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcr } from '../server/ocr.mjs';
import sharp from 'sharp';
import { prepareOcrImage } from '../server/ocr-image.mjs';

test('OCR copy respects the resolution limit without changing the saved image', async () => {
  const original = await sharp({
    create: { width: 2200, height: 3000, channels: 3, background: '#f4e4cd' }
  }).jpeg().toBuffer();
  const snapshot = Buffer.from(original);
  const input = await prepareOcrImage(original);
  const metadata = await sharp(input).metadata();
  assert.ok(metadata.width <= Number(process.env.OCR_MAX_WIDTH || 2200));
  assert.ok(Math.abs(metadata.width / metadata.height - 2200 / 3000) < 0.001);
  const { data } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // Sharp may encode grayscale PNGs as RGB, but all color components must match.
  assert.equal(data[0], data[1]);
  assert.equal(data[1], data[2]);
  assert.deepEqual(original, snapshot);
});

test('OCR preprocessing never enlarges small scans', async () => {
  const original = await sharp({
    create: { width: 600, height: 800, channels: 3, background: 'white' }
  }).jpeg().toBuffer();
  const metadata = await sharp(await prepareOcrImage(original)).metadata();
  assert.equal(metadata.width, 600);
  assert.equal(metadata.height, 800);
});

test('warmup is shared by concurrent sessions and honors shutdown', async () => {
  const ocr = createOcr('/unused');
  const first = ocr.warmup();
  assert.equal(ocr.warmup(), first);
  const result = assert.rejects(first, /shutting down/);
  await ocr.close();
  await result;
  await assert.rejects(ocr.warmup(), /shutting down/);
});

test('bounds the OCR queue and cancels queued jobs during shutdown', async () => {
  const ocr = createOcr('/unused');
  const queuedJobs = Array.from({ length: 4 }, () => ocr.recognize(Buffer.alloc(0)));
  const results = Promise.allSettled(queuedJobs);
  const overflow = ocr.recognize(Buffer.alloc(0));

  // Stop before the queued microtasks start; no engine or language download is needed.
  const closing = ocr.close();
  await assert.rejects(overflow, { status: 503 });
  await closing;

  for (const result of await results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /shutting down/);
  }
  await assert.rejects(ocr.recognize(Buffer.alloc(0)), /shutting down/);
  await ocr.close();
});

test('high accuracy retains small-print detail while faster mode reduces the OCR copy', async () => {
  const previous = process.env.OCR_MAX_WIDTH;
  delete process.env.OCR_MAX_WIDTH;
  try {
    const image = await sharp({ create: { width: 2200, height: 3000, channels: 3, background: 'white' } }).png().toBuffer();
    const high = await sharp(await prepareOcrImage(image, 'high')).metadata();
    const fast = await sharp(await prepareOcrImage(image, 'fast')).metadata();
    assert.equal(high.width, 2200);
    assert.equal(fast.width, 1600);
  } finally {
    if (previous === undefined) delete process.env.OCR_MAX_WIDTH;
    else process.env.OCR_MAX_WIDTH = previous;
  }
});

test('blank detection ignores plain paper, camera grain, smooth shadows and page borders', async () => {
  const { isBlankPage } = await import('../server/ocr-image.mjs');
  const width = 768, height = 1024;
  const raw = Buffer.alloc(width * height);
  let seed = 97;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raw[y * width + x] = 205 + Math.round(x / width * 30) + (seed % 15) - 7;
    }
  }
  const noisy = await sharp(raw, { raw: { width, height, channels: 1 } }).jpeg().toBuffer();
  const paper = await sharp({ create: { width, height, channels: 3, background: '#f7f3e8' } }).png().toBuffer();
  const bordered = Buffer.from(`<svg width="768" height="1024"><rect width="768" height="1024" fill="#333"/><rect x="14" y="14" width="740" height="996" fill="#eee"/></svg>`);
  for (const image of [paper, noisy, bordered]) assert.equal(await isBlankPage(image), true);
});

test('blank detection keeps real text, a single sparse word, faint print and dark frames for OCR', async () => {
  const { isBlankPage } = await import('../server/ocr-image.mjs');
  for (const [fill, text, size] of [['#111', 'Hello world 123', 26], ['#111', 'a', 18], ['#d0d0d0', 'Faint but real text', 28]]) {
    const image = Buffer.from(`<svg width="768" height="1024"><rect width="768" height="1024" fill="#eee"/><text x="80" y="200" font-family="sans-serif" font-size="${size}" fill="${fill}">${text}</text></svg>`);
    assert.equal(await isBlankPage(image), false, text);
  }
  const dark = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#222' } }).png().toBuffer();
  assert.equal(await isBlankPage(dark), false);
});

test('recognition accepts known blank pages but rejects empty and uncertain nonblank OCR', async () => {
  const { validateRecognition } = await import('../server/ocr-quality.mjs');
  const previous = process.env.OCR_MIN_CONFIDENCE;
  process.env.OCR_MIN_CONFIDENCE = '45';
  try {
    assert.doesNotThrow(() => validateRecognition({ blank: true, text: '', confidence: 0 }));
    assert.doesNotThrow(() => validateRecognition({ text: 'Readable words', confidence: 92 }));
    for (const result of [
      { text: '', confidence: 0 },
      { text: '  ', confidence: 90 },
      { text: 'random letters', confidence: 21 },
      { text: 'random letters', confidence: NaN },
      { blank: true, text: 'random letters', confidence: 10 }
    ]) assert.throws(() => validateRecognition(result), { status: 422 });
    process.env.OCR_MIN_CONFIDENCE = '80';
    assert.throws(() => validateRecognition({ text: 'Uncertain', confidence: 65 }), { status: 422 });
    process.env.OCR_MIN_CONFIDENCE = 'invalid';
    assert.throws(() => validateRecognition({ text: 'Uncertain', confidence: 20 }), { status: 422 });
  } finally {
    if (previous === undefined) delete process.env.OCR_MIN_CONFIDENCE;
    else process.env.OCR_MIN_CONFIDENCE = previous;
  }
});

test('large interior drawings are not silently classified as blank paper', async () => {
  const { isBlankPage } = await import('../server/ocr-image.mjs');
  const image = Buffer.from('<svg width="768" height="1024"><rect width="768" height="1024" fill="#eee"/><path d="M150 200 L600 200 L600 750 L150 750 Z" stroke="#222" stroke-width="8" fill="none"/></svg>');
  assert.equal(await isBlankPage(image), false);
});
