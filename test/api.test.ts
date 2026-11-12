/**
 * What the package adds on top of the engine: x/y placement like pdf-lib's
 * drawText, and drawTextBox with a font stack.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { MissingGlyphsError, drawLayout, drawTextBox, embedTextFont, layoutText } from '../src';
import { readPdf, visualLines } from './helpers/pdf-glyph-oracle';

const font = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fonts', name)));
const CAIRO = font('Cairo-Regular.ttf');
const NOTO_SANS_ARABIC = font('NotoSansArabic-Regular.ttf');
const LIBERATION_SANS = font('LiberationSans-Regular.ttf');

describe('x and y', () => {
  it('put the first baseline at y and the box\'s left edge at x, where pdf-lib\'s drawText puts its text', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Hello', { x: 50, y: 200, size: 18, font: helvetica });
    const ours = await embedTextFont(doc, CAIRO);
    const layout = drawTextBox(page, ours, 'Hello', { x: 50, y: 150, width: 300, size: 18 });
    const [read] = await readPdf(await doc.save());

    const cairoGlyphs = read.glyphs.filter((g) => g.y > 300 - 175);
    const helveticaGlyphs = read.glyphs.filter((g) => g.y < 300 - 175);
    expect(helveticaGlyphs[0].x).toBeCloseTo(50, 3);
    expect(helveticaGlyphs[0].y).toBeCloseTo(300 - 200, 3);
    // Display space has y down: baseline at page y 150 is display y 150.
    expect(cairoGlyphs[0].x).toBeCloseTo(50 + layout.lines[0].glyphs[0].x, 3);
    expect(cairoGlyphs[0].y).toBeCloseTo(300 - 150, 3);
  });

  it('later lines go down by the line height, and an RTL line ends at x + width', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    const ours = await embedTextFont(doc, CAIRO);
    const layout = drawTextBox(page, ours, 'سطر أول\nسطر ثان', { x: 40, y: 250, width: 320, size: 16 });
    const [read] = await readPdf(await doc.save());
    const baselines = [...new Set(read.glyphs.map((g) => Math.round((300 - g.y) * 1000) / 1000))].sort((a, b) => b - a);
    expect(baselines[0]).toBeCloseTo(250, 3);
    expect(baselines[baselines.length - 1]).toBeCloseTo(250 - layout.lineHeight, 3);
    const right = Math.max(...read.glyphs.filter((g) => Math.abs(300 - g.y - 250) < 0.01).map((g) => g.x));
    const lastGlyph = layout.lines[0].glyphs[layout.lines[0].glyphs.length - 1];
    expect(right).toBeCloseTo(40 + 320 - layout.lines[0].width + lastGlyph.x, 3);
  });
});

describe('drawTextBox with a font stack', () => {
  const PRICE = 'السعر 25$ (USD)';

  it('takes Latin from the second font when the first is Arabic-only, the same as layoutText + drawLayout', async () => {
    const draw = async (useLayout: boolean) => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const fonts = [await embedTextFont(doc, NOTO_SANS_ARABIC), await embedTextFont(doc, LIBERATION_SANS)];
      const page = doc.addPage([300, 80]);
      const options = { size: 14, width: 260, x: 20, y: 40 };
      if (useLayout) drawLayout(page, fonts, layoutText(fonts.map((f) => f.font), PRICE, { ...options, maxWidth: options.width }), options);
      else drawTextBox(page, fonts, PRICE, options);
      return doc.save();
    };
    const bytes = await draw(false);
    expect(bytes).toEqual(await draw(true));
    const [read] = await readPdf(bytes);
    expect(visualLines(read.glyphs, 14)).toEqual(['(USD) $25 رعسلا']);
  });

  it('throws MissingGlyphsError for Latin with an Arabic-only font, before touching the page', async () => {
    const doc = await PDFDocument.create();
    const noto = await embedTextFont(doc, NOTO_SANS_ARABIC);
    const page = doc.addPage([300, 80]);
    expect(() => drawTextBox(page, noto, PRICE, { size: 14, width: 260 })).toThrow(MissingGlyphsError);
    const [read] = await readPdf(await doc.save());
    expect(read.glyphs).toEqual([]);
  });
});

describe('Hebrew', () => {
  it('needs no shaping, only bidi: words right to left, numbers and Latin left to right, brackets mirrored', async () => {
    const doc = await PDFDocument.create();
    const liberation = await embedTextFont(doc, LIBERATION_SANS);
    const text = 'המחיר 450 ש"ח (כולל מע"מ) PDF';
    const layout = drawTextBox(doc.addPage([400, 100]), liberation, text, { x: 20, y: 60, width: 360, size: 16 });
    expect(layout.direction).toBe('rtl');
    const [read] = await readPdf(await doc.save());
    expect(visualLines(read.glyphs, layout.lineHeight)).toEqual(['PDF (מ"עמ ללוכ) ח"ש 450 ריחמה']);
    expect(read.text.join(' ')).toContain('450');
  });
});
