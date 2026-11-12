/**
 * Paragraph layout: normalise the input, resolve bidi per paragraph, break
 * lines by width on the LOGICAL text, then reorder each line into display
 * order and position every glyph. Pure (no PDF involved), so an on-screen
 * preview and the PDF writer can get the same line breaks from the same code.
 *
 * Font stack: layoutText takes one font or several. With several, each
 * grapheme cluster is drawn by the first font that has every one of its code
 * points (default-ignorables need none), and consecutive clusters with the
 * same font inside one bidi level run are shaped together, so a word's
 * Arabic letters always join within one font. A single font goes through
 * exactly the same arithmetic as before the stack existed (byte-identical
 * PDFs): its pen is kept in font units and scaled once.
 */
import type { Font, Glyph } from '@pdf-lib/fontkit';
import { analyzeParagraph, levelRuns, resolveParagraphDirections, visualRuns } from './bidi';
import { DEFAULT_LINE_HEIGHT } from './constants';
import type { BaseDirection, BidiParagraph, ResolvedDirection } from './bidi';
import { advanceOf, findMissingCharacters, isDefaultIgnorable, shapeRun } from './shaping';
import { isBidiControl } from './bidi';

export interface TextLayoutOptions {
  /** Font size in points. */
  size: number;
  /** Wrap width in points. Leave out (or pass Infinity) to keep each paragraph on one line. */
  maxWidth?: number;
  /**
   * Base direction. Default 'auto': each paragraph follows its own first
   * strong character, like a textarea with dir="auto"; a paragraph with none
   * follows its neighbours (see resolveParagraphDirections). 'ltr' or 'rtl'
   * forces every paragraph.
   */
  direction?: BaseDirection;
  /** Direction for a box with no strong character at all under 'auto'. Default 'ltr'. */
  fallbackDirection?: ResolvedDirection;
  /** Line pitch as a multiple of `size`, like CSS line-height. Default 1.6. */
  lineHeight?: number;
}

/** One font, or a stack of fonts tried in order per grapheme cluster (the first is the primary font). */
export type FontStack = Font | readonly Font[];

/** The stack as an array (a single Font is a stack of one). */
export function fontsOf(stack: FontStack): readonly Font[] {
  return Array.isArray(stack) ? (stack as readonly Font[]) : [stack as Font];
}

/** A glyph placed on a line, in points: x from the line's left edge, y up from its baseline. */
export interface LaidOutGlyph {
  glyph: Glyph;
  x: number;
  y: number;
  /** Index of the glyph's font in the stack (0 for a single font). */
  font: number;
}

export interface LaidOutLine {
  /** The line's characters in logical order (bidi controls removed, trailing spaces dropped). */
  text: string;
  /** Its paragraph's direction. The line aligns by it ('start' is the right edge of an RTL line). */
  direction: ResolvedDirection;
  /** Advance width in points. */
  width: number;
  /** Glyphs in display order, left to right. */
  glyphs: LaidOutGlyph[];
}

export interface TextLayout {
  /**
   * The FIRST paragraph's direction ('auto' resolved), a box-level summary
   * only. Paragraphs can differ: each line carries its own direction, and
   * alignment follows that.
   */
  direction: ResolvedDirection;
  size: number;
  /** Distance between consecutive baselines, in points. */
  lineHeight: number;
  /** From the top of a line box down to its baseline, in points (CSS half-leading model). */
  baseline: number;
  lines: LaidOutLine[];
  /** Widest line, in points. */
  width: number;
  /** lines.length * lineHeight, in points. */
  height: number;
  /**
   * Characters no font of the stack can draw. When this is not empty the box
   * cannot be written as vector text: add a font that has them to the stack,
   * or draw that box some other way (as an image, say).
   */
  missing: string[];
}

// Space separators that should behave like a plain space. Any the font lacks
// (thin space, narrow no-break space...) is drawn as U+0020 rather than sending
// the whole box to the image fallback. Tabs become a single space too.
const SPACE_LIKE = /[\t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
const LINE_BREAKS = /\r\n|[\r\u0085\u2028\u2029]/g;

/** The input exactly as layout sees it: "\n" for every paragraph break, tabs and unsupported spaces as " ". */
export function normalizeText(font: Font, text: string): string {
  return text
    .replace(LINE_BREAKS, '\n')
    .replace(SPACE_LIKE, (ch) => (ch !== '\t' && font.hasGlyphForCodePoint(ch.codePointAt(0)!) ? ch : ' '));
}

interface ParagraphContext {
  fonts: readonly Font[];
  paragraph: BidiParagraph;
  /** Font units to points, per font of the stack. */
  scales: readonly number[];
  /** Font index per code unit of paragraph.text (all 0 for a single font). */
  fontAt: Uint8Array;
}

/** Runs of one font inside [start, end), in logical order. */
function fontRuns(ctx: ParagraphContext, start: number, end: number): Array<{ start: number; end: number; font: number }> {
  const runs: Array<{ start: number; end: number; font: number }> = [];
  for (let i = start; i < end; ) {
    let j = i + 1;
    while (j < end && ctx.fontAt[j] === ctx.fontAt[i]) j++;
    runs.push({ start: i, end: j, font: ctx.fontAt[i] });
    i = j;
  }
  return runs;
}

/** Code points a cluster needs a glyph for (line breaks, bidi controls and default-ignorables need none). */
function needsGlyph(cp: number): boolean {
  return cp !== 0x0a && !isBidiControl(cp) && !isDefaultIgnorable(cp);
}

/**
 * The font of every code unit: per grapheme cluster, the first font of the
 * stack that has all of its code points; none has them all: the primary
 * font (the character is reported missing). A cluster that needs no glyph
 * (a lone ZWJ) keeps the font before it, so it stays in its letter's run.
 */
function assignFonts(fonts: readonly Font[], text: string): Uint8Array {
  const fontAt = new Uint8Array(text.length);
  if (fonts.length < 2) return fontAt;
  let previous = 0;
  let start = 0;
  for (const end of graphemeBoundaries(text, 0, text.length)) {
    const cps: number[] = [];
    for (const ch of text.slice(start, end)) {
      const cp = ch.codePointAt(0)!;
      if (needsGlyph(cp)) cps.push(cp);
    }
    let font = previous;
    if (cps.length > 0) {
      const found = fonts.findIndex((f) => cps.every((cp) => f.hasGlyphForCodePoint(cp)));
      font = found < 0 ? 0 : found;
    }
    fontAt.fill(font, start, end);
    previous = font;
    start = end;
  }
  return fontAt;
}

const ZWJ = '\u200d';

/**
 * What to shape for one level run: its mirrored text, plus a ZWJ that sits
 * just outside the run. bidi often gives a ZWJ next to a space the space's
 * level, which puts it in a different run from the letter it asks to join,
 * and fontkit only sees the run it is given (HarfBuzz would get it as
 * context). The extra ZWJ is dropped after shaping like any other
 * default-ignorable, so it only changes the letter's form.
 */
function runText(paragraph: BidiParagraph, start: number, end: number): string {
  let text = paragraph.shapingText.slice(start, end);
  if (start > 0 && paragraph.text[start - 1] === ZWJ) text = ZWJ + text;
  if (end < paragraph.text.length && paragraph.text[end] === ZWJ) text += ZWJ;
  return text;
}

/**
 * Shaped advance of [start, end) of the paragraph, in points. Advances add up
 * in font units while the font stays the same and are scaled once per font
 * change (once in all for a single font).
 */
function measure(ctx: ParagraphContext, start: number, end: number): number {
  const { fonts, paragraph, scales } = ctx;
  let base = 0;
  let width = 0;
  let current = -1;
  for (const run of levelRuns(paragraph.levels, start, end)) {
    for (const part of fontRuns(ctx, run.start, run.end)) {
      if (part.font !== current) {
        if (current >= 0) base += width * scales[current];
        width = 0;
        current = part.font;
      }
      width += advanceOf(shapeRun(fonts[part.font], runText(paragraph, part.start, part.end), run.level % 2 === 1));
    }
  }
  return current < 0 ? 0 : base + width * scales[current];
}

/** Break opportunities: after a space or a zero-width space. A no-break space never breaks. */
function isBreakSpace(unit: number): boolean {
  return unit === 0x20 || unit === 0x200b;
}

interface Segment {
  start: number;
  /** End of the word, before its trailing spaces. */
  contentEnd: number;
  end: number;
}

function segmentsOf(text: string): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < text.length; ) {
    let j = i;
    while (j < text.length && !isBreakSpace(text.charCodeAt(j))) j++;
    const contentEnd = j;
    while (j < text.length && isBreakSpace(text.charCodeAt(j))) j++;
    segments.push({ start: i, contentEnd, end: j });
    i = j;
  }
  return segments;
}

/** Grapheme cluster boundaries inside (start, end], so a word is never split between a letter and its marks. */
function graphemeBoundaries(text: string, start: number, end: number): number[] {
  const slice = text.slice(start, end);
  const out: number[] = [];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    for (const { index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(slice)) {
      if (index > 0) out.push(start + index);
    }
  } else {
    let offset = 0;
    for (const ch of slice) {
      offset += ch.length;
      if (offset < slice.length) out.push(start + offset);
    }
  }
  out.push(end);
  return out;
}

/** A single word wider than the box: cut it between graphemes into pieces that each fit (at least one grapheme each). */
function splitOverlongWord(ctx: ParagraphContext, start: number, end: number, maxWidth: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let pieceStart = start;
  let last = -1;
  for (const boundary of graphemeBoundaries(ctx.paragraph.text, start, end)) {
    if (last > pieceStart && measure(ctx, pieceStart, boundary) > maxWidth) {
      pieces.push([pieceStart, last]);
      pieceStart = last;
    }
    last = boundary;
  }
  pieces.push([pieceStart, end]);
  return pieces;
}

/**
 * Greedy line breaking on the logical text. Each candidate line is shaped and
 * measured as a whole, so the width test sees exactly what will be drawn
 * (contextual forms, ligatures, kerning). Returns [start, end) per line with
 * the trailing spaces left out.
 */
function breakParagraph(ctx: ParagraphContext, maxWidth: number): Array<[number, number]> {
  const segments = segmentsOf(ctx.paragraph.text);
  if (segments.length === 0) return [[0, 0]];
  if (!Number.isFinite(maxWidth)) return [[0, segments[segments.length - 1].contentEnd]];

  const lines: Array<[number, number]> = [];
  let lineStart = segments[0].start;
  let lineEnd = -1; // contentEnd of the last word on the current line; -1 while the line is empty
  for (const segment of segments) {
    if (lineEnd >= 0 && measure(ctx, lineStart, segment.contentEnd) > maxWidth) {
      lines.push([lineStart, lineEnd]);
      lineStart = segment.start;
      lineEnd = -1;
    }
    if (lineEnd < 0 && measure(ctx, segment.start, segment.contentEnd) > maxWidth) {
      const pieces = splitOverlongWord(ctx, segment.start, segment.contentEnd, maxWidth);
      for (let p = 0; p < pieces.length - 1; p++) lines.push(pieces[p]);
      lineStart = pieces[pieces.length - 1][0];
    }
    lineEnd = segment.contentEnd;
  }
  lines.push([lineStart, lineEnd]);
  return lines;
}

/**
 * Reorder one line into display runs (L2), shape each run in its own
 * direction and place the glyphs. Inside a right-to-left run the font runs
 * go right to left too (the later one sits further left). The pen is kept in
 * the current font's units over `base` points, so a single font is placed
 * with exactly the arithmetic it always had.
 */
function buildLine(ctx: ParagraphContext, start: number, end: number, direction: ResolvedDirection, missing: string[]): LaidOutLine {
  const { fonts, paragraph, scales } = ctx;
  const glyphs: LaidOutGlyph[] = [];
  let base = 0;
  let pen = 0;
  let current = -1;
  for (const run of visualRuns(paragraph.levels, start, end)) {
    const rtl = run.level % 2 === 1;
    const parts = fontRuns(ctx, run.start, run.end);
    if (rtl) parts.reverse();
    for (const part of parts) {
      if (part.font !== current) {
        if (current >= 0) base += pen * scales[current];
        pen = 0;
        current = part.font;
      }
      const scale = scales[current];
      const shaped = shapeRun(fonts[current], runText(paragraph, part.start, part.end), rtl);
      for (const g of shaped) {
        // .notdef only survives shaping in a run with a character the font
        // lacks, which findMissingCharacters has already listed. Its code points
        // come from fontkit's cache (any earlier missing character), so they are
        // not reported; this only makes sure .notdef is never written.
        if (g.glyph.id === 0 && missing.length === 0) missing.push('\ufffd');
        glyphs.push({ glyph: g.glyph, x: base + (pen + g.xOffset) * scale, y: g.yOffset * scale, font: current });
        pen += g.xAdvance;
      }
    }
  }
  const width = current < 0 ? 0 : base + pen * scales[current];
  return { text: paragraph.text.slice(start, end), direction, width, glyphs };
}

/**
 * Lay out a text box. `fonts` is a fontkit font (or a stack of them, primary
 * first): createLayoutFont() instances, never the ones inside pdf-lib's
 * subsetter (see embedTextFont). The primary font sets the line metrics and
 * the space-like normalisation.
 */
export function layoutText(fonts: FontStack, text: string, options: TextLayoutOptions): TextLayout {
  const { size } = options;
  if (!(size > 0) || !Number.isFinite(size)) throw new RangeError('size must be a positive number of points');
  const stack = fontsOf(fonts);
  if (stack.length === 0) throw new RangeError('layoutText needs at least one font');
  const font = stack[0];
  const maxWidth = options.maxWidth ?? Infinity;
  const scale = size / font.unitsPerEm;
  const scales = stack.map((f) => size / f.unitsPerEm);

  const normalized = normalizeText(font, text);
  const paragraphs = normalized.split('\n');
  const directions = resolveParagraphDirections(paragraphs, options.direction ?? 'auto', options.fallbackDirection ?? 'ltr');
  const missing = findMissingCharacters(stack, normalized);

  const lines: LaidOutLine[] = [];
  paragraphs.forEach((raw, index) => {
    const direction = directions[index];
    const paragraph = analyzeParagraph(raw, direction);
    const ctx: ParagraphContext = { fonts: stack, paragraph, scales, fontAt: assignFonts(stack, paragraph.text) };
    for (const [start, end] of breakParagraph(ctx, maxWidth)) lines.push(buildLine(ctx, start, end, direction, missing));
  });

  const lineHeight = (options.lineHeight ?? DEFAULT_LINE_HEIGHT) * size;
  const ascent = font.ascent * scale;
  const descent = font.descent * scale; // negative
  const baseline = (lineHeight - (ascent - descent)) / 2 + ascent;

  return {
    direction: directions[0],
    size,
    lineHeight,
    baseline,
    lines,
    width: lines.reduce((w, line) => Math.max(w, line.width), 0),
    height: lines.length * lineHeight,
    missing,
  };
}
