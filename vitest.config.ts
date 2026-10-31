import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.{ts,js}'],
    coverage: {
      provider: 'v8',
      // 未実行のファイルも含め、録画・検知を担う main 全体を集計する。
      include: ['src/main/**/*.ts'],
      reportsDirectory: '.cache/coverage',
      reporter: ['text', 'json-summary', 'html'],
      // テストが失敗しても、調査用のレポートは残す。
      reportOnFailure: true,
    },
  },
});
