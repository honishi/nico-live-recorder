import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { extractPreviewImage } from '../../../src/main/core/nico/preview-image';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

describe('プレビュー画像の別プロセス生成', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawn.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  test('初期化情報と1セグメントだけを渡し、キーフレーム1枚を生成する', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const input: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => input.push(chunk));
    const task = extractPreviewImage(
      { init: Buffer.from('init'), data: Buffer.from('segment') },
      new AbortController().signal,
      '/fake/ffmpeg',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(Buffer.concat(input)).toEqual(Buffer.from('initsegment'));
    const args = spawn.mock.calls[0][1] as string[];
    expect(args.slice(args.indexOf('-skip_frame'), args.indexOf('-skip_frame') + 2)).toEqual([
      '-skip_frame',
      'nokey',
    ]);
    expect(args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2)).toEqual([
      '-frames:v',
      '1',
    ]);
    child.stdout.write(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    child.emit('close', 0);
    expect(await task).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['abort', 'timeout', 'oversize'])(
    '%s で子プロセスを止め、終了を待つ',
    async (reason) => {
      const child = fakeChild();
      spawn.mockReturnValue(child);
      const controller = new AbortController();
      const task = extractPreviewImage(
        { data: Buffer.from('segment') },
        controller.signal,
        '/fake/ffmpeg',
      );
      const rejected = expect(task).rejects.toThrow('preview');
      if (reason === 'abort') controller.abort();
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(3_000);
      if (reason === 'oversize') child.stdout.write(Buffer.alloc(256 * 1024 + 1));
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.emit('close', null);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test('起動失敗や画像なしを拒否し、stdin の EPIPE は吸収する', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const task = extractPreviewImage(
      { data: Buffer.from('segment') },
      new AbortController().signal,
      '/fake/ffmpeg',
    );
    const rejected = expect(task).rejects.toThrow('spawn failed');
    child.stdin.emit('error', new Error('EPIPE'));
    child.emit('error', new Error('spawn failed'));
    child.emit('close', -1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    { label: '空の出力', bytes: [] },
    { label: '先頭1バイトだけ', bytes: [0xff] },
    { label: '2バイト目が異なる出力', bytes: [0xff, 0x00] },
    { label: '1バイト目が異なる出力', bytes: [0x00, 0xd8] },
  ])('正常終了でも $label はJPEGとして受け取らない', async ({ bytes }) => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const task = extractPreviewImage(
      { data: Buffer.from('segment') },
      new AbortController().signal,
      '/fake/ffmpeg',
    );
    const rejected = expect(task).rejects.toThrow('preview image unavailable (ffmpeg exit 0)');
    child.stdout.write(Buffer.from(bytes));
    child.emit('close', 0);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  test('生成失敗には終了コードとstderrの末尾2行だけを含める', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const task = extractPreviewImage(
      { data: Buffer.from('segment') },
      new AbortController().signal,
      '/fake/ffmpeg',
    );
    const rejected = expect(task).rejects.toThrow(
      'preview image unavailable (ffmpeg exit 1): Unknown encoder mjpeg | Error opening output',
    );
    child.stderr.write('old diagnostic\nUnknown encoder ');
    child.stderr.write('mjpeg\r\nError opening output\n');
    child.emit('close', 1);
    await rejected;
  });

  test('大量のstderrも末尾2KiBに制限し、停止理由を維持する', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const task = extractPreviewImage(
      { data: Buffer.from('segment') },
      new AbortController().signal,
      '/fake/ffmpeg',
    );
    const failure = task.catch((error: unknown) => error as Error);
    child.stderr.write('old-prefix' + 'x'.repeat(100_000));
    child.stderr.write('latest-detail');
    await vi.advanceTimersByTimeAsync(3_000);
    child.emit('close', null, 'SIGKILL');
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('expected rejection');
    expect(error.message).toBe(
      'preview timed out: ' + 'x'.repeat(2048 - 'latest-detail'.length) + 'latest-detail',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
