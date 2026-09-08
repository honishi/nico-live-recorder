import { Writable } from 'node:stream';
import {
  downloadMetrics,
  downloadTimeshiftTrack,
} from '../../../src/main/core/nico/timeshift-download';
import { TimeshiftError } from '../../../src/main/core/nico/timeshift-common';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function segments(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    seq: 10 + index,
    duration: 6,
    uri: `https://example.test/${index}`,
  }));
}

function output() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { sink, chunks };
}

afterEach(() => vi.unstubAllGlobals());

test.each([1, 5])(
  '同時取得を最大%sに制限し、応答が逆順でも元の番号順に保存する',
  async (threads) => {
    const requested = Array.from({ length: 5 }, () => deferred<void>());
    const responses = Array.from({ length: 5 }, () => deferred<Response>());
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const index = Number(new URL(url).pathname.slice(1));
        requested[index].resolve();
        return responses[index].promise;
      }),
    );
    const { sink, chunks } = output();
    const metrics = downloadMetrics();
    const task = downloadTimeshiftTrack(
      segments(5),
      sink,
      [],
      threads,
      new AbortController().signal,
      metrics,
    );
    if (threads === 5) {
      await requested[4].promise;
      for (let index = 4; index >= 1; index -= 1)
        responses[index].resolve(new Response(String(index)));
      expect(chunks).toEqual([]);
      responses[0].resolve(new Response('0'));
    } else {
      for (let index = 0; index < 5; index += 1) {
        await requested[index].promise;
        responses[index].resolve(new Response(String(index)));
      }
    }
    expect(await task).toMatchObject({ reason: 'endlist', segments: 5, firstSeq: 10, lastSeq: 14 });
    expect(chunks).toEqual(['0', '1', '2', '3', '4']);
    expect(metrics.maxConcurrentRequests).toBe(threads);
    expect(metrics.requestCount).toBe(5);
  },
);

test('書き込みが詰まっても次を先読みし、先読み窓を超えて取得しない', async () => {
  const writing = deferred<void>();
  const requestedNext = deferred<void>();
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(url);
      if (url.endsWith('/1')) requestedNext.resolve();
      return Promise.resolve(new Response('data'));
    }),
  );
  let release!: () => void;
  let writes = 0;
  const sink = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, done) {
      if (writes++ === 0) {
        release = done;
        writing.resolve();
      } else done();
    },
  });
  const task = downloadTimeshiftTrack(
    segments(4),
    sink,
    [],
    1,
    new AbortController().signal,
    downloadMetrics(),
  );
  await Promise.all([writing.promise, requestedNext.promise]);
  expect(urls).toHaveLength(2);
  release();
  expect((await task).segments).toBe(4);
});

test('欠落は件数に残し、後続の番号を詰めない', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/1') ? new Response(null, { status: 404 }) : new Response('saved'),
      ),
    ),
  );
  const metrics = downloadMetrics();
  const result = await downloadTimeshiftTrack(
    segments(3),
    output().sink,
    [],
    5,
    new AbortController().signal,
    metrics,
  );
  expect(result).toMatchObject({ segments: 2, firstSeq: 10, lastSeq: 12 });
  expect(metrics).toMatchObject({ missingSegments: 1, httpErrors: [404], requestCount: 3 });
});

test.each(['failure', 'abort'])(
  '先読み中の%sで全要求を停止し、未処理の失敗を残さない',
  async (scenario) => {
    const ready = deferred<void>();
    const failure = deferred<Response>();
    const stop = new AbortController();
    let started = 0;
    let cancelled = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (++started === 3) ready.resolve();
        if (scenario === 'failure' && url.endsWith('/2')) return failure.promise;
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => {
              cancelled += 1;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      }),
    );
    const metrics = downloadMetrics();
    const task = downloadTimeshiftTrack(segments(5), output().sink, [], 3, stop.signal, metrics);
    const rejected = expect(task).rejects.toThrow();
    await ready.promise;
    if (scenario === 'failure') failure.resolve(new Response(null, { status: 403 }));
    else stop.abort();
    await rejected;
    expect(started).toBe(3);
    expect(cancelled).toBe(scenario === 'failure' ? 2 : 3);
  },
);

test('出力待機中の中断でも終了する', async () => {
  const writing = deferred<void>();
  let release!: () => void;
  const sink = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, done) {
      release = done;
      writing.resolve();
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('data'))),
  );
  const stop = new AbortController();
  const task = downloadTimeshiftTrack(segments(5), sink, [], 1, stop.signal, downloadMetrics());
  const rejected = expect(task).rejects.toThrow();
  await writing.promise;
  stop.abort();
  await rejected;
  release();
  sink.end();
});

test('巨大な応答は先読みメモリの上限で停止する', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(new Uint8Array(32 * 1024 * 1024 + 1)))),
  );
  await expect(
    downloadTimeshiftTrack(
      segments(1),
      output().sink,
      [],
      1,
      new AbortController().signal,
      downloadMetrics(),
    ),
  ).rejects.toThrow(TimeshiftError);
});

test('並列取得でも鍵・初期化情報の切り替えと明示IVを維持する', async () => {
  const { default: crypto } = await import('node:crypto');
  const keys = [Buffer.alloc(16, 1), Buffer.alloc(16, 2)];
  const ivs = [Buffer.alloc(16), Buffer.alloc(16, 9), Buffer.alloc(16)];
  ivs[0].writeBigUInt64BE(10n, 8);
  ivs[2].writeBigUInt64BE(12n, 8);
  const encrypted = ['first', 'second', 'third'].map((content, index) => {
    const cipher = crypto.createCipheriv('aes-128-cbc', keys[index === 2 ? 1 : 0], ivs[index]);
    return Buffer.concat([cipher.update(content), cipher.final()]);
  });
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(url);
      const name = new URL(url).pathname.slice(1);
      if (name.startsWith('map')) return Promise.resolve(new Response(name));
      if (name.startsWith('key')) return Promise.resolve(new Response(keys[Number(name.slice(3))]));
      return Promise.resolve(new Response(encrypted[Number(name)]));
    }),
  );
  const tracks = segments(3).map((segment, index) => ({
    ...segment,
    mapUri: `https://example.test/map${index === 2 ? 1 : 0}`,
    key: {
      method: 'AES-128',
      uri: `https://example.test/key${index === 2 ? 1 : 0}`,
      ...(index === 1 ? { iv: ivs[1].toString('hex') } : {}),
    },
  }));
  const { sink, chunks } = output();
  await downloadTimeshiftTrack(
    tracks,
    sink,
    [],
    5,
    new AbortController().signal,
    downloadMetrics(),
  );
  expect(chunks.join('')).toBe('map0firstsecondmap1third');
  expect(urls.filter((url) => url.endsWith('/key0'))).toHaveLength(1);
  expect(urls.filter((url) => url.endsWith('/map0'))).toHaveLength(1);
});
