import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // The suite is small and touches the file system; one worker keeps it deterministic
    // and avoids the per-worker memory cost on constrained machines.
    fileParallelism: false,
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/bin.ts'],
    },
  },
});
