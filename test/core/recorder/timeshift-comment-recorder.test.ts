import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getProtoRegistry } from '../../../src/main/vendor/nico-client/internal/protoLoader';
import {
  convertTimeshiftComment,
  recordTimeshiftComments,
  TIMESHIFT_COMMENT_LIMITS,
} from '../../../src/main/core/recorder/timeshift-comment-recorder';
import { CSV_HEADER } from '../../../src/main/core/recorder/comment-csv';

let dir: string;
let output: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nlr-ts-comments-'));
  output = path.join(dir, 'comments.csv');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});
const message = (id: string, seconds: number, nanos = 0, no = 1) => ({
  meta: { id, at: { seconds, nanos }, origin: { chat: { live_id: '42' } } },
  message: {
    chat: {
      content: id || `no-${no}`,
      no,
      vpos: 800,
      raw_user_id: '123',
      hashed_user_id: 'hash',
      account_status: 1,
    },
  },
});
async function routes(messages: unknown[], options: { cycle?: boolean; truncated?: boolean } = {}) {
  const registry = await getProtoRegistry();
  const entry = (value: object) =>
    registry.ChunkedEntry.encodeDelimited(registry.ChunkedEntry.fromObject(value)).finish();
  const forward = registry.ChunkedMessage.encodeDelimited(
    registry.ChunkedMessage.fromObject(message('forward', 999)),
  ).finish();
  const data: Record<string, Uint8Array> = {
    'https://example.test/view?at=now': entry({ next: { at: 111 } }),
    'https://example.test/view?at=111': Buffer.concat([
      entry({ backward: { segment: { uri: 'https://example.test/back' } } }),
      entry({ segment: { uri: 'https://example.test/forward' } }),
      entry({ next: { at: 222 } }),
    ]),
    'https://example.test/back': registry.PackedSegment.encode(
      registry.PackedSegment.fromObject({
        messages,
        ...(options.cycle ? { next: { uri: 'https://example.test/back' } } : {}),
      }),
    ).finish(),
    'https://example.test/forward': options.truncated ? forward.slice(0, -1) : forward,
  };
  const mocked = vi.fn((url: string, _init?: RequestInit) => {
    if (!data[url]) throw new Error('unexpected request');
    return Promise.resolve(new Response(Buffer.from(data[url])));
  });
  vi.stubGlobal('fetch', mocked);
  return mocked;
}

test('全属性・元vposを保持し、未指定の装飾には既存CSVの既定値を使う', () => {
  const converted = convertTimeshiftComment(message('id', 1000, 123456789))!;
  expect(converted.comment).toMatchObject({
    id: 'id',
    liveId: 42,
    no: 1,
    vpos: 800,
    rawUserId: 123,
    hashedUserId: 'hash',
    accountStatus: 'Premium',
    position: 'naka',
    size: 'medium',
    font: 'defont',
    opacity: 'Normal',
    color: 'white',
  });
  expect(converted.comment.at.toISOString()).toBe('1970-01-01T00:16:40.123Z');
  const styled = message('styled', 1000);
  Object.assign(styled.message.chat, {
    modifier: { position: 2, size: 2, font: 1, opacity: 1, full_color: { r: 1, g: 2, b: 3 } },
  });
  expect(convertTimeshiftComment(styled)?.comment).toMatchObject({
    position: 'ue',
    size: 'big',
    font: 'mincho',
    opacity: 'Translucent',
    color: { r: 1, g: 2, b: 3 },
  });
});

test('履歴・直近分を重複排除し、ナノ秒・番号・取得順で安定ソートしたBOM付き14列CSVを保存する', async () => {
  const mocked = await routes([
    message('later', 1001),
    message('same-first', 1000, 2, 9),
    message('same-second', 1000, 2, 9),
    message('nano-first', 1000, 1, 10),
    message('forward', 999),
    message('quoted,\n"text"', 1002),
  ]);
  const callback = vi.fn();
  const result = await recordTimeshiftComments(
    'https://example.test/view',
    output,
    new AbortController().signal,
    callback,
  );
  expect(result).toMatchObject({ status: 'complete', count: 6, duplicates: 1, sorted: true });
  const csv = await fs.readFile(output, 'utf8');
  expect(csv.startsWith(CSV_HEADER)).toBe(true);
  expect(CSV_HEADER.trim().split(',')).toHaveLength(14);
  const ordered = ['forward', 'nano-first', 'same-first', 'same-second', 'later'];
  expect(ordered.map((id) => csv.indexOf(`"${id}"`))).toEqual(
    ordered.map((id) => csv.indexOf(`"${id}"`)).sort((a, b) => a - b),
  );
  expect(csv).toContain('"quoted,\n""text"""');
  expect(callback).toHaveBeenCalledTimes(6);
  expect(mocked).toHaveBeenCalledTimes(4);
});

test.each(['cycle', 'truncated', 'count', 'bytes', 'pages', 'invalid-time'] as const)(
  '%s でも取得済み分を残し、完了としない',
  async (kind) => {
    const messages: unknown[] = [message('saved', 1000), message('other', 1001)];
    if (kind === 'invalid-time')
      messages.push({ meta: { id: 'invalid' }, message: { chat: { content: 'bad' } } });
    await routes(messages, { cycle: kind === 'cycle', truncated: kind === 'truncated' });
    const limits = {
      ...TIMESHIFT_COMMENT_LIMITS,
      ...(kind === 'count' ? { count: 1 } : {}),
      ...(kind === 'bytes' ? { bytes: 1 } : {}),
      ...(kind === 'pages' ? { packedPages: 0 } : {}),
    };
    const result = await recordTimeshiftComments(
      'https://example.test/view',
      output,
      new AbortController().signal,
      undefined,
      limits,
    );
    expect(result.status).toBe('partial');
    expect((await fs.readFile(output, 'utf8')).startsWith(CSV_HEADER)).toBe(true);
    if (!['bytes', 'pages'].includes(kind)) expect(result.count).toBeGreaterThan(0);
  },
);

test('停止はソートを開始せず取得済みCSVを残す', async () => {
  await routes([message('first', 1001), message('second', 1000)]);
  const stop = new AbortController();
  const result = await recordTimeshiftComments(
    'https://example.test/view',
    output,
    stop.signal,
    () => stop.abort(),
  );
  expect(result).toMatchObject({ status: 'partial', count: 1, sorted: false, aborted: true });
  expect(await fs.readFile(output, 'utf8')).toContain('"first"');
});

test('ソート結果の置換失敗でも取得済みCSVを失わない', async () => {
  await routes([message('saved', 1000)]);
  vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk unavailable'));
  const result = await recordTimeshiftComments(
    'https://example.test/view',
    output,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: 'partial',
    sorted: false,
    reason: 'COMMENT_SORT_FAILED',
    count: 2,
  });
  expect(await fs.readFile(output, 'utf8')).toContain('"saved"');
  expect(await fs.readdir(dir)).toEqual(['comments.csv']);
});

test.each([25_000, 61_000])('View応答が%s msかかる場合の待機と上限を確認する', async (delayMs) => {
  const mocked = await routes([message('saved', 1000)]);
  const respond = mocked.getMockImplementation()!;
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
    return controller.signal;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  mocked.mockImplementation((url, init) => {
    if (!url.endsWith('at=now')) return respond(url, init);
    const waiting = new Promise<Response>((resolve, reject) => {
      setTimeout(() => {
        void respond(url, init).then(resolve, reject);
      }, delayMs);
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('timeout', 'TimeoutError')),
        { once: true },
      );
    });
    entered();
    return waiting;
  });
  const pending = recordTimeshiftComments(
    'https://example.test/view',
    output,
    new AbortController().signal,
  );
  await ready;
  await vi.advanceTimersByTimeAsync(Math.min(delayMs, 60_000));
  const result = await pending;
  expect(result).toMatchObject(
    delayMs < 60_000
      ? { status: 'complete', count: 2 }
      : { status: 'partial', reason: 'COMMENT_VIEW_TIMEOUT', count: 0 },
  );
  expect(result.viewRequests?.[0]).toMatchObject({ entries: delayMs < 60_000 ? 1 : 0 });
});

test('本文待機のAbortErrorもViewタイムアウトとして記録し、利用者の停止と区別する', async () => {
  await routes([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('body aborted', 'AbortError'));
            },
          }),
        ),
    ),
  );
  const result = await recordTimeshiftComments(
    'https://example.test/view',
    output,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: 'partial',
    reason: 'COMMENT_VIEW_TIMEOUT',
    aborted: false,
  });
});

test('不正な投稿時刻を含んでも後続を保存し、不正件数と部分取得を報告する', async () => {
  await routes([
    message('before', 1000),
    { meta: { id: 'bad1' }, message: { chat: { content: 'bad' } } },
    message('after', 1002),
    { meta: { id: 'bad2' }, message: { chat: { content: 'bad' } } },
  ]);
  const result = await recordTimeshiftComments(
    'https://example.test/view',
    output,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: 'partial',
    reason: 'INVALID_COMMENT_TIME',
    count: 3,
    invalidCount: 2,
    sorted: true,
  });
  const csv = await fs.readFile(output, 'utf8');
  expect(csv).toContain('before');
  expect(csv).toContain('after');
  expect(csv).not.toContain('bad1');
});

test('overflowed_chatと名前付き色を既存CSVの表現に変換する', () => {
  const source = message('overflow', 1000);
  const converted = convertTimeshiftComment({
    ...source,
    message: { overflowed_chat: { ...source.message.chat, modifier: { named_color: 15 } } },
  });
  expect(converted?.comment).toMatchObject({ content: 'overflow', color: 'green2' });
  expect(converted?.seconds).toBe(1000);
});

test.each([
  'USER_CANCELLED',
  'COMMENT_TOTAL_TIMEOUT',
  'VIDEO_FAILED',
  'SESSION_DISCONNECTED',
  'OUTPUT_MISSING',
])('中断理由%sを部分保存の診断へ残す', async (code) => {
  const { TimeshiftError } = await import('../../../src/main/core/nico/timeshift-common');
  await routes([message('saved', 1000)]);
  const stop = new AbortController();
  const reason =
    code === 'USER_CANCELLED'
      ? new DOMException('stop', 'AbortError')
      : code === 'COMMENT_TOTAL_TIMEOUT'
        ? new DOMException('timeout', 'TimeoutError')
        : new TimeshiftError(code);
  const result = await recordTimeshiftComments(
    'https://example.test/view',
    output,
    stop.signal,
    () => stop.abort(reason),
  );
  expect(result).toMatchObject({
    reason: code,
    status: 'partial',
    count: 1,
    sorted: false,
    aborted: true,
  });
});

test('0件でもbackwardが提供されなければ全履歴を確認した扱いにしない', async () => {
  const registry = await getProtoRegistry();
  const entry = (value: object) =>
    registry.ChunkedEntry.encodeDelimited(registry.ChunkedEntry.fromObject(value)).finish();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          url.includes('/view')
            ? Buffer.concat([
                entry({ segment: { uri: 'https://example.test/empty' } }),
                entry({ next: { at: 123 } }),
              ])
            : Buffer.alloc(0),
        ),
    ),
  );
  const result = await recordTimeshiftComments(
    'https://example.test/view',
    output,
    new AbortController().signal,
  );
  expect(result).toMatchObject({ count: 0, status: 'partial', reason: 'BACKWARD_NOT_PROVIDED' });
});
