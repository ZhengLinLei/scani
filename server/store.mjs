import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validId(id) {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id);
}

export function safeName(name) {
  const cleaned = String(name)
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .slice(0, 80);
  return cleaned || 'Untitled scan';
}

export function asText(session) {
  const pages = session.pages.map((page) => page.text.trim());
  // Form feeds preserve page boundaries in the editable text export.
  return pages.join('\n\n\f\n\n') + '\n';
}

/** Resolve a capture's slot without reopening a finished session for new pages. */
export function captureIndex(session, replaceId) {
  const index = typeof replaceId === 'string'
    ? session.pages.findIndex((page) => page.id === replaceId) : -1;
  if (replaceId !== undefined && index === -1) {
    throw new HttpError(404, 'Page to replace was not found.');
  }
  if (index === -1 && session.finished) {
    throw new HttpError(409, 'This session is already finished.');
  }
  if (index === -1 && session.pages.length >= 100) {
    throw new HttpError(409, 'Maximum 100 pages per session.');
  }
  return index;
}

export class Store {
  constructor(root) {
    this.root = root;
    this.locks = new Set();
  }

  folder(id) {
    if (!validId(id)) {
      throw new HttpError(404, 'Session not found.');
    }
    return join(this.root, id);
  }

  imagePath(sessionId, pageId) {
    return join(this.folder(sessionId), `${pageId}.jpg`);
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async create({ name, format }) {
    if (!['txt', 'pdf'].includes(format)) {
      throw new HttpError(400, 'Choose TXT or PDF.');
    }
    const sessions = (await readdir(this.root)).filter(validId);
    if (sessions.length >= 100) {
      throw new HttpError(409, 'Storage is full. Delete an older session first.');
    }
    const session = {
      id: randomUUID(),
      name: safeName(name),
      format,
      createdAt: new Date().toISOString(),
      finished: false,
      pages: []
    };
    await mkdir(this.folder(session.id), { mode: 0o700 });
    await this.save(session);
    return session;
  }

  async get(id) {
    try {
      return JSON.parse(await readFile(join(this.folder(id), 'session.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new HttpError(404, 'Session not found.');
      }
      throw error;
    }
  }

  async save(session) {
    const file = join(this.folder(session.id), 'session.json');
    const temporaryFile = `${file}.tmp`;
    await writeFile(temporaryFile, JSON.stringify(session), { mode: 0o600 });
    await rename(temporaryFile, file);
  }

  async exclusive(id, work) {
    if (this.locks.has(id)) {
      throw new HttpError(409, 'This session is busy. Wait for the current page.');
    }
    this.locks.add(id);
    try {
      return await work(await this.get(id));
    } finally {
      this.locks.delete(id);
    }
  }

  async delete(id) {
    await this.exclusive(id, async () => rm(this.folder(id), { recursive: true, force: true }));
  }
}
