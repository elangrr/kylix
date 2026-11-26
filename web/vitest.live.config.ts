import { defineConfig } from 'vitest/config';

// Reads the real onyx-1 testnet. Sends nothing.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
