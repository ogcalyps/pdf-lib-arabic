/**
 * The font subset in the saved PDF must draw every glyph exactly as the
 * original font does. pdf-lib's subsetter (@pdf-lib/fontkit 1.1.1) writes a
 * short loca table, which cannot point at odd byte offsets, so fonts whose
 * glyphs have odd lengths (Amiri, Noto Naskh Arabic) came out as fragments.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { drawTextBox, embedTextFont, subsetInternals } from '../src';

const font = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fonts', name)));
const TEXT = 'المبلغ: ٤٥٠ ريال (شامل الضريبة 15%)\nبِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ، لأن الإسلام';

/** The embedded font program of the saved PDF (there is one font per test). */
function embeddedFontProgram(doc: PDFDocument): Uint8Array {
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object.get(PDFName.of('Type')) !== PDFName.of('FontDescriptor')) continue;
    const stream = doc.context.lookup(object.get(PDFName.of('FontFile2')));
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  }
  throw new Error('no FontFile2 in the PDF');
}

describe('the embedded subset draws every glyph like the original font', () => {
  it.each([
    ['Amiri-Regular.ttf', 1],
    ['NotoNaskhArabic-Variable.ttf', 1],
    ['Cairo-Regular.ttf', 0],
    ['NotoSansArabic-Regular.ttf', 0],
  ])('%s', async (name, locaFormat) => {
    const bytes = font(name);
    const doc = await PDFDocument.create();
    const embedded = await embedTextFont(doc, bytes);
    const fonts = name.startsWith('NotoSansArabic') ? [embedded, await embedTextFont(doc, font('LiberationSans-Regular.ttf'))] : embedded;
    drawTextBox(doc.addPage([500, 200]), fonts, TEXT, { x: 20, y: 160, width: 460, size: 20 });
    const saved = await PDFDocument.load(await doc.save());

    const subset = fontkit.create(embeddedFontProgram(saved));
    // A fresh instance: reading outlines from the subsetter's own font would disturb its glyph cache.
    const original = fontkit.create(bytes);
    const glyphIdMap = subsetInternals(embedded.pdfFont).glyphIdMap;
    expect(glyphIdMap.size).toBeGreaterThan(20);
    for (const [id, subsetId] of glyphIdMap) {
      expect(subset.getGlyph(subsetId).path.toSVG(), `glyph ${id}`).toBe(original.getGlyph(id).path.toSVG());
    }
    // The long table only where the font needs it, so other fonts write the same bytes as before.
    // (@cantoo/fontkit keeps each font's own format, so this holds for pdf-lib's subsetter only.)
    if (process.env.PDF_LIB_FORK !== 'cantoo') expect((subset.head as unknown as { indexToLocFormat: number }).indexToLocFormat).toBe(locaFormat);
  });
});
