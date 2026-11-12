import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  // Users bring their own pdf-lib (or fork, see scripts/flavours.mjs); fontkit and bidi-js are dependencies.
  external: ['pdf-lib', '@pdf-lib/fontkit', 'bidi-js'],
});
