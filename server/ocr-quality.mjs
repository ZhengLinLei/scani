import { HttpError } from './store.mjs';

export function validateRecognition(result) {
  if (result.blank === true && result.text === '') return;
  const configured = Number(process.env.OCR_MIN_CONFIDENCE || 45);
  const minimum = Number.isFinite(configured) && configured >= 0 && configured <= 100 ? configured : 45;
  if (!result.text?.trim()) {
    throw new HttpError(422, 'No readable text found. Move closer, improve the light, then retry.');
  }
  if (!Number.isFinite(result.confidence) || result.confidence < minimum) {
    throw new HttpError(422, 'Text recognition is too uncertain. Move closer, flatten the page and improve the light, then retry.');
  }
}
