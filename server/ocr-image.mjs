import sharp from 'sharp';

// Keep the saved scan unchanged; resolution and grayscale apply only to OCR.
export async function prepareOcrImage(image, accuracy = 'high') {
  const configuredWidth = Number(process.env.OCR_MAX_WIDTH || 2200);
  const maximum = Number.isInteger(configuredWidth) && configuredWidth >= 800 && configuredWidth <= 2200
    ? configuredWidth : 2200;
  const width = accuracy === 'fast' ? Math.min(maximum, 1600) : maximum;
  return sharp(image)
    .resize({ width, height: Math.round(width * 3000 / 2200), fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .png()
    .toBuffer();
}

/** Look for small dark strokes against their local background, before contrast changes. */
export async function isBlankPage(image) {
  const { data, info } = await sharp(image)
    .resize({ width: 768, height: 1024, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: 'white' })
    .grayscale()
    .median(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (width < 32 || height < 32) return false;
  const background = await sharp(data, { raw: { width, height, channels: 1 } })
    .blur(8).grayscale().raw().toBuffer();
  const inset = Math.max(3, Math.round(Math.min(width, height) * 0.025));
  const marks = new Uint8Array(width * height);
  let brightness = 0;
  let pixels = 0;
  for (let y = inset; y < height - inset; y++) {
    for (let x = inset; x < width - inset; x++) {
      const i = y * width + x;
      brightness += data[i];
      pixels++;
      // Local comparison ignores smooth shadows; median filtering removes sensor speckles.
      if (background[i] - data[i] >= 16) marks[i] = 1;
    }
  }
  // A dark or badly exposed frame is not evidence of a blank sheet.
  if (brightness / pixels < 140) return false;
  const stack = [];
  for (let i = 0; i < marks.length; i++) {
    if (!marks[i]) continue;
    marks[i] = 0;
    stack.push(i);
    let area = 0;
    let left = width, right = 0, top = height, bottom = 0;
    while (stack.length) {
      const pixel = stack.pop();
      const x = pixel % width, y = Math.floor(pixel / width);
      area++;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < inset || nx >= width - inset || ny < inset || ny >= height - inset) continue;
          const neighbor = ny * width + nx;
          if (marks[neighbor]) { marks[neighbor] = 0; stack.push(neighbor); }
        }
      }
    }
    const strokeWidth = right - left + 1, strokeHeight = bottom - top + 1;
    const touchesEdge = left <= inset + 1 || top <= inset + 1 ||
      right >= width - inset - 2 || bottom >= height - inset - 2;
    // A large interior drawing or connected handwriting is content too.
    if (!touchesEdge && area >= 25 && strokeWidth >= 2 && strokeHeight >= 3) return false;
    // Ignore page borders and large shadow boundaries, but retain sparse text and single letters.
    if (area >= 5 && strokeWidth >= 2 && strokeHeight >= 3 &&
      strokeWidth < width * 0.25 && strokeHeight < height * 0.25) return false;
  }
  return true;
}
