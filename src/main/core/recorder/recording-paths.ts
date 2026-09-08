import type { NicoLiveProgramInfo } from '../../vendor/nico-client/types';

/** ファイル名に使えない文字を置き換える (Windows / macOS 共通で安全な集合にする) */
export function sanitizeFileName(name: string, maxLength = 60): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const sliced = Array.from(cleaned).slice(0, maxLength).join('');
  return sliced.length > 0 ? sliced : 'untitled';
}

function formatTimestamp(date: Date): string {
  // 端末のタイムゾーンに依存せず、日本時間の日時を組み立てる
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}` +
    `_${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}${pad(jst.getUTCSeconds())}`
  );
}

export function buildBaseName(info: NicoLiveProgramInfo, attempt = 1): string {
  const begin = info.beginTime > 0 ? new Date(info.beginTime * 1000) : new Date();
  // タイトルの長さや変更に左右されないよう、配信者 ID と番組 ID で識別する
  const providerId = sanitizeFileName(info.providerId?.trim() || 'unknown');
  const suffix = attempt > 1 ? `_${attempt}` : '';
  return `${formatTimestamp(begin)}_${providerId}_${info.nicoliveProgramId}${suffix}`;
}
