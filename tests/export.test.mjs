import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { exportSession } from '../server/export.mjs';

function textResponse() {
  return {
    attachment(name) {
      this.filename = name;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    }
  };
}

test('export validates completion and format before sending an attachment', () => {
  const response = textResponse();
  assert.throws(() => exportSession({ finished: false }, 'txt', {}, response), { status: 409 });
  assert.throws(() => exportSession({ finished: true }, 'html', {}, response), { status: 400 });
  assert.equal(response.filename, undefined);
});

test('text download keeps Unicode and scan order', () => {
  const response = textResponse();
  const session = {
    name: 'My book',
    finished: true,
    pages: [{ text: ' Capítulo — café. ' }, { text: '第二頁' }]
  };
  exportSession(session, 'txt', {}, response);
  assert.equal(response.filename, 'My book.txt');
  assert.equal(response.contentType, 'text/plain; charset=utf-8');
  assert.equal(response.body, 'Capítulo — café.\n\n\f\n\n第二頁\n');
});

test('PDF download includes each scanned image with its own page dimensions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scani-pdf-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, 'pixel.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
    'base64'
  );
  await writeFile(imagePath, png);

  const chunks = [];
  const response = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk);
      callback();
    }
  });
  response.attachment = (name) => {
    response.filename = name;
  };
  const session = {
    id: 'session',
    name: 'Book',
    finished: true,
    pages: [{ id: 'first' }, { id: 'second' }]
  };
  const requestedPages = [];
  const store = {
    imagePath(sessionId, pageId) {
      assert.equal(sessionId, session.id);
      requestedPages.push(pageId);
      return imagePath;
    }
  };
  exportSession(session, 'pdf', store, response, (error) => response.destroy(error));
  await finished(response);

  const pdf = Buffer.concat(chunks).toString('latin1');
  assert.equal(response.filename, 'Book.pdf');
  assert.ok(pdf.startsWith('%PDF-'));
  assert.equal((pdf.match(/\/Type \/Page\b/g) || []).length, 2);
  assert.equal((pdf.match(/\/MediaBox \[0 0 595\.28 595\.28\]/g) || []).length, 2);
  assert.deepEqual(requestedPages, ['first', 'second']);
});
