import { buildBaseName, sanitizeFileName } from '../../../src/main/core/recorder/program-recorder';
import {
  NicoLiveProgramStatus,
  type NicoLiveProgramInfo,
} from '../../../src/main/vendor/nico-client/types';

describe('sanitizeFileName', () => {
  test('Windows / macOS で使えない文字と制御文字を _ に置き換える', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('tab\there null\u0000del\u007f')).toBe('tab_here null_del_');
  });

  test('空白は 1 つにまとめ、末尾のドットと空白を落とす', () => {
    expect(sanitizeFileName('  title   with   spaces . ')).toBe('title with spaces');
  });

  test('記号や絵文字はそのまま残す', () => {
    expect(sanitizeFileName("【80'〜昭和&平成】歌謡タレ流し🆗!")).toBe(
      "【80'〜昭和&平成】歌謡タレ流し🆗!",
    );
  });

  test('長さは文字数 (コードポイント) で切り詰める', () => {
    expect(sanitizeFileName('あ'.repeat(100), 10)).toBe('あ'.repeat(10));
    expect(sanitizeFileName('🆗'.repeat(5), 3)).toBe('🆗🆗🆗');
  });

  test('空になったら untitled', () => {
    expect(sanitizeFileName('')).toBe('untitled');
    expect(sanitizeFileName('...')).toBe('untitled');
  });
});

describe('buildBaseName', () => {
  const info = (patch: Partial<NicoLiveProgramInfo>): NicoLiveProgramInfo => ({
    nicoliveProgramId: 'lv123',
    title: 'タイトル',
    description: '',
    status: NicoLiveProgramStatus.onAir,
    openTime: 0,
    beginTime: 0,
    vposBaseTime: 0,
    endTime: 0,
    scheduledEndTime: 0,
    hasTimeshift: false,
    supplierIntroduction: '',
    commentCount: 0,
    watchCount: 0,
    ...patch,
  });

  test('放送開始時刻 (ローカル時刻)、番組 ID、正規化したタイトルを _ で繋ぐ', () => {
    const beginTime = Math.floor(new Date(2026, 8, 3, 1, 42, 49).getTime() / 1000);
    expect(buildBaseName(info({ beginTime, title: 'a/b' }))).toBe('20260903_014249_lv123_a_b');
  });

  test('2 回目以降は末尾に連番を付ける', () => {
    const beginTime = Math.floor(new Date(2026, 8, 3, 1, 42, 49).getTime() / 1000);
    expect(buildBaseName(info({ beginTime, title: 'x' }), 1)).toBe('20260903_014249_lv123_x');
    expect(buildBaseName(info({ beginTime, title: 'x' }), 2)).toBe('20260903_014249_lv123_x_2');
  });

  test('開始時刻が無ければ現在時刻を使う', () => {
    expect(buildBaseName(info({ beginTime: 0 }))).toMatch(/^\d{8}_\d{6}_lv123_タイトル$/);
  });
});
