// Write dist/pdfme.* and dist/cantoo.*: the same build, importing the fork in
// place of pdf-lib. The forks check `instanceof` against their own classes, so
// the operators this package builds must come from the same package as the page.
import { readFileSync, writeFileSync } from 'node:fs';

const FORKS = { pdfme: '@pdfme/pdf-lib', cantoo: '@cantoo/pdf-lib' };
// Each built file and the exact way it imports pdf-lib.
const FILES = {
  js: [/from "pdf-lib";/g, (to) => `from "${to}";`],
  cjs: [/require\("pdf-lib"\)/g, (to) => `require("${to}")`],
  'd.ts': [/from 'pdf-lib';/g, (to) => `from '${to}';`],
  'd.cts': [/from 'pdf-lib';/g, (to) => `from '${to}';`],
};

for (const [ext, [pattern, replacement]] of Object.entries(FILES)) {
  const source = readFileSync(`dist/index.${ext}`, 'utf8');
  const count = source.match(pattern)?.length ?? 0;
  if (count !== 1) throw new Error(`dist/index.${ext} imports pdf-lib ${count} times, expected once`);
  for (const [entry, pdfLib] of Object.entries(FORKS)) {
    let out = source.replace(pattern, replacement(pdfLib));
    if (/["']pdf-lib["']/.test(out)) throw new Error(`dist/${entry}.${ext} still names pdf-lib`);
    if (ext === 'js' || ext === 'cjs') {
      out = out.replace(`//# sourceMappingURL=index.${ext}.map`, `//# sourceMappingURL=${entry}.${ext}.map`);
      writeFileSync(`dist/${entry}.${ext}.map`, readFileSync(`dist/index.${ext}.map`));
    }
    writeFileSync(`dist/${entry}.${ext}`, out);
  }
}
