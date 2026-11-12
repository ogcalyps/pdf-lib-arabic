/**
 * Unicode Bidirectional Algorithm (UAX #9) for one text box, on top of bidi-js.
 *
 * bidi-js resolves embedding levels for a paragraph. This file adds what a
 * PDF writer needs around that: each paragraph's base direction, removing
 * the invisible bidi controls once they have done their job, bracket
 * mirroring and the per-line reordering of level runs into display order
 * (rules L1-L4).
 */
import bidiFactory from 'bidi-js';

type Bidi = ReturnType<typeof bidiFactory>;

let bidiInstance: Bidi | null = null;

/** bidi-js builds its lookup tables when the factory runs, so build them once, on first use. */
export function getBidi(): Bidi {
  if (!bidiInstance) bidiInstance = bidiFactory();
  return bidiInstance;
}

/** What the box asks for. 'auto' gives each paragraph its first strong character's direction, like a textarea with dir="auto". */
export type BaseDirection = 'auto' | 'ltr' | 'rtl';
export type ResolvedDirection = 'ltr' | 'rtl';

/**
 * Explicit bidi formatting characters: ALM, LRM, RLM, the embeddings and
 * overrides (U+202A-202E) and the isolates (U+2066-2069). Arabic pasted from
 * WhatsApp or Word often carries RLM. Fonts rarely have a glyph for them and
 * fontkit would draw RLM as a space, so they steer the algorithm and are then
 * removed before shaping.
 */
export function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * The direction of the first strong character outside an isolate (UAX #9
 * P2-P3), or null when the text has none (digits, punctuation, spaces only).
 * Bidi controls count: an RLM makes the text RTL.
 */
export function firstStrongDirection(text: string): ResolvedDirection | null {
  const bidi = getBidi();
  let isolateDepth = 0;
  for (const ch of text) {
    const type = bidi.getBidiCharTypeName(ch);
    if (type === 'LRI' || type === 'RLI' || type === 'FSI') {
      isolateDepth++;
    } else if (type === 'PDI') {
      if (isolateDepth > 0) isolateDepth--;
    } else if (isolateDepth === 0) {
      if (type === 'L') return 'ltr';
      if (type === 'R' || type === 'AL') return 'rtl';
    }
  }
  return null;
}

/**
 * One direction for a whole string. An explicit 'ltr'/'rtl' wins; 'auto'
 * takes the first strong character of the whole text (outside isolates),
 * LTR when there is none. Text layout resolves each paragraph on its own
 * (resolveParagraphDirections); this is for callers that need a single answer.
 */
export function resolveDirection(text: string, direction: BaseDirection = 'auto'): ResolvedDirection {
  if (direction === 'ltr' || direction === 'rtl') return direction;
  return firstStrongDirection(text) ?? 'ltr';
}

/**
 * The direction of each paragraph of a box, the way a <textarea dir="auto">
 * shows it (its UA style is unicode-bidi: plaintext, so every paragraph
 * follows its own first strong character).
 *
 * - An explicit 'ltr'/'rtl' applies to every paragraph.
 * - 'auto': each paragraph takes its first strong character (UAX #9 P2-P3).
 *   A paragraph with none (digits only, an empty line) follows its
 *   neighbours: the nearest paragraph before it that has one, else the
 *   nearest one after it, else `fallback` (your UI's direction, say).
 */
export function resolveParagraphDirections(
  paragraphs: readonly string[],
  direction: BaseDirection,
  fallback: ResolvedDirection,
): ResolvedDirection[] {
  if (direction === 'ltr' || direction === 'rtl') return paragraphs.map(() => direction);
  const own = paragraphs.map(firstStrongDirection);
  const firstStrong = own.find((d): d is ResolvedDirection => d !== null) ?? fallback;
  let previous: ResolvedDirection | null = null;
  return own.map((d) => {
    if (d) previous = d;
    return d ?? previous ?? firstStrong;
  });
}

export interface BidiParagraph {
  /** Logical text with the bidi controls removed. Indices below refer to this string (UTF-16 code units). */
  text: string;
  /** `text` with the characters that sit at an RTL level swapped for their mirror image (L4): "(" becomes ")". */
  shapingText: string;
  /** Resolved embedding level of each code unit of `text`. Odd = right-to-left. */
  levels: Uint8Array;
  /** The paragraph's own level: 0 for an LTR paragraph, 1 for an RTL one. */
  level: number;
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Resolve levels for one paragraph (no line breaks inside) with that
 * paragraph's direction, mirror brackets, then strip the bidi controls. Levels are computed
 * BEFORE stripping, so an RLM still decides how the neutrals around it resolve.
 */
export function analyzeParagraph(raw: string, direction: ResolvedDirection): BidiParagraph {
  const bidi = getBidi();
  const embedding = bidi.getEmbeddingLevels(raw, direction);
  // The levels ARRAY, not the result object: given the object, bidi-js silently returns an empty map.
  const mirrors = bidi.getMirroredCharactersMap(raw, embedding.levels);

  let text = '';
  let shapingText = '';
  const levels: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const unit = raw.charCodeAt(i);
    if (isBidiControl(unit)) continue; // all of them are in the BMP
    const ch = raw[i];
    text += ch;
    shapingText += mirrors.get(i) ?? ch;
    // Never let the two halves of a surrogate pair land in different level runs.
    const previous = text.length >= 2 ? text.charCodeAt(text.length - 2) : 0;
    levels.push(isLowSurrogate(unit) && isHighSurrogate(previous) ? levels[levels.length - 1] : embedding.levels[i]);
  }
  return { text, shapingText, levels: Uint8Array.from(levels), level: direction === 'rtl' ? 1 : 0 };
}

export interface LevelRun {
  /** Start index into the paragraph text (inclusive). */
  start: number;
  /** End index into the paragraph text (exclusive). */
  end: number;
  level: number;
}

/** Maximal runs of equal level over [start, end), in logical order. */
export function levelRuns(levels: Uint8Array, start: number, end: number): LevelRun[] {
  const runs: LevelRun[] = [];
  for (let i = start; i < end; ) {
    let j = i + 1;
    while (j < end && levels[j] === levels[i]) j++;
    runs.push({ start: i, end: j, level: levels[i] });
    i = j;
  }
  return runs;
}

/**
 * One line's level runs in display order, left to right (UAX #9 L2): from the
 * highest level down to the lowest odd level, reverse every maximal sequence of
 * runs at that level or above. Each run keeps its own text; the shaper lays an
 * odd-level run out right-to-left, which is the character-level reversal L2
 * would apply inside it.
 *
 * The caller passes a line with its trailing whitespace already removed, which
 * is all L1 would change here (tabs are turned into spaces before layout).
 */
export function visualRuns(levels: Uint8Array, start: number, end: number): LevelRun[] {
  const runs = levelRuns(levels, start, end);
  let highest = 0;
  let lowestOdd = Infinity;
  for (const run of runs) {
    highest = Math.max(highest, run.level);
    if (run.level % 2 === 1) lowestOdd = Math.min(lowestOdd, run.level);
  }
  for (let level = highest; level >= lowestOdd; level--) {
    for (let i = 0; i < runs.length; ) {
      if (runs[i].level < level) {
        i++;
        continue;
      }
      let j = i;
      while (j < runs.length && runs[j].level >= level) j++;
      const reversed = runs.slice(i, j).reverse();
      runs.splice(i, j - i, ...reversed);
      i = j;
    }
  }
  return runs;
}
