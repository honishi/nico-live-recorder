import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/main/core/network-runtime.ts'],
    include: ['test/**/*.test.{ts,js}'],
  },
});
