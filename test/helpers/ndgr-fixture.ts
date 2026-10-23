import { readFileSync } from 'node:fs';

/** ライブラリ更新と独立した固定 wire データ。テスト中に再エンコードしない。 */
export function ndgrFixture(name: 'comment' | 'forward' | 'packed' | 'next-cursors'): Buffer {
  return Buffer.from(
    readFileSync(new URL(`../fixtures/ndgr/${name}.hex`, import.meta.url), 'utf8').trim(),
    'hex',
  );
}
