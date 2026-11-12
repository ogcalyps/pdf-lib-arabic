import { defineConfig } from 'vitest/config';

// PDF_LIB_FORK=cantoo|pdfme runs the suite with pdf-lib swapped for that fork (CI installs it).
const fork = process.env.PDF_LIB_FORK;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    setupFiles: fork === 'cantoo' ? ['test/setup-cantoo.ts'] : [],
  },
});
