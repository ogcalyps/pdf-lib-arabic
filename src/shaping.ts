/**
 * Shaping with fontkit: one call per bidi level run, always with an explicit
 * direction, plus the coverage check that tells the caller a box has
 * characters no font of the stack can draw.
 */
import type { Font, Glyph, GlyphRun, TypeFeatures } from '@pdf-lib/fontkit';
import { isBidiControl } from './bidi';

/** A shaped glyph with fontkit's GPOS-adjusted metrics, in font units. */
export interface ShapedGlyph {
  glyph: Glyph;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}

// fontkit's layout() takes (text or glyphs, features, script, language,
// direction); its bundled typings only declare a string and features.
type LayoutWithDirection = (
  text: string | Glyph[],
  features?: TypeFeatures | (keyof TypeFeatures)[],
  script?: string,
  language?: string,
  direction?: 'ltr' | 'rtl',
) => GlyphRun;

/**
 * The glyphs fontkit shapes `text` from, one per code point, each carrying its
 * own code point. fontkit's own string lookup goes through its glyph cache,
 * which keeps ONE Glyph object per glyph id with the code points it was first
 * created for. Every character the font lacks is glyph 0, so ZWJ, ZWNJ and an
 * emoji typed in an earlier box all came back as whichever was seen first: a
 * ZWJ then stopped the join, a ZWNJ joined, or a hidden ZWNJ turned into a
 * missing glyph. A glyph first cached as part of a composite has no code points
 * at all. The shaper decides joining from these code points, so it gets them
 * from the text, never from the cache.
 */
function glyphsFor(font: Font, text: string): { glyphs: Glyph[]; missing: boolean } {
  const glyphs: Glyph[] = [];
  let missing = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!font.hasGlyphForCodePoint(cp) && !isDefaultIgnorable(cp)) missing = true;
    glyphs.push(Object.create(font.glyphForCodePoint(cp), { codePoints: { value: [cp] } }) as Glyph);
  }
  return { glyphs, missing };
}

/**
 * Shape one level run. The direction is passed explicitly every time: left to
 * itself fontkit picks the direction from the script, so a run of Arabic-Indic
 * or Persian digits (an LTR run inside Arabic) would be classed as Arabic and
 * laid out backwards, ٤٥٠ coming out as ٠٥٤. For 'rtl' fontkit returns the
 * glyphs already in display order (left to right).
 */
export function shapeRun(font: Font, text: string, rtl: boolean): ShapedGlyph[] {
  const layout = font.layout as unknown as LayoutWithDirection;
  const input = glyphsFor(font, text);
  const run = layout.call(font, input.glyphs, [], undefined, undefined, rtl ? 'rtl' : 'ltr');
  const spaceId = font.glyphForCodePoint(0x20).id;
  const out: ShapedGlyph[] = [];
  for (let i = 0; i < run.glyphs.length; i++) {
    const glyph = run.glyphs[i];
    const position = run.positions[i];
    // Default-ignorable characters (ZWNJ, ZWJ, soft hyphen...) have done their
    // job once the run is shaped (ZWNJ stopped the join), and none of them
    // reaches the PDF: a space glyph would put a space into the copied text of
    // a Persian word. fontkit swaps them for a zero-width space when the glyph
    // it ends up with still carries their code point. Otherwise one the font
    // has no glyph for comes back as glyph 0, and in a run with no missing
    // character every glyph 0 is one of them.
    if (glyph.id === spaceId && position.xAdvance === 0) continue;
    if (glyph.id === 0 && !input.missing) continue;
    out.push({ glyph, xAdvance: position.xAdvance, xOffset: position.xOffset, yOffset: position.yOffset });
  }
  return out;
}

/** Total advance of shaped glyphs, in font units. */
export function advanceOf(glyphs: ShapedGlyph[]): number {
  let total = 0;
  for (const g of glyphs) total += g.xAdvance;
  return total;
}

/**
 * Unicode default-ignorable code points, exactly as fontkit's layout engine
 * lists them (DerivedCoreProperties minus U+115F, U+1160, U+3164, U+FFA0). The
 * font needs no glyph for these: fontkit renders them as nothing.
 */
export function isDefaultIgnorable(cp: number): boolean {
  if (cp < 0x10000) {
    return (
      cp === 0x00ad ||
      cp === 0x034f ||
      cp === 0x061c ||
      (cp >= 0x17b4 && cp <= 0x17b5) ||
      (cp >= 0x180b && cp <= 0x180e) ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2060 && cp <= 0x206f) ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      cp === 0xfeff ||
      (cp >= 0xfff0 && cp <= 0xfff8)
    );
  }
  return (cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0xe0000 && cp <= 0xe0fff);
}

/**
 * Characters in `text` that no font of the stack can draw, each listed once,
 * in order of first appearance. Line breaks, bidi controls and
 * default-ignorable code points (ZWNJ, ZWJ, BOM...) are not counted: none of
 * them needs a glyph.
 */
export function findMissingCharacters(fonts: Font | readonly Font[], text: string): string[] {
  const stack: readonly Font[] = Array.isArray(fonts) ? (fonts as readonly Font[]) : [fonts as Font];
  const missing: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a || isBidiControl(cp) || isDefaultIgnorable(cp)) continue;
    if (!stack.some((font) => font.hasGlyphForCodePoint(cp)) && !missing.includes(ch)) missing.push(ch);
  }
  return missing;
}
