import type { NicoComment } from '../../vendor/nico-client/types';

// 閲覧時によく使う投稿時刻・番号・本文を先頭にし、列順を固定する
const COMMENT_COLUMNS = [
  'at',
  'no',
  'content',
  'vpos',
  'rawUserId',
  'hashedUserId',
  'accountStatus',
  'position',
  'size',
  'color',
  'font',
  'opacity',
  'id',
  'liveId',
] as const satisfies readonly (keyof NicoComment)[];
export const CSV_HEADER = '\uFEFF' + COMMENT_COLUMNS.join(',') + '\n';

/** CSV の各列に保存する値 (投稿時刻は日本時間、RGB 色は #RRGGBB にする) */
export interface CommentRecord extends Omit<NicoComment, 'at' | 'color'> {
  at: string;
  color: string;
}

export function toCommentRecord(comment: NicoComment): CommentRecord {
  const at = new Date(comment.at.getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .replace(/Z$/, '+09:00');
  const color =
    typeof comment.color === 'string'
      ? comment.color
      : '#' +
        [comment.color.r, comment.color.g, comment.color.b]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase();
  return { ...comment, at, color };
}

export function toCommentCsv(comment: NicoComment): string {
  const record = toCommentRecord(comment);
  // 本文の改行・タブや数式に見える文字も保持し、CSV の引用符だけをエスケープする
  return (
    COMMENT_COLUMNS.map((column) => `"${String(record[column]).replaceAll('"', '""')}"`).join(',') +
    '\n'
  );
}
