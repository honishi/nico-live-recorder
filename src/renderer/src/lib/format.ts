export { formatBytes } from '@shared/format';

/** 推定値なので10秒単位へ切り上げ、秒刻みの揺れを抑える。 */
export function formatRemainingTime(seconds: number): string {
  const rounded = Math.max(10, Math.ceil(seconds / 10) * 10);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  return `${h > 0 ? `${h}時間` : ''}${m > 0 ? `${m}分` : ''}${s > 0 ? `${s}秒` : ''}`;
}

export function formatDuration(start: string, end: string | undefined, now: number): string {
  const ms = (end ? new Date(end).getTime() : now) - new Date(start).getTime();
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('ja-JP');
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function isToday(iso: string, now: number): boolean {
  const d = new Date(iso);
  const t = new Date(now);
  return (
    d.getFullYear() === t.getFullYear() &&
    d.getMonth() === t.getMonth() &&
    d.getDate() === t.getDate()
  );
}

/** 当日は「今日 HH:MM」、それ以外は「M/D HH:MM」 */
export function formatDateTime(iso: string, now: number): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return isToday(iso, now) ? `今日 ${time}` : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
