import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  recordProgram,
  type ProgramRecordResult,
} from '../../../src/main/core/recorder/program-recorder';
import { CSV_HEADER } from '../../../src/main/core/recorder/comment-csv';
import { startFakeProgram, type FakeProgramOptions } from '../../helpers/fake-program';
import { writeFakeFfmpeg } from '../../helpers/fake-ffmpeg';

let dir: string;
let ffmpeg: string;
let program: Awaited<ReturnType<typeof startFakeProgram>>;
let controller: AbortController;
let recordings: Promise<ProgramRecordResult>[];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nlr-program-contract-'));
  ffmpeg = process.env['NLR_TEST_FFMPEG'] ?? writeFakeFfmpeg(dir);
  controller = new AbortController();
  recordings = [];
});
afterEach(async () => {
  controller.abort();
  await Promise.allSettled(recordings);
  await program?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function record(
  options: Partial<Parameters<typeof recordProgram>[0]> = {},
): Promise<ProgramRecordResult> {
  const task = recordProgram(
    {
      programId: 'lv42',
      outputDir: dir,
      ffmpegPath: ffmpeg,
      cookies: { user_session: 'dummy' },
      ...options,
    },
    controller.signal,
  );
  recordings.push(task);
  return task;
}

async function expectVideo(result: ProgramRecordResult, separateAudio = false): Promise<void> {
  expect((await fs.stat(result.videoPath)).size).toBeGreaterThan(0);
  const ffprobe = process.env['NLR_TEST_FFPROBE'];
  if (ffprobe) {
    // 実FFmpegで生成したTSを読み直し、映像・音声のパケット数まで入力と比較する。
    const probe = async (
      file: string,
    ): Promise<{ streams: { codec_name: string }[]; packets: { codec_type: string }[] }> => {
      const { stdout } = await promisify(execFile)(
        ffprobe,
        ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', file],
        { timeout: 10_000 },
      );
      return JSON.parse(stdout) as {
        streams: { codec_name: string }[];
        packets: { codec_type: string }[];
      };
    };
    const output = await probe(result.videoPath);
    expect(output.streams.map((stream) => stream.codec_name).sort()).toEqual(['aac', 'h264']);
    for (const track of ['video', 'audio']) {
      const input = await probe(
        path.resolve(`test/fixtures/ffmpeg/${separateAudio ? track : 'combined'}.mp4`),
      );
      expect(output.packets.filter((packet) => packet.codec_type === track).length).toBe(
        input.packets.filter((packet) => packet.codec_type === track).length,
      );
    }
  } else {
    // 通常のnpm testでは、復号後にパイプへ届いた全バイトを比較する。
    expect(await fs.readFile(result.videoPath)).toEqual(
      await fs.readFile(
        path.resolve(`test/fixtures/ffmpeg/${separateAudio ? 'video' : 'combined'}.mp4`),
      ),
    );
    if (separateAudio)
      expect(await fs.readFile(`${result.videoPath}.audio`)).toEqual(
        await fs.readFile(path.resolve('test/fixtures/ffmpeg/audio.mp4')),
      );
  }
}

async function expectComments(result: ProgramRecordResult): Promise<void> {
  expect(result.comments?.count).toBe(1);
  const csv = await fs.readFile(result.commentsPath, 'utf8');
  expect(csv.startsWith(CSV_HEADER)).toBe(true);
  expect(csv.match(/fixture-comment/g)).toHaveLength(1);
  expect(csv).toContain('"2023-11-15T07:13:20.123+09:00"');
  expect(csv).toContain('"#010203"');
  expect(csv).toContain('日本語のコメント, ""引用符""\n改行と絵文字🎵も保持する');
}

test.each([
  { mode: 'live', separateAudio: false },
  { mode: 'live', separateAudio: true },
  { mode: 'timeshift', separateAudio: false },
  { mode: 'timeshift', separateAudio: true },
] satisfies FakeProgramOptions[])(
  '$mode / 別音声=$separateAudio: 番組HTMLから動画・コメント・JSONの保存まで通す',
  async ({ mode, separateAudio }) => {
    program = await startFakeProgram({ mode, separateAudio });
    const result = await record({ mode });
    expect(result.errors).toEqual([]);
    expect(result.video).toMatchObject({
      reason: 'endlist',
      ffmpegExitCode: 0,
      video: { segments: 1 },
    });
    if (mode === 'timeshift') expect(result.timeshift?.completion).toBe('complete');
    await expectVideo(result, separateAudio);
    await expectComments(result);
    expect(JSON.parse(await fs.readFile(result.metadataPath, 'utf8'))).toMatchObject({
      programId: 'lv42',
      video: { reason: 'endlist', segments: 1 },
      comments: { count: 1 },
      errors: [],
    });
    expect(program.requests.some((request) => request.path === '/watch')).toBe(true);
    expect(program.requests.some((request) => request.path === '/forward')).toBe(true);
  },
);

test.each(['live', 'timeshift'] as const)(
  '%s: コメント取得が認証エラーでも動画を最後まで保存する',
  async (mode) => {
    program = await startFakeProgram({ mode, commentsStatus: 401 });
    const result = await record({ mode });
    expect(result.errors).toEqual([expect.objectContaining({ target: 'comments' })]);
    expect(result.video?.ffmpegExitCode).toBe(0);
    if (mode === 'timeshift') expect(result.timeshift?.completion).toBe('partial');
    await expectVideo(result);
  },
);

test('タイムシフトの一部セグメント欠落でも動画とコメントを残し、再実行で上書きしない', async () => {
  program = await startFakeProgram({ mode: 'timeshift', missingSegment: true });
  const first = await record({ mode: 'timeshift' });
  expect(first.timeshift?.completion).toBe('partial');
  expect(first.errors).toEqual([{ target: 'video', message: 'タイムシフト: SEGMENTS_INCOMPLETE' }]);
  await expectVideo(first);
  await expectComments(first);
  const saved = await Promise.all(
    [first.videoPath, first.commentsPath, first.metadataPath].map((file) => fs.readFile(file)),
  );
  const second = await record({ mode: 'timeshift' });
  expect(second.attempt).toBe(first.attempt + 1);
  expect(second.videoPath).not.toBe(first.videoPath);
  expect(
    await Promise.all(
      [first.videoPath, first.commentsPath, first.metadataPath].map((file) => fs.readFile(file)),
    ),
  ).toEqual(saved);
});

test('ライブの鍵取得が403なら視聴接続を更新し、新しいCookieで保存を続ける', async () => {
  program = await startFakeProgram({ refreshKey: true });
  const result = await record();
  expect(result.errors).toEqual([]);
  await expectVideo(result);
  await expectComments(result);
  expect(
    program.requests.filter((request) => request.path === '/key').map((request) => request.cookie),
  ).toEqual(['session=s1', 'session=s2']);
});

test('ライブの手動停止で取得済みの動画・コメントを保存し、処理を終了する', async () => {
  program = await startFakeProgram({ openEnded: true });
  let videoSaved = false;
  let commentSaved = false;
  const stopWhenSaved = (): void => {
    if (videoSaved && commentSaved) controller.abort();
  };
  const result = await record({
    onVideoSample: () => {
      videoSaved = true;
      stopWhenSaved();
    },
    onComment: () => {
      commentSaved = true;
      stopWhenSaved();
    },
  });
  expect(result.errors).toEqual([]);
  expect(result.video?.reason).toBe('aborted');
  await expectVideo(result);
  await expectComments(result);
});
