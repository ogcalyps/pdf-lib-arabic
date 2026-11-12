/**
 * Loaded only when the suite runs against @cantoo/pdf-lib (PDF_LIB_FORK=cantoo,
 * see .github/workflows/ci.yml). That fork's subsetter needs @cantoo/fontkit,
 * which its users register on every document; this does the same for the tests.
 */
import fontkit from '@cantoo/fontkit';
import { PDFDocument } from 'pdf-lib';

const create = PDFDocument.create.bind(PDFDocument);
PDFDocument.create = async (...args: Parameters<typeof create>) => {
  const doc = await create(...args);
  doc.registerFontkit(fontkit as never);
  return doc;
};
