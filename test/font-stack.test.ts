/**
 * A font STACK: each grapheme cluster takes the first font that has all of it, runs of
 * one font are shaped together inside a bidi level run, and drawLayout
 * switches Tf per font. A single font must write exactly the bytes it wrote
 * before the stack existed (pinned by hash over the golden corpus).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { createLayoutFont, drawLayout, drawTextBox, embedTextFont, findMissingCharacters, layoutText, uprightTransform } from '../src';
import { CORPUS } from './helpers/pdf-text-corpus';
import { readPdf, visualLines } from './helpers/pdf-glyph-oracle';

const font = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fonts', name)));
const CAIRO = font('Cairo-Regular.ttf');
const NOTO_SANS_ARABIC = font('NotoSansArabic-Regular.ttf');
const LIBERATION_SANS = font('LiberationSans-Regular.ttf');

/**
 * SHA-256 of the golden corpus drawn with ONE font (Cairo), each entry on its
 * own page, as the engine wrote it before font stacks existed. It is the same
 * hash BlendPDF's copy of this code gives, so the package writes the very
 * bytes the site has been shipping.
 */
/** The first page's content streams, decoded and joined. */
async function inflatedContent(doc: PDFDocument): Promise<Uint8Array> {
  const contents = doc.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const parts = streams.map((s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : new Uint8Array()));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length + 1;
  }
  return out;
}

const SINGLE_FONT_CORPUS_SHA256 = '39a0e403710a49d467d9d374ac4fc1211251b99e5324dea4695527628e5bbaf0';

describe('one font is unchanged by the stack', () => {
  // A fork serialises (compresses) differently, so the bytes are pdf-lib 1.17.1's only.
  it.skipIf(process.env.PDF_LIB_FORK)('the golden corpus drawn with Cairo alone is byte-identical to before', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const cairo = await embedTextFont(doc, CAIRO);
    for (const entry of CORPUS) {
      drawTextBox(doc.addPage([600, 200]), cairo, entry.text, { size: 16, width: entry.width ?? 480, direction: entry.direction, transform: uprightTransform(20, 180) });
    }
    expect(createHash('sha256').update(await doc.save()).digest('hex')).toBe(SINGLE_FONT_CORPUS_SHA256);
  });

  it('a stack of one is the same layout as the font itself, and every glyph is font 0', () => {
    const cairo = createLayoutFont(CAIRO);
    for (const entry of CORPUS) {
      const single = layoutText(cairo, entry.text, { size: 16, maxWidth: entry.width ?? 480 });
      const stacked = layoutText([cairo], entry.text, { size: 16, maxWidth: entry.width ?? 480 });
      expect(stacked, entry.id).toEqual(single);
      expect(single.lines.every((line) => line.glyphs.every((g) => g.font === 0)), entry.id).toBe(true);
    }
  });
});

describe('a font stack', () => {
  const PRICE = 'السعر 25$ (USD)';

  it('takes each cluster from the first font that has it: Arabic from Noto Sans Arabic, $ ( ) U S D from Liberation Sans', () => {
    const noto = createLayoutFont(NOTO_SANS_ARABIC);
    const liberation = createLayoutFont(LIBERATION_SANS);
    expect(findMissingCharacters(noto, PRICE)).toEqual(['$', '(', 'U', 'S', 'D', ')']);
    expect(findMissingCharacters([noto, liberation], PRICE)).toEqual([]);
    expect(findMissingCharacters([noto, liberation], 'السعر ✓')).toEqual(['✓']);
    const layout = layoutText([noto, liberation], PRICE, { size: 12, direction: 'rtl' });
    expect(layout.missing).toEqual([]);
    const glyphs = layout.lines[0].glyphs;
    const fontOfCodePoint = (cp: number) => glyphs.find((g) => g.glyph.codePoints.includes(cp))!.font;
    expect(fontOfCodePoint(0x0633)).toBe(0); // س
    expect(fontOfCodePoint(0x32)).toBe(0); // 2: Noto Sans Arabic has the digits
    for (const cp of [0x24, 0x55, 0x53, 0x44]) expect(fontOfCodePoint(cp), String.fromCodePoint(cp)).toBe(1);
    // Glyphs never overlap or leave gaps: positions grow left to right by each glyph's advance.
    for (let i = 1; i < glyphs.length; i++) expect(glyphs[i].x).toBeGreaterThan(glyphs[i - 1].x);
    expect(layout.width).toBeGreaterThan(0);
  });

  it('keeps Arabic joining inside one font: a word shaped in a stack has the same glyphs as in that font alone', () => {
    const noto = createLayoutFont(NOTO_SANS_ARABIC);
    const liberation = createLayoutFont(LIBERATION_SANS);
    const ids = (fonts: Parameters<typeof layoutText>[0]) => layoutText(fonts, 'المرتجعات', { size: 12 }).lines[0].glyphs.map((g) => g.glyph.id);
    expect(ids([liberation, noto])).toEqual(ids(noto));
  });

  it('draws as vector text with one Tf per font change; pdf.js reads the words back in visual order', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const embedded = [await embedTextFont(doc, NOTO_SANS_ARABIC), await embedTextFont(doc, LIBERATION_SANS)];
    const layout = layoutText(
      embedded.map((f) => f.font),
      PRICE,
      { size: 14, direction: 'rtl' },
    );
    const page = doc.addPage([300, 80]);
    drawLayout(page, embedded, layout, { size: 14, width: 260, transform: uprightTransform(20, 60) });
    const bytes = await doc.save();
    const saved = await PDFDocument.load(bytes);
    const fonts = saved.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    expect(fonts.keys()).toHaveLength(2);
    // One Tf per switch: (USD) Liberation, space Noto, $ Liberation, 25 and the word Noto (25 is an Arabic number here, $ a neutral: UAX #9 W2, N2).
    const content = new TextDecoder().decode(await inflatedContent(saved));
    expect(content.match(/ Tf\b/g)).toHaveLength(4);
    const [read] = await readPdf(bytes);
    expect(visualLines(read.glyphs, 14)).toEqual(['(USD) $25 رعسلا']);
  });

  it('drawLayout refuses a layout whose glyph names a font the stack does not have', async () => {
    const doc = await PDFDocument.create();
    const one = await embedTextFont(doc, NOTO_SANS_ARABIC);
    const layout = layoutText([one.font, createLayoutFont(LIBERATION_SANS)], 'USD', { size: 12 });
    expect(() => drawLayout(doc.addPage(), [one], layout, { size: 12, width: 100 })).toThrow(/no font 1/);
  });
});
