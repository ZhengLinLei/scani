import express from 'express';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { resolve, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Store, HttpError } from './store.mjs';
import { createOcr } from './ocr.mjs';
import { publicSession } from './ocr-merge.mjs';
import { createCaptureHandler } from './capture.mjs';
import { createTextRepair, repairPage } from './ai.mjs';
import { createProgress } from './progress.mjs';
import { exportSession } from './export.mjs';

const root = resolve(process.env.DATA_DIR || 'data');
const store = new Store(root);
await store.init();
const ocr = createOcr(root);
const repairText = createTextRepair();
const app = express();
const server = createServer(app);
const progress = createProgress(server, store);

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  });
  // Prevent cross-origin writes to this local service; no permissive CORS.
  if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
function warmOcr() {
  // Begin loading while the user positions the page, without delaying the API.
  void ocr.warmup().catch((error) => console.error('OCR preparation failed:', error.message));
}

app.post('/api/sessions', async (req, res) => {
  const session = await store.create(req.body || {});
  warmOcr();
  res.status(201).json(publicSession(session));
});
app.get('/api/sessions/:id', async (req, res) => {
  const session = await store.get(req.params.id);
  if (!session.finished) warmOcr();
  res.json(publicSession(session));
});
app.delete('/api/sessions/:id', async (req, res) => {
  await store.delete(req.params.id);
  res.sendStatus(204);
});

async function normalizeImage(buffer) {
  try {
    return await sharp(buffer, { limitInputPixels: 24_000_000 })
      .rotate()
      .resize({ width: 2200, height: 3000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch {
    throw new HttpError(400, 'The image could not be decoded. Try again.');
  }
}

app.post(
  '/api/sessions/:id/pages',
  express.raw({ type: 'image/jpeg', limit: '12mb' }),
  createCaptureHandler({ store, ocr, progress, normalizeImage, repairText })
);
app.post('/api/sessions/:id/pages/:pageId/repair', async (req, res) => {
  const session = await store.exclusive(req.params.id, async (session) => {
    const page = session.pages.find((page) => page.id === req.params.pageId);
    if (!page) throw new HttpError(404, 'Page not found.');
    if (page.textEdited) throw new HttpError(409, 'Saved corrections are protected. Rescan to start over.');
    await repairPage(page, repairText, (event) => progress.broadcast(session.id, event));
    await store.save(session);
    return session;
  });
  res.json(publicSession(session));
});
app.patch('/api/sessions/:id/pages/:pageId', async (req, res) => {
  if (typeof req.body?.text !== 'string' || req.body.text.length > 100_000) {
    throw new HttpError(400, 'Page text must be at most 100,000 characters.');
  }
  const result = await store.exclusive(req.params.id, async (session) => {
    const page = session.pages.find((page) => page.id === req.params.pageId);
    if (!page) {
      throw new HttpError(404, 'Page not found.');
    }
    if (page.text !== req.body.text) page.textEdited = true;
    page.text = req.body.text;
    if (page.text.trim()) delete page.blank;
    await store.save(session);
    return session;
  });
  res.json(publicSession(result));
});

app.delete('/api/sessions/:id/pages/:pageId', async (req, res) => {
  const result = await store.exclusive(req.params.id, async (session) => {
    if (session.finished) {
      throw new HttpError(409, 'This session is already finished.');
    }
    if (!session.pages.some((page) => page.id === req.params.pageId)) {
      throw new HttpError(404, 'Page not found.');
    }
    session.pages = session.pages.filter((page) => page.id !== req.params.pageId);
    await store.save(session);
    await unlink(store.imagePath(session.id, req.params.pageId)).catch(() => {});
    return session;
  });
  res.json(publicSession(result));
});

app.get('/api/sessions/:id/pages/:pageId/image', async (req, res) => {
  const session = await store.get(req.params.id);
  if (!session.pages.some((page) => page.id === req.params.pageId)) {
    throw new HttpError(404, 'Page not found.');
  }
  res.sendFile(store.imagePath(session.id, req.params.pageId));
});

app.post('/api/sessions/:id/finish', async (req, res) => {
  const session = await store.exclusive(req.params.id, async (session) => {
    if (!session.pages.length) {
      throw new HttpError(400, 'Scan at least one page first.');
    }
    session.finished = true;
    await store.save(session);
    return session;
  });
  res.json(publicSession(session));
});

app.get('/api/sessions/:id/export', async (req, res, next) => {
  const session = await store.get(req.params.id);
  const format = req.query.format || session.format;
  exportSession(session, format, store, res, next);
});

const client = resolve('dist/scani/browser');
if (existsSync(client)) {
  app.use(express.static(client, { index: 'index.html' }));
  app.get('/{*path}', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Endpoint not found.' });
    }
    res.sendFile(join(client, 'index.html'));
  });
}
app.use((error, _req, res, _next) => {
  if (res.headersSent) {
    return res.destroy();
  }
  const status = error.status || 500;
  if (status === 500) {
    console.error(error);
  }
  let message = error.message;
  if (status === 413) {
    message = 'Image is too large (maximum 12 MB).';
  }
  if (status === 500) {
    message = 'The operation failed. Check the server and try again.';
  }
  res.status(status).json({ error: message });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => {
  console.log(`Scani is ready at http://${host}:${port}`);
});

async function shutdown() {
  progress.close();
  server.close();
  await ocr.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
