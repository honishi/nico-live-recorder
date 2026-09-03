import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// 型情報を使うルール (未 await の Promise 検出など) を有効にするため、
// tsconfig.node.json / tsconfig.web.json を projectService で参照する
export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      'resources/**',
      'test/push/data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // どの tsconfig にも含まれない設定ファイルは既定プロジェクトで解析する
          allowDefaultProject: ['vitest.config.ts', '*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // await 忘れは録画やネットワーク処理の取りこぼしに直結するので厳しめにする
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false, arguments: false } },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/require-await': 'off',
    },
  },
  // main / preload / スクリプト / テストは Node の環境
  {
    files: [
      'src/main/**',
      'src/preload/**',
      'src/shared/**',
      'scripts/**',
      'test/**',
      '*.ts',
      '*.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
  // renderer はブラウザ環境。React hooks のルールを適用する
  {
    files: ['src/renderer/**'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },
  // 流用元 (stream-journal / chrome-nico-alert) のコードは upstream との差分を小さく保つため、
  // any や unsafe 系のルールを緩める
  {
    files: [
      'src/main/nico-client/**',
      'src/main/push/autopush-client.ts',
      'src/main/push/web-push-crypto.ts',
      'test/push/web-push-crypto.test.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  // JS ファイルは型情報付きルールの対象外
  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  // prettier と衝突する整形系ルールを無効化する (最後に置く)
  prettier,
);
