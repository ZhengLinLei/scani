import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFrame, CaptureGate } from '../frontend/src/app/capture.mjs';
function createFrame(pixel) {
  const width = 240;
  const height = 180;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const brightness = pixel(x, y);
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = brightness;
      rgba[offset + 3] = 255;
    }
  }
  return { rgba, width, height };
}

function analyze(frame, previous) {
  return analyzeFrame(frame.rgba, frame.width, frame.height, previous);
}

test('does not capture darkness, a blank wall, or an empty white page', () => {
  for (const color of [0, 100, 255]) {
    const frame = createFrame(() => color);
    const first = analyze(frame);
    const repeated = analyze(frame, first.gray);
    assert.equal(repeated.ready, false);
  }
});

test('first frame cannot capture; clear stable text can', () => {
  const frame = createFrame((x, y) => (y % 10 < 2 && x % 7 < 4 ? 40 : 220));
  const first = analyze(frame);
  assert.equal(first.ready, false);

  const stable = analyze(frame, first.gray);
  assert.equal(stable.ready, true);
  assert.equal(stable.motion, 0);
});

test('large changes invalidate stability', () => {
  const before = createFrame((x, y) => ((x + y) % 8 < 2 ? 20 : 210));
  const after = createFrame((x, y) => ((x + y + 4) % 8 < 2 ? 20 : 210));
  assert.equal(analyze(after, analyze(before).gray).ready, false);
});

test('camera noise and small exposure changes allow sustained automatic capture', () => {
  const text = (x, y) => (y % 10 < 2 && x % 7 < 4 ? 40 : 220);
  const initial = createFrame(text);
  let previous = analyze(initial).gray;
  const gate = new CaptureGate(1000);
  let decision;
  for (let index = 0; index <= 6; index++) {
    const frame = createFrame((x, y) =>
      text(x, y) + (index % 2 ? 8 : 0) + ((x * 13 + y * 7 + index) % 9) - 4
    );
    const analysis = analyze(frame, previous);
    assert.equal(analysis.ready, true);
    decision = gate.update(analysis.ready, index * 180);
    previous = analysis.gray;
  }
  assert.equal(decision.capture, true);
});

test('large exposure changes and incompatible previous frames remain unstable', () => {
  const text = (x, y) => (y % 10 < 2 && x % 7 < 4 ? 40 : 190);
  const frame = createFrame(text);
  const brighter = createFrame((x, y) => text(x, y) + 35);
  assert.equal(analyze(brighter, analyze(frame).gray).ready, false);
  assert.equal(analyze(frame, new Uint8Array(10)).ready, false);
});

test('detects bright document bounds against a dark desk', () => {
  const frame = createFrame((x, y) => {
    const onPaper = x > 55 && x < 185 && y > 30 && y < 150;
    if (!onPaper) return 35;
    return y % 12 < 2 && x % 8 < 4 ? 30 : 230;
  });
  const analysis = analyze(frame);
  assert.equal(analysis.detected, true);
  assert.ok(analysis.crop.x > 0.2 && analysis.crop.x < 0.3);
  assert.ok(analysis.crop.width > 0.5 && analysis.crop.width < 0.65);
});

test('requires sustained quality, resets on motion, and locks after capture', () => {
  const gate = new CaptureGate(1000);
  assert.equal(gate.update(true, 0).capture, false);
  assert.equal(gate.update(true, 800).progress, 0.8);
  gate.update(false, 900);
  assert.equal(gate.update(true, 1200).progress, 0);
  assert.equal(gate.update(true, 2200).capture, true);
  assert.equal(gate.update(true, 4000).capture, false);

  gate.arm();
  assert.equal(gate.update(true, 5000).capture, false);
  assert.equal(gate.update(true, 6000).capture, true);
});

test('default auto capture waits for 0.9 seconds of stable quality', () => {
  const gate = new CaptureGate();
  assert.equal(gate.update(true, 0).capture, false);
  assert.equal(gate.update(true, 899).capture, false);
  assert.equal(gate.update(true, 900).capture, true);
});
