/**
 * The writer places glyphs through pdf-lib 1.17.1 internals (the subset
 * embedder's subset, glyphs, glyphIdMap, glyphCache, and PDFFont.modified).
 * pdf-lib is pinned exactly; these tests fail first if an upgrade moves them.
 * With PDF_LIB_FORK set, the same internals are checked in that fork instead.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { drawTextBox, embedTextFont, subsetInternals, uprightTransform } from '../src';

const ROOT = join(__dirname, '..');
const FONT_BYTES = new Uint8Array(readFileSync(join(__dirname, 'fonts', 'Cairo-Regular.ttf')));
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const FORK = process.env.PDF_LIB_FORK;

describe('pdf-lib internals the writer uses', () => {
  it.skipIf(FORK)('pins pdf-lib, fontkit and bidi-js to exact versions', () => {
    const pkg = readJson('package.json');
    expect(pkg.peerDependencies['pdf-lib']).toBe('1.17.1');
    expect(pkg.devDependencies['pdf-lib']).toBe('1.17.1');
    expect(pkg.dependencies['@pdf-lib/fontkit']).toBe('1.1.1');
    expect(pkg.dependencies['bidi-js']).toBe('1.1.0');
    expect(readJson('node_modules', 'pdf-lib', 'package.json').version).toBe('1.17.1');
    expect(readJson('node_modules', '@pdf-lib', 'fontkit', 'package.json').version).toBe('1.1.1');
  });

  it('a subset-embedded custom font still exposes subset, glyphs, glyphIdMap, glyphCache and modified', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const pdfFont = await doc.embedFont(FONT_BYTES, { subset: true });
    const raw = pdfFont as unknown as {
      modified: unknown;
      alreadyEmbedded: unknown;
      embedder: { font: { unitsPerEm: number }; subset: { includeGlyph: unknown }; glyphs: unknown; glyphIdMap: unknown; glyphCache: { invalidate: unknown } };
    };
    // @cantoo/pdf-lib renamed the flag that makes a save write the font again.
    expect(typeof (FORK === 'cantoo' ? raw.alreadyEmbedded : raw.modified)).toBe('boolean');
    expect(typeof raw.embedder.subset.includeGlyph).toBe('function');
    expect(Array.isArray(raw.embedder.glyphs)).toBe(true);
    expect(raw.embedder.glyphIdMap).toBeInstanceOf(Map);
    expect(typeof raw.embedder.glyphCache.invalidate).toBe('function');
    expect(raw.embedder.font.unitsPerEm).toBe(1000);
    expect(() => subsetInternals(pdfFont)).not.toThrow();
  });

  it('refuses a font embedded without subsetting', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const full = await doc.embedFont(FONT_BYTES);
    expect(() => subsetInternals(full)).toThrow(/subset: true/);
  });

  it('the glyph records reach the ToUnicode CMap, with lam-alef stored reversed', async () => {
    const doc = await PDFDocument.create();
    const font = await embedTextFont(doc, FONT_BYTES);
    drawTextBox(doc.addPage([300, 100]), font, 'لا', { size: 20, width: 260, transform: uprightTransform(20, 80) });
    const saved = await PDFDocument.load(await doc.save());

    const cmaps: string[] = [];
    for (const [, object] of saved.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict) || object.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue;
      const stream = saved.context.lookup(object.get(PDFName.of('ToUnicode')));
      if (!(stream instanceof PDFRawStream)) throw new Error('ToUnicode is not a stream');
      cmaps.push(new TextDecoder().decode(decodePDFRawStream(stream).decode()));
    }
    expect(cmaps).toHaveLength(1);
    // Alef (0627) then lam (0644): viewers flip RTL text back, giving لا.
    expect(cmaps[0]).toMatch(/<[0-9a-f]{4}> <06270644>/);
    expect(cmaps[0]).not.toMatch(/<06440627>/);
  });
});
