/** Normalize a selected photo to the same JPEG size used by camera captures. */
export async function preparePhoto(file: File): Promise<Blob> {
  if (!/\.(jpe?g|png|webp)$/i.test(file.name) &&
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a JPEG, PNG or WebP photo.');
  }
  if (!file.size || file.size > 20 * 1024 * 1024) {
    throw new Error('Choose a photo smaller than 20 MB.');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error('Could not read this photo. Try another JPEG, PNG or WebP file.');
    }
    const scale = Math.min(1, 2200 / image.naturalWidth, 3000 / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare this photo.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Could not prepare this photo.')),
      'image/jpeg', 0.94
    ));
  } finally {
    URL.revokeObjectURL(url);
  }
}
