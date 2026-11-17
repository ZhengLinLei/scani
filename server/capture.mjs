import { writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { HttpError, validId, captureIndex } from './store.mjs';
import { validateRecognition } from './ocr-quality.mjs';
import { initialRecognition, mergeRecognition, publicSession, MAX_PAGE_CAPTURES } from './ocr-merge.mjs';
import { repairPage } from './ai.mjs';

export function createCaptureHandler({ store, ocr, progress, normalizeImage, repairText }) {
  return async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) {
      throw new HttpError(400, 'Send a JPEG image.');
    }
    const accuracy = req.query.accuracy || 'high';
    if (req.query.ai !== undefined && !['true', 'false'].includes(req.query.ai)) throw new HttpError(400, 'Choose a valid AI setting.');
    const useAi = req.query.ai === 'true';
    if (!['high', 'fast'].includes(accuracy)) throw new HttpError(400, 'Choose a valid recognition mode.');
    const captureId = req.query.captureId;
    if (captureId !== undefined && !validId(captureId)) {
      throw new HttpError(400, 'Invalid capture ID.');
    }
    const mergeId = req.query.merge;
    if (mergeId !== undefined && (!validId(mergeId) || req.query.replace !== undefined || !captureId)) {
      throw new HttpError(400, 'Choose one valid page to merge and provide a capture ID.');
    }
    const session = await store.exclusive(req.params.id, async (session) => {
      // A lost HTTP response can be retried without adding the same photo twice.
      if (captureId && session.pages.some((page) => page.id === captureId || page.recognition?.ids.includes(captureId))) return session;
      const replaceId = req.query.replace;
      const replaceIndex = captureIndex(session, mergeId ?? replaceId);
      const original = mergeId ? session.pages[replaceIndex] : undefined;
      if (original?.textEdited) throw new HttpError(409, 'Combine captures before editing text. This page has saved corrections; keep them or use Rescan to start over.');
      if (original && (original.captureCount || 1) >= MAX_PAGE_CAPTURES) throw new HttpError(409, 'Maximum 10 captures per page. Review the text or rescan to start over.');
      const image = await normalizeImage(req.body);
      const result = await ocr.recognize(
        { type: 'recognize', image, accuracy },
        (event) => progress.broadcast(session.id, event)
      );
      validateRecognition(result);
      if (original) {
        session.pages[replaceIndex] = mergeRecognition(original, result, captureId);
        if (useAi) await repairPage(session.pages[replaceIndex], repairText, (event) => progress.broadcast(session.id, event));
        await store.save(session);
        progress.broadcast(session.id, { type: 'captured', pageId: original.id });
        return session;
      }
      const page = {
        id: captureId || randomUUID(),
        text: result.text,
        confidence: Math.round(result.confidence),
        ...(result.blank ? { blank: true } : {}),
        createdAt: new Date().toISOString(),
        captureCount: 1
      };
      page.recognition = initialRecognition(result, page.id);
      if (useAi) await repairPage(page, repairText, (event) => progress.broadcast(session.id, event));
      const imagePath = store.imagePath(session.id, page.id);
      await writeFile(imagePath, image, { mode: 0o600 });
      if (replaceIndex >= 0) {
        session.pages[replaceIndex] = page;
      } else {
        session.pages.push(page);
      }
      try {
        await store.save(session);
      } catch (error) {
        await unlink(imagePath).catch(() => {});
        throw error;
      }
      if (replaceIndex >= 0) {
        await unlink(store.imagePath(session.id, replaceId)).catch(() => {});
      }
      progress.broadcast(session.id, { type: 'captured', pageId: page.id });
      return session;
    });
    res.status(201).json(publicSession(session));
  };
}
