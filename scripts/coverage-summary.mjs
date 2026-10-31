import { appendFile, readFile, writeFile } from 'node:fs/promises';

// Vitest の集計値をそのまま使い、HTML レポートと同じ母数で表示する。
const reportDirectory = new URL('../.cache/coverage/', import.meta.url);
const { total } = JSON.parse(
  await readFile(new URL('coverage-summary.json', reportDirectory), 'utf8'),
);
const metrics = [
  ['行 (Lines)', 'lines'],
  ['分岐 (Branches)', 'branches'],
  ['関数 (Functions)', 'functions'],
  ['文 (Statements)', 'statements'],
];
const rows = metrics.map(([label, key]) => {
  const metric = total[key];
  return `| ${label} | ${metric.pct}% | ${metric.covered} / ${metric.total} |`;
});
const summary = [
  '## テストカバレッジ',
  '',
  'Vitest / V8・対象: `src/main/**/*.ts`（未実行ファイルを含む）',
  '',
  '| 指標 | カバレッジ | 実行済み / 全体 |',
  '| --- | ---: | ---: |',
  ...rows,
  '',
  'Electron 実体の検証・preload・renderer はこの集計に含みません。カバレッジの下限は設定していません。',
  '',
  '詳細は Artifact `coverage-report` をダウンロード・展開して `index.html` を開いてください（保存期間: 7日）。',
  '',
].join('\n');

// 同じ内容を Artifact と Actions の概要に残す。ローカルでは標準出力でも確認できる。
await writeFile(new URL('summary.md', reportDirectory), summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
console.log(summary);
