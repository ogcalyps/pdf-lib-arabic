// npm shows the README from the tarball, GitHub the one in the repo. Before
// packing, tag its links to the BlendPDF site as coming from npm; after
// packing, put the GitHub tags back, so each visit is counted where it came from.
//
//   node scripts/readme-links.mjs npm|github
import { readFileSync, writeFileSync } from 'node:fs';

const TAGS = {
  github: 'utm_source=github&utm_medium=readme',
  npm: 'utm_source=npm&utm_medium=package',
};
const target = process.argv[2];
if (!(target in TAGS)) throw new Error('usage: node scripts/readme-links.mjs npm|github');
const other = target === 'npm' ? 'github' : 'npm';
const readme = readFileSync('README.md', 'utf8');
writeFileSync('README.md', readme.replaceAll(TAGS[other], TAGS[target]));
