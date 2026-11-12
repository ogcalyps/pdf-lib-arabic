/**
 * Test oracle: read a PDF back with pdf.js in Node and report every drawn
 * glyph with its ToUnicode text and its position as the page is DISPLAYED
 * (page /Rotate applied), so tests can check visual left-to-right order, not
 * just extracted text. Extraction alone cannot check bracket mirroring: pdf.js
 * and poppler reorder brackets themselves.
 *
 * pdf.js 5+ hands matrices over as one Float32Array and colours as "#rrggbb",
 * so positions are only good to about 1e-5 pt at page scale: tests compare
 * them to 3 decimals.
 */
// The legacy build is the one that runs in Node.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

type M = [number, number, number, number, number, number];

export interface OracleGlyph {
  /** ToUnicode text of the glyph (what copy/search sees for it). */
  unicode: string;
  /** Character code in the PDF = glyph id in the embedded subset. */
  cid: number;
  /** Glyph origin in display space: x to the right, y DOWN, in points. */
  x: number;
  y: number;
  /** Baseline direction in display space (unit vector); (1, 0) when the text is upright. */
  dx: number;
  dy: number;
  /** Fill colour in effect, 0-255 per channel. */
  fill: [number, number, number];
}

export interface OraclePage {
  width: number;
  height: number;
  glyphs: OracleGlyph[];
  /** pdf.js getTextContent items joined per line (y), top to bottom. */
  text: string[];
}

/** Operator arguments as numbers: pdf.js 5+ packs a matrix into one typed array. */
const numbers = (args: unknown[]): number[] =>
  args.length === 1 && ArrayBuffer.isView(args[0]) ? Array.from(args[0] as Float32Array) : (args as number[]).map(Number);

/** A fill colour as 0-255 channels, from "#rrggbb" (pdf.js 5+) or three numbers. */
const rgbOf = (args: unknown[]): [number, number, number] => {
  if (typeof args[0] === 'string') {
    const hex = args[0].replace('#', '');
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  }
  return [Number(args[0]), Number(args[1]), Number(args[2])];
};

const multiply = (m1: M, m2: M): M => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

export async function readPdf(bytes: Uint8Array): Promise<OraclePage[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages: OraclePage[] = [];
  try {
    const { OPS } = pdfjs;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const vt = viewport.transform as M;
      const ops = await page.getOperatorList();
      const glyphs: OracleGlyph[] = [];
      let ctm: M = [1, 0, 0, 1, 0, 0];
      let fill: [number, number, number] = [0, 0, 0];
      const stack: Array<{ ctm: M; fill: [number, number, number] }> = [];
      let tm: M = [1, 0, 0, 1, 0, 0];
      // Line matrix, for Td / TD / T* (this package and pdf-lib only use Tm; other producers use Td).
      let tlm: M = [1, 0, 0, 1, 0, 0];
      let leading = 0;
      let hscale = 1;
      let size = 0;
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === OPS.save) stack.push({ ctm, fill });
        else if (fn === OPS.restore) ({ ctm, fill } = stack.pop() ?? { ctm, fill });
        else if (fn === OPS.setFillRGBColor) fill = rgbOf(args);
        else if (fn === OPS.transform) ctm = multiply(ctm, numbers(args).slice(0, 6) as M);
        else if (fn === OPS.beginText) tm = tlm = [1, 0, 0, 1, 0, 0];
        else if (fn === OPS.setTextMatrix) tm = tlm = numbers(args).slice(0, 6) as M;
        else if (fn === OPS.moveText || fn === OPS.setLeadingMoveText || fn === OPS.nextLine) {
          const [tx, ty] = fn === OPS.nextLine ? [0, -leading] : numbers(args);
          if (fn === OPS.setLeadingMoveText) leading = -ty;
          tm = tlm = multiply(tlm, [1, 0, 0, 1, tx, ty]);
        } else if (fn === OPS.setLeading) leading = Number(args[0]);
        else if (fn === OPS.setHScale) hscale = Number(args[0]) / 100;
        else if (fn === OPS.setFont) size = args[1];
        else if (fn === OPS.showText) {
          for (const g of args[0]) {
            if (typeof g === 'number') {
              tm = multiply(tm, [1, 0, 0, 1, (-g / 1000) * size * hscale, 0]);
              continue;
            }
            const m = multiply(vt, multiply(ctm, tm));
            const len = Math.hypot(m[0], m[1]);
            glyphs.push({ unicode: g.unicode, cid: g.originalCharCode, x: m[4], y: m[5], dx: m[0] / len, dy: m[1] / len, fill });
            tm = multiply(tm, [1, 0, 0, 1, (g.width / 1000) * size * hscale, 0]);
          }
        }
      }
      const content = await page.getTextContent();
      const rows = new Map<number, string[]>();
      for (const item of content.items as Array<{ str?: string; transform: number[] }>) {
        if (typeof item.str !== 'string') continue;
        const key = Math.round(item.transform[5]);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key)!.push(item.str);
      }
      const text = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, parts]) => parts.join(''));
      pages.push({ width: viewport.width, height: viewport.height, glyphs, text });
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

// Built from a string: the u-flag property escape needs an ES2018 target and tsconfig targets ES2017.
const MARK = new RegExp('\\p{Mn}', 'gu');

/**
 * The visual text of each line, left to right as displayed: base glyphs (marks
 * left out, since a mark sits over its letter, not beside it) grouped into
 * lines by baseline and sorted by x.
 */
export function visualLines(glyphs: OracleGlyph[], lineHeight: number): string[] {
  const bases = glyphs.filter((g) => g.unicode.replace(MARK, '') !== '');
  const lines: OracleGlyph[][] = [];
  for (const g of [...bases].sort((a, b) => a.y - b.y)) {
    const line = lines.find((l) => Math.abs(l[0].y - g.y) < lineHeight / 2);
    if (line) line.push(g);
    else lines.push([g]);
  }
  return lines.map((line) =>
    line
      .sort((a, b) => a.x - b.x)
      .map((g) => g.unicode.replace(MARK, ''))
      .join(''),
  );
}

export function stripMarks(text: string): string {
  return text.replace(MARK, '');
}
