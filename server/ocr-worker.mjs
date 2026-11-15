import { parentPort, workerData } from 'node:worker_threads';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorker, PSM } from 'tesseract.js';
import { prepareOcrImage, isBlankPage } from './ocr-image.mjs';

let engine;
parentPort.on('message', async (image) => {
  try {
    const source = image?.type === 'warmup' ? null
      : Buffer.from(image?.type === 'recognize' ? image.image : image);
    if (source && await isBlankPage(source)) {
      parentPort.postMessage({ type: 'result', result: { text: '', confidence: 0, blank: true } });
      return;
    }
    if (!engine) {
      const cachePath = join(workerData.root, 'ocr-cache');
      await mkdir(cachePath, { recursive: true });
      engine = await createWorker(process.env.OCR_LANGUAGES || 'eng+spa', 1, {
        cachePath,
        ...(process.env.OCR_LANG_PATH ? { langPath: process.env.OCR_LANG_PATH } : {}),
        logger: (event) =>
          parentPort.postMessage({
            type: 'progress',
            status: event.status,
            progress: event.progress
          }),
        // Some initialization errors are not promise rejections; the parent also enforces a timeout.
        errorHandler: (error) => parentPort.postMessage({ type: 'error', error: String(error) })
      });
      await engine.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      });
    }
    if (image?.type === 'warmup') {
      parentPort.postMessage({ type: 'result', result: null });
      return;
    }
    const input = await prepareOcrImage(source, image.accuracy || 'high');
    const { data } = await engine.recognize(input, {}, { blocks: true });
    const words = (data.blocks || []).flatMap((block) =>
      (block.paragraphs || []).flatMap((paragraph) =>
        (paragraph.lines || []).flatMap((line) =>
          (line.words || []).map(({ text, confidence }) => ({ text, confidence }))
        )
      )
    );
    parentPort.postMessage({
      type: 'result',
      result: { text: data.text, confidence: data.confidence, words }
    });
  } catch (error) {
    parentPort.postMessage({ type: 'error', error: error.message });
  }
});
