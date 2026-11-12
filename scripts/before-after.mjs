// The README image: the same lines in the same font, drawn with pdf-lib's
// drawText (top) and with this package (bottom). Needs a build and pdftoppm.
//
//   npm run build && node scripts/before-after.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { drawTextBox, embedTextFont } from '../dist/index.js';

const LINES = [
  'المبلغ 450 ريال (شامل الضريبة 15%)',
  'أرسل ملف PDF قبل 15/03/2026',
  'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
];
const WIDTH = 520;
const MARGIN = 28;
const SIZE = 22;
const PITCH = 40;
const PANEL = 34 + LINES.length * PITCH + 14;

const cairo = readFileSync('test/fonts/Cairo-Regular.ttf');
const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const page = doc.addPage([WIDTH, 2 * PANEL + 3 * 12]);
const label = await doc.embedFont(StandardFonts.Helvetica);
const plain = await doc.embedFont(cairo, { subset: true });
const shaped = await embedTextFont(doc, cairo);

const right = WIDTH - MARGIN;
const panels = [
  { title: "pdf-lib's drawText()", draw: (text, y) => page.drawText(text, { x: right - plain.widthOfTextAtSize(text, SIZE), y, size: SIZE, font: plain }) },
  { title: 'pdf-lib-arabic drawTextBox()', draw: (text, y) => drawTextBox(page, shaped, text, { x: MARGIN, y, width: right - MARGIN, size: SIZE }) },
];
panels.forEach((panel, index) => {
  const top = page.getHeight() - 12 - index * (PANEL + 12);
  page.drawRectangle({ x: 12, y: top - PANEL, width: WIDTH - 24, height: PANEL, color: index ? rgb(0.94, 0.98, 0.95) : rgb(0.99, 0.95, 0.95) });
  page.drawText(panel.title, { x: MARGIN, y: top - 22, size: 12, font: label, color: rgb(0.35, 0.35, 0.35) });
  LINES.forEach((line, i) => panel.draw(line, top - 34 - (i + 1) * PITCH + 12));
});

writeFileSync('docs/before-after.pdf', await doc.save());
execFileSync('pdftoppm', ['-r', '144', '-png', '-singlefile', 'docs/before-after.pdf', 'docs/before-after']);
rmSync('docs/before-after.pdf');
console.log('docs/before-after.png');
