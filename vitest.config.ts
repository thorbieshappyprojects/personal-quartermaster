import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
