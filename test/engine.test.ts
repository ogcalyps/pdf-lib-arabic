/**
 * Golden corpus: each entry is written to a PDF and read back with pdf.js in
 * Node. Ordering, digits and mirroring are checked on the
 * VISUAL glyph order (positions on the displayed page), because text
 * extraction reorders brackets by itself. Extraction is only used for
 * word-level search.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import bidiFactory from 'bidi-js';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import {
  MissingGlyphsError,
  analyzeParagraph,
  createLayoutFont,
  drawLayout,
  drawTextBox,
  embedTextFont,
  findMissingCharacters,
  isBidiControl,
  isDefaultIgnorable,
  layoutText,
  resolveDirection,
  resolveParagraphDirections,
  uprightTransform,
} from '../src';
import type { TextLayout } from '../src';
import { CORPUS, DEFAULT_WIDTH, FONT_SIZE, RLM, ZWNJ } from './helpers/pdf-text-corpus';
import type { CorpusEntry } from './helpers/pdf-text-corpus';
import { readPdf, stripMarks, visualLines } from './helpers/pdf-glyph-oracle';
import type { OraclePage } from './helpers/pdf-glyph-oracle';

const FONT_BYTES = new Uint8Array(readFileSync(join(__dirname, 'fonts', 'Cairo-Regular.ttf')));
const bidi = bidiFactory();

const MARGIN = 40;
const PAGE_WIDTH = DEFAULT_WIDTH + 2 * MARGIN;
const PAGE_HEIGHT = 200;

/** Drop what never reaches the PDF: bidi controls and default-ignorables (ZWNJ...). */
function stripInvisible(text: string): string {
  return [...text]
    .filter((ch) => {
      const cp = ch.codePointAt(0)!;
      return !isBidiControl(cp) && !isDefaultIgnorable(cp);
    })
    .join('');
}

/**
 * Expected display order of each line from bidi-js's own reordering
 * (getReorderedIndices applies L1-L3 per line; L4 mirroring added here), with
 * marks left out as visualLines does. Multi-line entries contain no bidi
 * controls, so the line texts index straight into the source.
 */
function expectedVisual(text: string, lines: string[], direction: 'ltr' | 'rtl'): string[] {
  const embedding = bidi.getEmbeddingLevels(text, direction);
  const lineVisual = (start: number, end: number) =>
    bidi
      .getReorderedIndices(text, embedding, start, end)
      .slice(start, end + 1)
      .map((i) => ((embedding.levels[i] & 1 && bidi.getMirroredCharacter(text[i])) || text[i]))
      .join('');
  if (lines.length === 1) return [stripMarks(stripInvisible(lineVisual(0, text.length - 1)))];
  let cursor = 0;
  return lines.map((line) => {
    const start = text.indexOf(line, cursor);
    expect(start).toBeGreaterThanOrEqual(0);
    cursor = start + line.length;
    return stripMarks(stripInvisible(lineVisual(start, start + line.length - 1)));
  });
}

const PUNCTUATION = '()[]{}<>«»"\'!?؟.,،:;؛%٪–—/@-ـ';

/** Text as a search box would match it: marks, tatweel, brackets and neutral punctuation removed. */
function searchWords(text: string): string[] {
  const cleaned = [...stripMarks(stripInvisible(text))].map((ch) => (PUNCTUATION.includes(ch) ? ' ' : ch)).join('');
  return cleaned.split(/\s+/).filter(Boolean);
}

async function renderCorpus(): Promise<{ bytes: Uint8Array; layouts: TextLayout[] }> {
  const doc = await PDFDocument.create();
  const font = await embedTextFont(doc, FONT_BYTES);
  const layouts = CORPUS.map((entry) => {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    return drawTextBox(page, font, entry.text, {
      size: FONT_SIZE,
      width: entry.width ?? DEFAULT_WIDTH,
      direction: entry.direction,
      transform: uprightTransform(MARGIN, PAGE_HEIGHT - MARGIN),
    });
  });
  return { bytes: await doc.save(), layouts };
}

describe('golden corpus (pdf.js read-back)', () => {
  let layouts: TextLayout[];
  let pages: OraclePage[];

  beforeAll(async () => {
    const rendered = await renderCorpus();
    layouts = rendered.layouts;
    pages = await readPdf(rendered.bytes);
  });

  it.each(CORPUS.map((entry, index) => [entry.id, entry, index] as const))(
    '%s: glyphs appear in the right visual order',
    (_id, entry: CorpusEntry, index: number) => {
      const layout = layouts[index];
      expect(layout.missing).toEqual([]);
      expect(layout.direction).toBe(entry.id === 'english-punctuation' ? 'ltr' : 'rtl');
      if (entry.lines) {
        expect(layout.lines).toHaveLength(entry.lines);
        expect(layout.lines.map((l) => l.text).join(' ')).toBe(entry.text);
      }
      for (const line of layout.lines) expect(line.width).toBeLessThanOrEqual((entry.width ?? DEFAULT_WIDTH) + 0.01);

      const visual = visualLines(pages[index].glyphs, layout.lineHeight);
      expect(visual).toEqual(expectedVisual(entry.text, layout.lines.map((l) => l.text), layout.direction));
      if (entry.visual) expect(visual).toEqual(entry.visual);
    },
  );

  it.each(CORPUS.map((entry, index) => [entry.id, entry, index] as const))(
    '%s: every word is findable in the extracted text',
    (_id, entry: CorpusEntry, index: number) => {
      const extracted = new Set(searchWords(pages[index].text.join(' ')));
      const missing = searchWords(entry.text).filter((word) => !extracted.has(word));
      expect(missing, `extracted: ${pages[index].text.join(' / ')}`).toEqual([]);
    },
  );
});

const PRICE = 'المبلغ: ٤٥٠٫٧٥ ريال (شامل الضريبة ١٥٪)';
const PRICE_VISUAL = '(٪١٥ ةبيرضلا لماش) لاير ٤٥٠٫٧٥ :غلبملا';
const BOX = { size: FONT_SIZE, width: DEFAULT_WIDTH };
const topLeft = () => uprightTransform(MARGIN, PAGE_HEIGHT - MARGIN);
const leftmost = (page: OraclePage) => [...page.glyphs].sort((a, b) => a.x - b.x)[0];

describe('exporting twice from one font', () => {
  it('saving the same document again keeps lam-alef copy text and adds the new glyphs', async () => {
    const doc = await PDFDocument.create();
    const font = await embedTextFont(doc, FONT_BYTES);
    const first = drawTextBox(doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), font, 'السلام عليكم، لأن الإسلام لا', { ...BOX, transform: topLeft() });
    const once = await readPdf(await doc.save());

    drawTextBox(doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), font, 'لا إله إلا الله - Hello', { ...BOX, transform: topLeft() });
    const twice = await readPdf(await doc.save());

    expect(twice[0].glyphs).toEqual(once[0].glyphs);
    expect(visualLines(twice[0].glyphs, first.lineHeight)).toEqual(['ال مالسإلا نأل ،مكيلع مالسلا']);
    expect(visualLines(twice[1].glyphs, first.lineHeight)).toEqual(['Hello - هللا الإ هلإ ال']);
  });

  // Saving pulls the parts of composite glyphs into the subset (ح is part of
  // خ, د of ذ, e of é). Drawn after that save, those letters must still carry
  // their copy text: the same as drawing them in a fresh document.
  it.each([
    ['خ', 'ح'],
    ['ذ', 'د'],
    ['Café', 'Hello'],
    ['خذ صيغة الملف', 'حدد السطر والعمود'],
  ])('after saving %s, the letters in %s keep their copy text on the next save', async (first, second) => {
    const draw = (doc: PDFDocument, font: Awaited<ReturnType<typeof embedTextFont>>, text: string) =>
      drawTextBox(doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), font, text, { ...BOX, transform: topLeft() });

    const doc = await PDFDocument.create();
    const font = await embedTextFont(doc, FONT_BYTES);
    draw(doc, font, first);
    await doc.save();
    const layout = draw(doc, font, second);
    const page = (await readPdf(await doc.save()))[1];

    const fresh = await PDFDocument.create();
    draw(fresh, await embedTextFont(fresh, FONT_BYTES), second);
    const [control] = await readPdf(await fresh.save());

    for (const g of page.glyphs) expect(g.unicode, `cid ${g.cid}`).not.toBe('');
    expect(page.glyphs.map((g) => g.unicode)).toEqual(control.glyphs.map((g) => g.unicode));
    expect(visualLines(page.glyphs, layout.lineHeight)).toEqual(expectedVisual(second, [second], layout.direction));
  });

  it('one layout font drawn into two documents gives the same PDF text both times and is left untouched', async () => {
    const layoutFont = createLayoutFont(FONT_BYTES);
    const layout = layoutText(layoutFont, 'لا تنسَ التوقيع (لأن الطلب لا يكتمل)', { size: FONT_SIZE, maxWidth: DEFAULT_WIDTH });
    const ligatures = layout.lines[0].glyphs.filter((g) => g.glyph.codePoints.length > 1);
    expect(ligatures.length).toBeGreaterThan(0);
    const before = ligatures.map((g) => [...g.glyph.codePoints]);

    const reads: OraclePage[] = [];
    for (let run = 0; run < 2; run++) {
      const doc = await PDFDocument.create();
      const font = await embedTextFont(doc, FONT_BYTES);
      drawLayout(doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), font, layout, { ...BOX, transform: topLeft() });
      reads.push((await readPdf(await doc.save()))[0]);
    }
    expect(reads[1].glyphs).toEqual(reads[0].glyphs);
    expect(visualLines(reads[1].glyphs, layout.lineHeight)).toEqual(['(لمتكي ال بلطلا نأل) عيقوتلا سنت ال']);
    // fontkit caches one Glyph per id for the font's lifetime: its code points must stay in logical order.
    expect(ligatures.map((g) => g.glyph.codePoints)).toEqual(before);
    for (const codePoints of before) expect(codePoints[0]).toBe(0x644); // lam first
  });
});

describe('mark positioning (GPOS)', () => {
  // The corpus checks order with the marks left out, so this checks where the
  // harakat land: fontkit's mark offsets have to reach the PDF.
  it('kasra sits below the baseline, fatha, shadda and sukun above it, and no mark starts where a letter does', async () => {
    const doc = await PDFDocument.create();
    const font = await embedTextFont(doc, FONT_BYTES);
    const layout = drawTextBox(doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), font, 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', { ...BOX, transform: topLeft() });
    const [page] = await readPdf(await doc.save());
    expect(layout.lines).toHaveLength(1);

    const baseline = MARGIN + layout.baseline; // display space, y down
    const isMark = (g: { unicode: string }) => /^[\u064B-\u0652\u0670]+$/.test(g.unicode);
    const below = page.glyphs.filter((g) => g.unicode === '\u0650');
    const above = page.glyphs.filter((g) => isMark(g) && /[\u064E\u0651\u0652]/.test(g.unicode));
    const letters = page.glyphs.filter((g) => !isMark(g));
    expect(below.length).toBeGreaterThan(3);
    expect(above.length).toBeGreaterThan(3);
    for (const g of below) expect(g.y).toBeGreaterThan(baseline + 0.05 * FONT_SIZE);
    for (const g of above) expect(g.y).toBeLessThan(baseline - 0.02 * FONT_SIZE);
    for (const mark of [...below, ...above]) {
      expect(letters.some((letter) => Math.abs(letter.x - mark.x) < 0.01), `${mark.unicode} at x ${mark.x}`).toBe(false);
    }
  });
});

describe('rotated pages', () => {
  // Box top-left at (MARGIN, MARGIN) from the displayed top-left corner, in unrotated page coordinates.
  const origins: Record<number, [number, number]> = {
    0: [MARGIN, PAGE_HEIGHT - MARGIN],
    90: [MARGIN, MARGIN],
    180: [PAGE_WIDTH - MARGIN, MARGIN],
    270: [PAGE_HEIGHT - MARGIN, PAGE_WIDTH - MARGIN],
  };

  it.each([0, 90, 180, 270])('text stays upright and in reading order on a page with /Rotate %i', async (rotation) => {
    const doc = await PDFDocument.create();
    const font = await embedTextFont(doc, FONT_BYTES);
    const page = doc.addPage(rotation % 180 ? [PAGE_HEIGHT, PAGE_WIDTH] : [PAGE_WIDTH, PAGE_HEIGHT]);
    page.setRotation(degrees(rotation));
    const [x, y] = origins[rotation];
    const layout = drawTextBox(page, font, PRICE, { ...BOX, transform: uprightTransform(x, y, rotation) });
    const [read] = await readPdf(await doc.save());

    expect([read.width, read.height]).toEqual([PAGE_WIDTH, PAGE_HEIGHT]);
    for (const g of read.glyphs) {
      expect(g.dx).toBeCloseTo(1, 9);
      expect(g.dy).toBeCloseTo(0, 9);
    }
    expect(visualLines(read.glyphs, layout.lineHeight)).toEqual([PRICE_VISUAL]);
    // RTL + align start: the line ends at the box's right edge; the baseline sits `baseline` below the top.
    const line = layout.lines[0];
    const first = leftmost(read);
    expect(first.x).toBeCloseTo(MARGIN + DEFAULT_WIDTH - line.width + line.glyphs[0].x, 3);
    expect(first.y).toBeCloseTo(MARGIN + layout.baseline - line.glyphs[0].y, 3);
  });
});

describe('alignment, direction and colour', () => {
  it.each([
    ['ltr', 'start', 'left'],
    ['ltr', 'end', 'right'],
    ['ltr', 'center', 'center'],
    ['rtl', 'start', 'right'],
    ['rtl', 'end', 'left'],
    ['rtl', 'center', 'center'],
  ] as const)('%s box, align %s puts the line at the %s', async (direction, align, edge) => {
    const doc = await PDFDocument.create();
    const font = await embedTextFont(doc, FONT_BYTES);
    const text = direction === 'rtl' ? 'مرحبا بكم في BlendPDF' : 'Welcome to BlendPDF';
    const layout = drawTextBox(doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), font, text, { ...BOX, align, transform: topLeft() });
    expect(layout.direction).toBe(direction);
    const [read] = await readPdf(await doc.save());
    const line = layout.lines[0];
    const slack = DEFAULT_WIDTH - line.width;
    const expectedLeft = MARGIN + (edge === 'left' ? 0 : edge === 'right' ? slack : slack / 2);
    expect(leftmost(read).x - line.glyphs[0].x).toBeCloseTo(expectedLeft, 3);
  });

  it('auto direction follows the first strong character; an explicit one overrides it', async () => {
    const font = createLayoutFont(FONT_BYTES);
    const hello = 'Hello (world)!';
    expect(layoutText(font, hello, { size: 12 }).direction).toBe('ltr');
    expect(layoutText(font, hello, { size: 12, direction: 'rtl' }).direction).toBe('rtl');

    const doc = await PDFDocument.create();
    const embedded = await embedTextFont(doc, FONT_BYTES);
    const cases = [
      { text: hello, direction: 'rtl' as const, visual: '!Hello (world)' },
      // W2: 2026 after Arabic letters is an Arabic number, so the whole line runs right to left.
      { text: 'مرحبا (بكم) 2026', direction: 'ltr' as const, visual: '2026 (مكب) ابحرم' },
    ];
    const layouts = cases.map((c) =>
      drawTextBox(doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), embedded, c.text, { ...BOX, direction: c.direction, transform: topLeft() }),
    );
    const read = await readPdf(await doc.save());
    cases.forEach((c, i) => {
      expect(visualLines(read[i].glyphs, layouts[i].lineHeight)).toEqual([c.visual]);
      expect([c.visual]).toEqual(expectedVisual(c.text, [c.text], c.direction));
    });
  });

  it('resolves auto from the first strong character outside isolates, after an RLM, and falls back to LTR', () => {
    const LRI = String.fromCharCode(0x2066);
    const PDI = String.fromCharCode(0x2069);
    expect(resolveDirection(`${RLM}123 abc`)).toBe('rtl');
    expect(resolveDirection('١٢٣ 456 !')).toBe('ltr');
    expect(resolveDirection(`${LRI}PDF${PDI} ملف`)).toBe('rtl');
    expect(resolveDirection('\n  مرحبا Hello')).toBe('rtl');
    expect(resolveDirection('مرحبا', 'ltr')).toBe('ltr');
  });

  it('paints in the requested colour and does not leak it to later drawing', async () => {
    const doc = await PDFDocument.create();
    const font = await embedTextFont(doc, FONT_BYTES);
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawTextBox(page, font, 'أحمر', { ...BOX, color: rgb(0.8, 0.1, 0.1), transform: topLeft() });
    drawTextBox(page, font, 'أسود', { ...BOX, transform: uprightTransform(MARGIN, MARGIN + 40) });
    const [read] = await readPdf(await doc.save());
    const red = read.glyphs.filter((g) => g.y < PAGE_HEIGHT / 2);
    const black = read.glyphs.filter((g) => g.y > PAGE_HEIGHT / 2);
    expect(red.length).toBeGreaterThan(0);
    expect(black.length).toBeGreaterThan(0);
    for (const g of red) expect(g.fill).toEqual([204, 26, 26]);
    for (const g of black) expect(g.fill).toEqual([0, 0, 0]);
  });
});

describe('each paragraph takes its own direction', () => {
  const font = createLayoutFont(FONT_BYTES);
  const directions = (layout: TextLayout) => layout.lines.map((l) => l.direction);

  it('resolves paragraphs like a textarea with dir="auto": own strong character, else neighbours, else the fallback', () => {
    expect(resolveParagraphDirections(['مرحبا', 'Hello'], 'auto', 'ltr')).toEqual(['rtl', 'ltr']);
    expect(resolveParagraphDirections(['Hello', 'مرحبا'], 'auto', 'ltr')).toEqual(['ltr', 'rtl']);
    // No strong character: the nearest paragraph before it, else the nearest one after it.
    expect(resolveParagraphDirections(['مرحبا', '2026', 'شكرا'], 'auto', 'ltr')).toEqual(['rtl', 'rtl', 'rtl']);
    expect(resolveParagraphDirections(['Hello', '', '١٢٣', 'مرحبا'], 'auto', 'rtl')).toEqual(['ltr', 'ltr', 'ltr', 'rtl']);
    expect(resolveParagraphDirections(['123', '', 'مرحبا', 'Hi'], 'auto', 'ltr')).toEqual(['rtl', 'rtl', 'rtl', 'ltr']);
    // None anywhere: the UI locale's direction.
    expect(resolveParagraphDirections(['123', '(4)'], 'auto', 'rtl')).toEqual(['rtl', 'rtl']);
    expect(resolveParagraphDirections(['123', '(4)'], 'auto', 'ltr')).toEqual(['ltr', 'ltr']);
    // An RLM is a strong character; an isolate is skipped.
    expect(resolveParagraphDirections([`${RLM}123`, `${String.fromCharCode(0x2066)}PDF${String.fromCharCode(0x2069)} ملف`], 'auto', 'ltr')).toEqual(['rtl', 'rtl']);
    // An explicit direction forces every paragraph.
    expect(resolveParagraphDirections(['مرحبا', 'Hello'], 'ltr', 'rtl')).toEqual(['ltr', 'ltr']);
    expect(resolveParagraphDirections(['Hello', 'مرحبا'], 'rtl', 'ltr')).toEqual(['rtl', 'rtl']);
  });

  it('lays out "مرحبا / Hello" as an RTL line then an LTR line, and keeps the box direction as the first paragraph\'s', () => {
    const layout = layoutText(font, 'مرحبا\nHello', { size: 16, maxWidth: 300 });
    expect(directions(layout)).toEqual(['rtl', 'ltr']);
    expect(layout.direction).toBe('rtl');
    expect(directions(layoutText(font, 'مرحبا\n2026\nشكرا', { size: 16 }))).toEqual(['rtl', 'rtl', 'rtl']);
    expect(directions(layoutText(font, '2026\n(15)', { size: 16 }))).toEqual(['ltr', 'ltr']);
    expect(directions(layoutText(font, '2026\n(15)', { size: 16, fallbackDirection: 'rtl' }))).toEqual(['rtl', 'rtl']);
    expect(directions(layoutText(font, 'مرحبا\nHello', { size: 16, direction: 'ltr' }))).toEqual(['ltr', 'ltr']);
    // A wrapped paragraph: every line of it has the paragraph's direction.
    const wrapped = layoutText(font, `Note\n${'يرجى تعبئة هذا النموذج بالكامل '.repeat(4)}`, { size: 16, maxWidth: 200 });
    expect(wrapped.lines.length).toBeGreaterThan(3);
    expect(directions(wrapped)).toEqual(['ltr', ...wrapped.lines.slice(1).map(() => 'rtl')]);
  });

  it('in the PDF, the Arabic paragraph ends at the box\'s right edge and the English one starts at its left edge', async () => {
    const doc = await PDFDocument.create();
    const embedded = await embedTextFont(doc, FONT_BYTES);
    const text = 'مرحبا بكم\nHello there\n2026/10/14';
    const layout = drawTextBox(doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), embedded, text, { ...BOX, transform: topLeft() });
    const [read] = await readPdf(await doc.save());
    expect(directions(layout)).toEqual(['rtl', 'ltr', 'ltr']);

    const lineOf = (y: number) => Math.floor((y - MARGIN) / layout.lineHeight);
    const left = (index: number) => Math.min(...read.glyphs.filter((g) => lineOf(g.y) === index).map((g) => g.x));
    expect(visualLines(read.glyphs, layout.lineHeight)).toEqual(['مكب ابحرم', 'Hello there', '2026/10/14']);
    const [arabic, english, digits] = layout.lines;
    expect(left(0)).toBeCloseTo(MARGIN + DEFAULT_WIDTH - arabic.width + arabic.glyphs[0].x, 3);
    expect(left(1)).toBeCloseTo(MARGIN + english.glyphs[0].x, 3);
    // Digits only: follows the English paragraph before it, so it starts at the left edge too.
    expect(left(2)).toBeCloseTo(MARGIN + digits.glyphs[0].x, 3);
  });
});

describe('input handling', () => {
  const font = createLayoutFont(FONT_BYTES);
  const ZWJ = String.fromCharCode(0x200d);
  const BOM = String.fromCharCode(0xfeff);

  it('strips bidi controls after they have set the levels', () => {
    const paragraph = analyzeParagraph(`${RLM}تم الدفع 250${RLM}`, 'rtl');
    expect(paragraph.text).toBe('تم الدفع 250');
    expect(paragraph.levels).toHaveLength(paragraph.text.length);
  });

  it('ZWNJ breaks the join and leaves no space glyph behind', () => {
    const split = layoutText(font, `می${ZWNJ}خواهم`, { size: 16 }).lines[0];
    const joined = layoutText(font, 'میخواهم', { size: 16 }).lines[0];
    expect(split.glyphs.map((g) => g.glyph.id)).not.toEqual(joined.glyphs.map((g) => g.glyph.id));
    expect(split.glyphs).toHaveLength(joined.glyphs.length);
    expect(split.glyphs.some((g) => g.glyph.codePoints.some((cp) => cp === 0x20 || cp === 0x200c))).toBe(false);
  });

  it('ZWJ gives a letter its joining form, also when bidi puts the ZWJ in the next run', () => {
    const beh = (text: string, direction: 'ltr' | 'rtl') => {
      const line = layoutText(font, text, { size: 16, direction }).lines[0];
      return { id: line.glyphs.find((g) => g.glyph.codePoints.includes(0x628))!.glyph.id, count: line.glyphs.length };
    };
    const isolated = beh('ب', 'rtl').id;
    const initial = beh(`ب${ZWJ}`, 'rtl').id;
    const final = beh(`${ZWJ}ب`, 'rtl').id;
    expect(new Set([isolated, initial, final]).size).toBe(3);

    // In an LTR box, bidi gives these ZWJs the level of the space or Latin text beside them.
    expect(beh(`Hello ب${ZWJ} world`, 'ltr')).toEqual({ id: initial, count: beh('Hello ب world', 'ltr').count });
    expect(beh(`Hello ${ZWJ}ب world`, 'ltr')).toEqual({ id: final, count: beh('Hello ب world', 'ltr').count });
    expect(beh(`BlendPDF${ZWJ}ب`, 'ltr').id).toBe(final);
    expect(beh(`مرحبا ب${ZWJ} يا`, 'rtl').id).toBe(initial);
  });

  it('shapes the same whatever an earlier box left in fontkit\'s glyph cache', () => {
    const glyphIds = (layout: TextLayout) => layout.lines.map((l) => l.glyphs.map((g) => g.glyph.id));
    const persian = `می${ZWNJ}خواهم`;
    const joined = `ب${ZWJ}`;
    const both = `${joined} ${persian}`;
    // Every character the font lacks is glyph 0 to fontkit: ZWJ, ZWNJ and the emoji share one cache entry.
    const orders: Array<[string, string]> = [
      ['سلام 😀', persian],
      [persian, joined],
      [joined, persian],
      ['سلام 😀', both],
    ];
    for (const [earlier, later] of orders) {
      const shared = createLayoutFont(FONT_BYTES);
      layoutText(shared, earlier, { size: 16 });
      const after = layoutText(shared, later, { size: 16 });
      const control = layoutText(createLayoutFont(FONT_BYTES), later, { size: 16 });
      expect(after.missing, `${earlier} then ${later}`).toEqual([]);
      expect(glyphIds(after), `${earlier} then ${later}`).toEqual(glyphIds(control));
    }
    const control = createLayoutFont(FONT_BYTES);
    expect(glyphIds(layoutText(control, both, { size: 16 }))[0]).toEqual([
      ...glyphIds(layoutText(control, persian, { size: 16 }))[0],
      control.glyphForCodePoint(0x20).id,
      ...glyphIds(layoutText(control, joined, { size: 16, direction: 'rtl' }))[0],
    ]);

    // Reading a composite glyph's outline caches its parts with no code points (ح is part of خ).
    const outlined = createLayoutFont(FONT_BYTES);
    void layoutText(outlined, 'خ', { size: 16 }).lines[0].glyphs[0].glyph.path;
    expect(glyphIds(layoutText(outlined, 'بح حب', { size: 16 }))).toEqual(glyphIds(layoutText(createLayoutFont(FONT_BYTES), 'بح حب', { size: 16 })));
  });

  it('does not count bidi controls, ZWNJ, ZWJ or the BOM as missing glyphs', () => {
    const controls = [0x200e, 0x200f, 0x061c, 0x202b, 0x202c, 0x2066, 0x2069].map((cp) => String.fromCharCode(cp)).join('');
    expect(findMissingCharacters(font, `${controls}${ZWNJ}${ZWJ}${BOM}abc ب`)).toEqual([]);
  });

  it('draws spaces the font lacks (thin, narrow no-break) and tabs as plain spaces', () => {
    const thin = String.fromCharCode(0x2009);
    const narrow = String.fromCharCode(0x202f);
    const layout = layoutText(font, `a${thin}b${narrow}c\td`, { size: 12 });
    expect(layout.missing).toEqual([]);
    expect(layout.lines[0].text).toBe('a b c d');
  });

  it('reports characters the font cannot draw and refuses to write that box', async () => {
    const text = `مرحبا 😀 中文 ${RLM}${ZWNJ}`;
    expect(layoutText(font, text, { size: 12 }).missing).toEqual(['😀', '中', '文']);

    const doc = await PDFDocument.create();
    const embedded = await embedTextFont(doc, FONT_BYTES);
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let error: unknown;
    try {
      drawTextBox(page, embedded, text, { ...BOX, transform: topLeft() });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MissingGlyphsError);
    expect((error as MissingGlyphsError).characters).toEqual(['😀', '中', '文']);
    const [read] = await readPdf(await doc.save());
    expect(read.glyphs).toEqual([]);
  });

  it('keeps blank lines and breaks an over-long word between graphemes', () => {
    const blank = layoutText(font, 'سطر أول\n\nسطر ثالث', { size: 12, maxWidth: 200 });
    expect(blank.lines.map((l) => l.text)).toEqual(['سطر أول', '', 'سطر ثالث']);
    expect(blank.height).toBeCloseTo(3 * blank.lineHeight, 9);

    const word = 'BlendPDFBlendPDFBlendPDF';
    const broken = layoutText(font, word, { size: 16, maxWidth: 60 });
    expect(broken.lines.length).toBeGreaterThan(2);
    expect(broken.lines.map((l) => l.text).join('')).toBe(word);
    for (const line of broken.lines) expect(line.width).toBeLessThanOrEqual(60);
  });
});
