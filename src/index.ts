/**
 * Arabic, Persian and Hebrew text for pdf-lib: bidi (bidi-js) + shaping
 * (fontkit) + glyph placement (pdf-lib 1.17.1), with selectable, searchable
 * text. Typical use:
 *
 *   const font = await embedTextFont(doc, fontBytes);
 *   drawTextBox(page, font, 'المبلغ 450 ريال', { x: 50, y: 700, width: 400, size: 14 });
 *
 * Or lay out first (layoutText), check layout.missing for characters the
 * font cannot draw, then drawLayout.
 */
export { analyzeParagraph, firstStrongDirection, isBidiControl, resolveDirection, resolveParagraphDirections, visualRuns } from './bidi';
export type { BaseDirection, BidiParagraph, LevelRun, ResolvedDirection } from './bidi';
export { findMissingCharacters, isDefaultIgnorable, shapeRun } from './shaping';
export type { ShapedGlyph } from './shaping';
export { DEFAULT_LINE_HEIGHT } from './constants';
export { fontsOf, layoutText, normalizeText } from './layout';
export type { FontStack, LaidOutGlyph, LaidOutLine, TextLayout, TextLayoutOptions } from './layout';
export {
  MissingGlyphsError,
  createLayoutFont,
  drawLayout,
  drawTextBox,
  embedTextFont,
  subsetInternals,
  toUnicodeCodePoints,
  uprightTransform,
} from './pdf';
export type { DrawTextOptions, Matrix, PdfTextFont, TextAlign } from './pdf';
