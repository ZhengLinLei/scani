import PDFDocument from 'pdfkit';
import { HttpError, safeName, asText } from './store.mjs';

const PDF_PAGE_WIDTH = 595.28;

export function exportSession(session, format, store, response, next) {
  if (!session.finished) {
    throw new HttpError(409, 'Finish the session before downloading.');
  }
  if (!['txt', 'pdf'].includes(format)) {
    throw new HttpError(400, 'Choose TXT or PDF.');
  }

  response.attachment(`${safeName(session.name)}.${format}`);
  if (format === 'txt') {
    response.type('text/plain; charset=utf-8').send(asText(session));
    return;
  }

  const document = new PDFDocument({
    autoFirstPage: false,
    info: { Title: session.name, Creator: 'Scani' }
  });
  const handleError = (error) => {
    if (response.headersSent) {
      response.destroy(error);
    } else {
      next(error);
    }
  };
  document.on('error', handleError);
  document.pipe(response);

  try {
    for (const page of session.pages) {
      const image = document.openImage(store.imagePath(session.id, page.id));
      const width = PDF_PAGE_WIDTH;
      const height = (width * image.height) / image.width;
      document.addPage({ size: [width, height], margin: 0 });
      document.image(image, 0, 0, { width, height });
    }
    document.end();
  } catch (error) {
    document.destroy();
    handleError(error);
  }
}
