// Install a packed tarball into a throwaway project, as a user would, and
// check every entry point: pdf-lib from ESM and CommonJS, and the
// @pdfme/pdf-lib and @cantoo/pdf-lib builds. Each writes Arabic, saves, writes
// more on a new page (the subset font must be written again), saves again;
// pdf.js (and pdftotext, when installed) must find every word. Then TypeScript checks a file that uses all three entry points.
//
//   npm pack && node scripts/smoke.mjs pdf-lib-arabic-0.1.0.tgz
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tarball = resolve(process.argv[2] ?? '');
const font = resolve('test/fonts/Cairo-Regular.ttf');
const dir = mkdtempSync(join(tmpdir(), 'pdf-lib-arabic-smoke-'));
const FIRST = 'المبلغ: ٤٥٠ ريال (شامل الضريبة 15%)';
const SECOND = 'لا إله إلا الله - أرسل ملف PDF قبل 15/03/2026';
const WORDS = ['المبلغ', '٤٥٠', 'ريال', 'شامل', 'الضريبة', '15', 'لا', 'إله', 'إلا', 'الله', 'أرسل', 'ملف', 'PDF', 'قبل', '15/03/2026'];

const FLAVOURS = [
  { name: 'pdf-lib (ESM)', file: 'pdf-lib.mjs', pdfLib: 'pdf-lib', entry: 'pdf-lib-arabic' },
  { name: 'pdf-lib (CommonJS)', file: 'pdf-lib.cjs', pdfLib: 'pdf-lib', entry: 'pdf-lib-arabic' },
  { name: '@pdfme/pdf-lib', file: 'pdfme.mjs', pdfLib: '@pdfme/pdf-lib', entry: 'pdf-lib-arabic/pdfme' },
  { name: '@cantoo/pdf-lib', file: 'cantoo.mjs', pdfLib: '@cantoo/pdf-lib', entry: 'pdf-lib-arabic/cantoo', fontkit: '@cantoo/fontkit' },
];

const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

function script({ file, pdfLib, entry, fontkit }) {
  const cjs = file.endsWith('.cjs');
  const imports = cjs
    ? `const { PDFDocument } = require('${pdfLib}');\nconst { drawTextBox, embedTextFont } = require('${entry}');\nconst { readFile, writeFile } = require('node:fs/promises');`
    : `import { PDFDocument } from '${pdfLib}';\nimport { drawTextBox, embedTextFont } from '${entry}';\nimport { readFile, writeFile } from 'node:fs/promises';${fontkit ? `\nimport fontkit from '${fontkit}';` : ''}`;
  const body = `
const doc = await PDFDocument.create();
${fontkit ? 'doc.registerFontkit(fontkit);' : ''}
const page = doc.addPage([460, 140]);
const font = await embedTextFont(doc, await readFile('Cairo-Regular.ttf'));
drawTextBox(page, font, ${JSON.stringify(FIRST)}, { x: 20, y: 100, width: 420, size: 18 });
await doc.save();
drawTextBox(doc.addPage([460, 140]), font, ${JSON.stringify(SECOND)}, { x: 20, y: 100, width: 420, size: 18 });
await writeFile(process.argv[2], await doc.save());
`;
  return cjs ? `${imports}\n(async () => {${body}})();\n` : `${imports}\n${body}`;
}

try {
  copyFileSync(font, join(dir, 'Cairo-Regular.ttf'));
  writeFileSync(join(dir, 'package.json'), '{ "private": true }\n');
  run('npm', [
    'install', '--no-audit', '--no-fund', '--loglevel=error', tarball,
    'pdf-lib@1.17.1', '@pdfme/pdf-lib@6.2.8', '@cantoo/pdf-lib@2.11.1', '@cantoo/fontkit@2.0.12',
    'pdfjs-dist@6.4.299', 'typescript@5.9.3', '@types/node@22',
  ]);
  writeFileSync(
    join(dir, 'read.mjs'),
    `import { readFile } from 'node:fs/promises';
// pdf.js 6 needs Promise.withResolvers, which Node 20 lacks (the package doesn't).
Promise.withResolvers ??= () => { let resolve, reject; const promise = new Promise((a, b) => ((resolve = a), (reject = b))); return { promise, resolve, reject }; };
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await getDocument({ data: new Uint8Array(await readFile(process.argv[2])), verbosity: 0 }).promise;
for (let n = 1; n <= doc.numPages; n++) {
  const content = await (await doc.getPage(n)).getTextContent();
  console.log(content.items.map((item) => item.str).join(' '));
}
`,
  );

  let hasPdftotext = true;
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
  } catch {
    hasPdftotext = false;
  }

  let failed = false;
  for (const flavour of FLAVOURS) {
    writeFileSync(join(dir, flavour.file), script(flavour));
    const pdf = `${flavour.file}.pdf`;
    run('node', [flavour.file, pdf]);
    const readers = { 'pdf.js': run('node', ['read.mjs', pdf]) };
    if (hasPdftotext) readers.pdftotext = run('pdftotext', ['-enc', 'UTF-8', pdf, '-']);
    for (const [reader, text] of Object.entries(readers)) {
      const missing = WORDS.filter((word) => !text.includes(word));
      console.log(`${flavour.name} / ${reader}: ${missing.length ? `MISSING ${missing.join(' ')}` : 'every word found'}`);
      if (missing.length) failed = true;
    }
  }
  if (!hasPdftotext) console.log('pdftotext not installed: checked with pdf.js only');

  // Types: each entry point accepts its own library's document and page.
  writeFileSync(
    join(dir, 'types.mts'),
    `import { readFile } from 'node:fs/promises';
import * as base from 'pdf-lib';
import * as pdfme from '@pdfme/pdf-lib';
import * as cantoo from '@cantoo/pdf-lib';
import * as forBase from 'pdf-lib-arabic';
import * as forPdfme from 'pdf-lib-arabic/pdfme';
import * as forCantoo from 'pdf-lib-arabic/cantoo';
const bytes = await readFile('Cairo-Regular.ttf');
const a = await base.PDFDocument.create();
forBase.drawTextBox(a.addPage(), await forBase.embedTextFont(a, bytes), 'سلام', { x: 20, y: 700, width: 300, size: 12, color: base.rgb(0, 0, 0) });
const b = await pdfme.PDFDocument.create();
forPdfme.drawTextBox(b.addPage(), await forPdfme.embedTextFont(b, bytes), 'سلام', { x: 20, y: 700, width: 300, size: 12, color: pdfme.rgb(0, 0, 0) });
const c = await cantoo.PDFDocument.create();
forCantoo.drawTextBox(c.addPage(), await forCantoo.embedTextFont(c, bytes), 'سلام', { x: 20, y: 700, width: 300, size: 12, color: cantoo.rgb(0, 0, 0) });
const layout: forBase.TextLayout = forBase.layoutText(forBase.createLayoutFont(bytes), 'سلام', { size: 12 });
console.log(layout.lines.length);
`,
  );
  try {
    run('npx', ['tsc', '--noEmit', '--strict', '--skipLibCheck', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--types', 'node', 'types.mts']);
    console.log('types: all three entry points check');
  } catch (error) {
    console.log(`types: FAILED\n${error.stdout ?? error}`);
    failed = true;
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
