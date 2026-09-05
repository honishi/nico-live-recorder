import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildBaseName,
  resolveAvailableAttempt,
  sanitizeFileName,
} from '../../../src/main/core/recorder/program-recorder';
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
    providerId: '12345678',
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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  test.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])(
    '端末のタイムゾーンが %s でも日本時間の放送開始日時、配信者 ID、番組 ID を使う',
    (timezone) => {
      vi.stubEnv('TZ', timezone);
      const beginTime = Date.parse('2026-09-05T18:24:03Z') / 1000;
      expect(buildBaseName(info({ beginTime }))).toBe('20260906_032403_12345678_lv123');
    },
  );

  test('長いタイトルやタイトルの変更はファイル名に影響しない', () => {
    const beginTime = Date.parse('2026-09-06T03:24:03+09:00') / 1000;
    expect(buildBaseName(info({ beginTime, title: '長いタイトル🆗/\\'.repeat(100) }))).toBe(
      '20260906_032403_12345678_lv123',
    );
    expect(buildBaseName(info({ beginTime, title: '変更後' }))).toBe(
      '20260906_032403_12345678_lv123',
    );
  });

  test.each([undefined, '', '   '])('配信者 ID が %j なら unknown を使う', (providerId) => {
    const beginTime = Date.parse('2026-09-06T03:24:03+09:00') / 1000;
    expect(buildBaseName(info({ beginTime, providerId }))).toBe('20260906_032403_unknown_lv123');
  });

  test('配信者 ID にファイル名として使えない文字があっても安全に保存する', () => {
    const beginTime = Date.parse('2026-09-06T03:24:03+09:00') / 1000;
    expect(buildBaseName(info({ beginTime, providerId: '../123:45' }))).toBe(
      '20260906_032403_.._123_45_lv123',
    );
  });

  test('2 回目以降は末尾に連番を付ける', () => {
    const beginTime = Date.parse('2026-09-06T03:24:03+09:00') / 1000;
    expect(buildBaseName(info({ beginTime }), 1)).toBe('20260906_032403_12345678_lv123');
    expect(buildBaseName(info({ beginTime }), 2)).toBe('20260906_032403_12345678_lv123_2');
  });

  test('開始時刻が無ければ現在時刻を使う', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T15:00:00Z'));
    expect(buildBaseName(info({ beginTime: 0 }))).toBe('20270101_000000_12345678_lv123');
  });
});

describe('resolveAvailableAttempt', () => {
  test('既存の録画ファイルがあれば次の空き連番を返す', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-attempt-'));
    try {
      const program = {
        nicoliveProgramId: 'lv123',
        providerId: '12345678',
        title: 'x',
        description: '',
        status: NicoLiveProgramStatus.onAir,
        openTime: 0,
        beginTime: Date.parse('2026-09-06T03:24:03+09:00') / 1000,
        vposBaseTime: 0,
        endTime: 0,
        scheduledEndTime: 0,
        hasTimeshift: false,
        supplierIntroduction: '',
        commentCount: 0,
        watchCount: 0,
      };
      expect(await resolveAvailableAttempt(dir, program, 1)).toBe(1);
      fs.writeFileSync(path.join(dir, `${buildBaseName(program, 1)}.ts`), '');
      fs.writeFileSync(path.join(dir, `${buildBaseName(program, 2)}.ts`), '');
      // 放送中にタイトルが変わっても、既存の録画を上書きしない
      program.title = '変更後のタイトル';
      expect(await resolveAvailableAttempt(dir, program, 1)).toBe(3);
      expect(await resolveAvailableAttempt(dir, program, 2)).toBe(3);
      expect(await resolveAvailableAttempt(dir, program, 5)).toBe(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
