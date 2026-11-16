export const MAX_MOTION = 4.5;

/** Analyze a small, unmirrored video frame. Coordinates refer to the original frame. */
export function analyzeFrame(rgba, width, height, previous) {
  const gray = toGrayscale(rgba, width * height);
  const bounds = findDocumentBounds(gray, width, height);
  const quality = measureQuality(gray, width, bounds, previous);

  return {
    gray,
    ...quality,
    detected: bounds.detected,
    ready: quality.lit && quality.sharp && quality.motion < MAX_MOTION,
    crop: {
      x: bounds.left / width,
      y: bounds.top / height,
      width: (bounds.right - bounds.left) / width,
      height: (bounds.bottom - bounds.top) / height
    }
  };
}

function toGrayscale(rgba, pixelCount) {
  const gray = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index++) {
    const offset = index * 4;
    gray[index] = Math.round(
      rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114
    );
  }
  return gray;
}

function findDocumentBounds(gray, width, height) {
  let left = Math.floor(width * 0.1);
  let right = Math.floor(width * 0.9);
  let top = Math.floor(height * 0.08);
  let bottom = Math.floor(height * 0.92);
  const rows = new Uint16Array(height);
  const columns = new Uint16Array(width);
  let brightPixels = 0;

  // Count bright pixels by row and column to exclude isolated desk highlights.
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      if (gray[y * width + x] > 165) {
        rows[y]++;
        columns[x]++;
        brightPixels++;
      }
    }
  }

  let detected = false;
  const brightFraction = brightPixels / ((right - left) * (bottom - top));
  if (brightFraction > 0.2 && brightFraction < 0.85) {
    const documentColumns = [];
    const documentRows = [];
    for (let x = left; x < right; x++) {
      if (columns[x] > (bottom - top) * 0.35) {
        documentColumns.push(x);
      }
    }
    for (let y = top; y < bottom; y++) {
      if (rows[y] > (right - left) * 0.35) {
        documentRows.push(y);
      }
    }

    if (documentColumns.length > width * 0.3 && documentRows.length > height * 0.3) {
      left = Math.max(left, documentColumns[0] - 3);
      right = Math.min(right, documentColumns.at(-1) + 4);
      top = Math.max(top, documentRows[0] - 3);
      bottom = Math.min(bottom, documentRows.at(-1) + 4);
      detected = true;
    }
  }

  return { left, right, top, bottom, detected };
}

function measureQuality(gray, width, bounds, previous) {
  let brightness = 0;
  let edges = 0;
  let darkPixels = 0;
  let pixelCount = 0;
  const { left, right, top, bottom } = bounds;

  for (let y = top + 1; y < bottom - 1; y++) {
    for (let x = left + 1; x < right - 1; x++) {
      const index = y * width + x;
      const value = gray[index];
      const edge =
        4 * value - gray[index - 1] - gray[index + 1] - gray[index - width] - gray[index + width];
      brightness += value;
      edges += edge ** 2;
      if (value < 110) {
        darkPixels++;
      }
      pixelCount++;
    }
  }

  brightness /= pixelCount;
  edges /= pixelCount;
  const motion = measureMotion(gray, previous, width, bounds);
  const lit = brightness > 65 && brightness < 246;
  const sharp = edges > 100 && darkPixels / pixelCount > 0.012;
  return { brightness, edges, motion, lit, sharp };
}

function measureMotion(gray, previous, width, bounds) {
  if (previous?.length !== gray.length) return 255;

  // Compare local averages rather than individual text-edge pixels. Camera noise
  // and tiny hand tremors should not look like turning or moving the page.
  const differences = [];
  const blockSize = 4;
  for (let y = bounds.top; y + blockSize <= bounds.bottom; y += blockSize) {
    for (let x = bounds.left; x + blockSize <= bounds.right; x += blockSize) {
      let difference = 0;
      for (let dy = 0; dy < blockSize; dy++) {
        for (let dx = 0; dx < blockSize; dx++) {
          const index = (y + dy) * width + x + dx;
          difference += gray[index] - previous[index];
        }
      }
      differences.push(difference / (blockSize * blockSize));
    }
  }
  if (!differences.length) return 255;

  // Ignore small, uniform auto-exposure adjustments, but keep large changes
  // unstable so the camera can settle before capturing.
  const average = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const exposure = Math.abs(average) <= 12 ? average : 0;
  return differences.reduce((sum, value) => sum + Math.abs(value - exposure), 0) /
    differences.length;
}

/** A deliberate arm step is required after every capture, even if the scene is unchanged. */
export class CaptureGate {
  constructor(holdMs = 900) {
    this.holdMs = holdMs;
    this.arm();
  }

  arm() {
    this.since = null;
    this.locked = false;
  }

  update(ready, now) {
    if (this.locked) {
      return { capture: false, progress: 0 };
    }
    if (!ready) {
      this.since = null;
      return { capture: false, progress: 0 };
    }

    this.since ??= now;
    const progress = Math.min(1, (now - this.since) / this.holdMs);
    if (progress === 1) {
      this.locked = true;
    }
    return { capture: this.locked, progress };
  }
}
