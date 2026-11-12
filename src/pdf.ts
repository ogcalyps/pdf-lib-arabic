/**
 * Writing laid-out text into a PDF page with pdf-lib.
 *
 * pdf-lib's drawText cannot be used for Arabic: it has no bidi and drops every
 * GPOS offset. So the font is embedded with pdf-lib's own subsetter, the text
 * is shaped by fontkit (layout.ts), and each glyph is placed with a text
 * matrix at fontkit's position. That needs four pdf-lib 1.17.1 internals (see
 * subsetInternals), which is why the peer dependency is exactly 1.17.1 and
 * test/internals.test.ts checks they still exist.
 */
import fontkit from '@pdf-lib/fontkit';
import type { Font, Glyph } from '@pdf-lib/fontkit';
import {
  PDFHexString,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingColor,
  setFontAndSize,
  setTextMatrix,
  showText,
} from 'pdf-lib';
import type { Color, PDFDocument, PDFFont, PDFOperator, PDFPage } from 'pdf-lib';
import { layoutText } from './layout';
import type { TextLayout, TextLayoutOptions } from './layout';

/** A PDF matrix [a b c d e f]: (x, y) maps to (a*x + c*y + e, b*x + d*y + f). */
export type Matrix = [number, number, number, number, number, number];

/** The font embedded in one document, plus a fontkit instance of the same font to lay text out with. */
export interface PdfTextFont {
  readonly pdfFont: PDFFont;
  /** NOT the instance pdf-lib's subsetter uses (see embedTextFont). */
  readonly font: Font;
}

/** The fields of pdf-lib 1.17.1's CustomFontSubsetEmbedder (CustomFontSubsetEmbedder.js:16-45) the writer relies on. */
interface SubsetEmbedder {
  font: Font;
  subset: { includeGlyph(glyph: Glyph | number): number };
  /** Index = subset glyph id - 1. pdf-lib builds the ToUnicode CMap and the /W widths from these. */
  glyphs: Array<{ id: number; codePoints: number[]; advanceWidth: number }>;
  /** Font glyph id to subset glyph id. */
  glyphIdMap: Map<number, number>;
  glyphCache: { invalidate(): void };
}

/** Thrown when the box contains characters the font cannot draw. */
export class MissingGlyphsError extends Error {
  readonly characters: string[];
  constructor(characters: string[]) {
    super(`The font has no glyph for: ${characters.join(' ')}`);
    this.name = 'MissingGlyphsError';
    this.characters = characters;
  }
}

/**
 * How a PDFFont knows its subset must be written again on the next save:
 * pdf-lib 1.17.1 and @pdfme/pdf-lib re-embed while `modified` is true,
 * @cantoo/pdf-lib until `alreadyEmbedded` is true.
 */
interface EmbedFlags {
  modified?: unknown;
  alreadyEmbedded?: unknown;
}

/**
 * The pdf-lib internals the writer needs, checked at runtime. Fails loudly if
 * pdf-lib changes or the font was embedded without `subset: true`.
 */
export function subsetInternals(pdfFont: PDFFont): SubsetEmbedder {
  const candidate = pdfFont as unknown as { embedder?: Partial<SubsetEmbedder> } & EmbedFlags;
  const embedder = candidate.embedder;
  if (
    !embedder ||
    !embedder.font ||
    typeof embedder.subset?.includeGlyph !== 'function' ||
    !Array.isArray(embedder.glyphs) ||
    !(embedder.glyphIdMap instanceof Map) ||
    typeof embedder.glyphCache?.invalidate !== 'function' ||
    (typeof candidate.modified !== 'boolean' && typeof candidate.alreadyEmbedded !== 'boolean')
  ) {
    throw new Error('pdf-lib-arabic needs pdf-lib 1.17.1 (or @pdfme/pdf-lib, @cantoo/pdf-lib) and a font embedded with { subset: true }');
  }
  return embedder as SubsetEmbedder;
}

/** The part of fontkit's TrueType subset (TTFSubset, fontkit.umd.js:40881-41004 in @pdf-lib/fontkit 1.1.1) the fix below touches. */
interface TrueTypeSubset {
  glyf?: Array<{ length: number }>;
  loca?: { version?: number };
  _addGlyph?(gid: number): number;
}

/**
 * pdf-lib's subsetter (@pdf-lib/fontkit 1.1.1) writes a subset smaller than
 * 128 KB with a short loca table, which stores every glyph offset halved. When
 * a glyph has an odd byte length (Amiri and Noto Naskh Arabic have hundreds;
 * their own loca is the long kind), every glyph after it is cut at the wrong
 * byte and draws as fragments, with pdf-lib's drawText too. Keep the long
 * table as soon as an odd-length glyph goes in, so fonts without one are
 * written exactly as before. fontkit 2 (@cantoo/fontkit) keeps the font's own
 * format, sets the version up front, and is left alone.
 */
function keepGlyphOffsetsExact(subset: unknown): void {
  const ttf = subset as TrueTypeSubset;
  const addGlyph = ttf._addGlyph;
  if (typeof addGlyph !== 'function') return; // a CFF subset has no loca
  ttf._addGlyph = function (this: TrueTypeSubset, gid: number) {
    const index = addGlyph.call(this, gid);
    if (this.loca && this.loca.version == null && (this.glyf?.[index]?.length ?? 0) % 2 === 1) this.loca.version = 1;
    return index;
  };
}

/** pdf-lib re-serialises a font on save only when it thinks the font changed, and only its own encodeText says so. */
function markChanged(pdfFont: PDFFont): void {
  const flags = pdfFont as unknown as EmbedFlags;
  if (typeof flags.modified === 'boolean') flags.modified = true;
  else flags.alreadyEmbedded = false;
}

/**
 * A fontkit font for laying out text: for an on-screen preview, or to lay out
 * once and draw into several documents. Use it for layout only. Reading a
 * composite glyph's path or bbox makes fontkit cache the glyph's parts with no
 * code points, and letters drawn from those parts afterwards lose their copy
 * text in the PDF. Anything that draws glyph outlines needs its own instance.
 */
export function createLayoutFont(fontBytes: Uint8Array | ArrayBuffer): Font {
  return fontkit.create(fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes));
}

/**
 * Embed a TrueType font into `doc` as a subset, ready for drawTextBox. Call once per document.
 *
 * The subsetter uses the fontkit registered on `doc`, or @pdf-lib/fontkit if
 * there is none. @cantoo/pdf-lib needs its own, so register @cantoo/fontkit
 * on the document first there.
 *
 * Text is laid out with a second fontkit instance, never the one inside
 * pdf-lib's subsetter. Saving makes the subsetter pull in the parts of
 * composite glyphs, and fontkit caches those Glyph objects with no code
 * points. In Cairo many letters are such parts (ا ح د ر س ع ه و, most Latin
 * lowercase, several digits), so on a second save they would come back from
 * the shared cache without code points and lose their copy text.
 */
export async function embedTextFont(doc: PDFDocument, fontBytes: Uint8Array | ArrayBuffer): Promise<PdfTextFont> {
  if (!(doc as unknown as { fontkit?: unknown }).fontkit) doc.registerFontkit(fontkit);
  const pdfFont = await doc.embedFont(fontBytes, { subset: true });
  // Fail now, not at the first draw, if pdf-lib moved its internals.
  keepGlyphOffsetsExact(subsetInternals(pdfFont).subset);
  return { pdfFont, font: createLayoutFont(fontBytes) };
}

/**
 * Code points for a glyph's ToUnicode entry. A glyph that stands for several
 * right-to-left characters (lam-alef "لا" is one glyph) gets them in reverse.
 * Viewers extract the line in display order and then flip RTL text back to
 * logical order, flipping the inside of that glyph's entry too; storing it
 * reversed makes the round trip come out as لا, not ال.
 *
 * Returns a new array. fontkit caches one Glyph object per glyph id for the
 * life of the font, so changing glyph.codePoints in place would flip it again
 * on every export from the same font.
 */
export function toUnicodeCodePoints(codePoints: readonly number[]): number[] {
  const copy = [...codePoints];
  return copy.length > 1 && copy.some(isRtlScript) ? copy.reverse() : copy;
}

/** Hebrew, Arabic, Syriac, Thaana, NKo and the Arabic/Hebrew presentation forms. */
function isRtlScript(cp: number): boolean {
  return (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfefe);
}

/** Add a glyph to the font subset and give it its ToUnicode entry. Returns the subset glyph id. */
function includeGlyph(embedder: SubsetEmbedder, glyph: Glyph): number {
  const known = embedder.glyphIdMap.get(glyph.id);
  if (known !== undefined) return known;
  const subsetId = embedder.subset.includeGlyph(glyph.id);
  // A plain record, not the fontkit Glyph: pdf-lib only reads these three fields.
  const record = { id: glyph.id, codePoints: toUnicodeCodePoints(glyph.codePoints), advanceWidth: glyph.advanceWidth };
  embedder.glyphIdMap.set(glyph.id, subsetId);
  // Kept as a dense list in subset-id order, NOT at [subsetId - 1] the way
  // pdf-lib's own encodeText stores it. Saving encodes the subset, and that
  // adds the parts of composite glyphs to it, so ids handed out after a save
  // skip ahead; an indexed store would leave holes that crash pdf-lib's next
  // save (computeWidths). pdf-lib finds each record's id through glyphIdMap.
  const list = embedder.glyphs;
  let at = list.length;
  while (at > 0 && embedder.glyphIdMap.get(list[at - 1].id)! > subsetId) at--;
  list.splice(at, 0, record);
  return subsetId;
}

const fontKeys = new WeakMap<PDFPage, Map<PDFFont, string>>();

/**
 * The page's resource name for the font, added once per page. Returned as a
 * string, not the PDFName: when the page comes from a fork of pdf-lib, the
 * operators built here would not recognise the fork's PDFName.
 */
function fontKeyFor(page: PDFPage, pdfFont: PDFFont): string {
  let keys = fontKeys.get(page);
  if (!keys) fontKeys.set(page, (keys = new Map()));
  let key = keys.get(pdfFont);
  if (!key) {
    key = page.node.newFontDictionary(pdfFont.name, pdfFont.ref).asString().slice(1);
    keys.set(pdfFont, key);
  }
  return key;
}

/**
 * The transform that keeps text upright for the reader on a page shown with
 * /Rotate `rotation`, with the box's top-left corner at (x, y) in the page's
 * own (unrotated) coordinates. Box space: x to the reader's right, y to the
 * reader's up.
 */
export function uprightTransform(x: number, y: number, rotation = 0): Matrix {
  switch (((Math.round(rotation / 90) % 4) + 4) % 4) {
    case 1:
      return [0, 1, -1, 0, x, y];
    case 2:
      return [-1, 0, 0, -1, x, y];
    case 3:
      return [0, -1, 1, 0, x, y];
    default:
      return [1, 0, 0, 1, x, y];
  }
}

export type TextAlign = 'start' | 'center' | 'end';

export interface DrawTextOptions extends Omit<TextLayoutOptions, 'maxWidth'> {
  /** Box width in points; text wraps to it and aligns inside it. */
  width: number;
  /** Relative to each line's own direction: 'start' is the right edge of an RTL line. Default 'start'. */
  align?: TextAlign;
  /** Default black. */
  color?: Color;
  /**
   * Where the box goes when there is no `transform`: x is its left edge and y
   * the baseline of its first line, in page coordinates, the same point
   * pdf-lib's own drawText puts at (x, y). Default 0.
   */
  x?: number;
  y?: number;
  /**
   * Box space to page space; overrides x and y. Box space has its origin at
   * the box's top-left corner as the reader sees it, x to the right, y UP (so
   * lines sit at negative y). See uprightTransform for rotated pages.
   */
  transform?: Matrix;
}

function lineOffset(lineWidth: number, boxWidth: number, align: TextAlign, rtl: boolean): number {
  if (align === 'center') return (boxWidth - lineWidth) / 2;
  const atLeft = (align === 'start') !== rtl;
  return atLeft ? 0 : boxWidth - lineWidth;
}

/**
 * Draw an already computed layout (e.g. the one the preview showed) into the
 * box. `textFonts` is the embedded font, or the embedded stack in the same
 * order as the fonts the layout was made with (LaidOutGlyph.font indexes it):
 * one Tf per font change, so a single font writes exactly what it always did.
 */
export function drawLayout(page: PDFPage, textFonts: PdfTextFont | readonly PdfTextFont[], layout: TextLayout, options: DrawTextOptions): void {
  if (layout.missing.length) throw new MissingGlyphsError(layout.missing);
  const { width, align = 'start', color = rgb(0, 0, 0) } = options;
  const [a, b, c, d, e, f] = options.transform ?? [1, 0, 0, 1, options.x ?? 0, (options.y ?? 0) + layout.baseline];
  const stack: readonly PdfTextFont[] = Array.isArray(textFonts) ? (textFonts as readonly PdfTextFont[]) : [textFonts as PdfTextFont];
  const embedders = stack.map((textFont) => subsetInternals(textFont.pdfFont));
  const used = new Set<number>();
  const first = layout.lines.find((line) => line.glyphs.length > 0)?.glyphs[0].font ?? 0;
  if (!stack[first]) throw new RangeError(`no font ${first} in the stack`);
  let current = first;
  used.add(current);

  const ops: PDFOperator[] = [pushGraphicsState(), setFillingColor(color), beginText(), setFontAndSize(fontKeyFor(page, stack[current].pdfFont), layout.size)];
  layout.lines.forEach((line, index) => {
    const left = lineOffset(line.width, width, align, line.direction === 'rtl');
    const baseline = -(index * layout.lineHeight + layout.baseline);
    for (const placed of line.glyphs) {
      if (placed.font !== current) {
        if (!stack[placed.font]) throw new RangeError(`no font ${placed.font} in the stack`);
        current = placed.font;
        used.add(current);
        ops.push(setFontAndSize(fontKeyFor(page, stack[current].pdfFont), layout.size));
      }
      const subsetId = includeGlyph(embedders[current], placed.glyph);
      const x = left + placed.x;
      const y = baseline + placed.y;
      ops.push(
        setTextMatrix(a, b, c, d, a * x + c * y + e, b * x + d * y + f),
        showText(PDFHexString.of(subsetId.toString(16).padStart(4, '0'))),
      );
    }
  });
  ops.push(endText(), popGraphicsState());

  for (const index of used) {
    embedders[index].glyphCache.invalidate();
    markChanged(stack[index].pdfFont);
  }
  page.pushOperators(...ops);
}

/**
 * Lay out `text` in a box `width` points wide and draw it on `page`, with one
 * embedded font or a stack of them (each character from the first font that
 * has it). Throws MissingGlyphsError (before touching the page) if no font
 * can draw some character; check layoutText(...).missing first to choose a
 * fallback.
 */
export function drawTextBox(page: PDFPage, textFonts: PdfTextFont | readonly PdfTextFont[], text: string, options: DrawTextOptions): TextLayout {
  const fonts = Array.isArray(textFonts) ? (textFonts as readonly PdfTextFont[]).map((f) => f.font) : (textFonts as PdfTextFont).font;
  const layout = layoutText(fonts, text, { ...options, maxWidth: options.width });
  drawLayout(page, textFonts, layout, options);
  return layout;
}
