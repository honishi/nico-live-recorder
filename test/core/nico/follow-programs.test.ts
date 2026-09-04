import {
  fetchFollowingOnAirPrograms,
  NotAuthenticatedError,
} from '../../../src/main/core/nico/follow-programs';

function respond(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('fetchFollowingOnAirPrograms', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('API の JSON を放送の一覧にし、壊れた項目は捨てる', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      respond(200, {
        data: {
          programs: [
            {
              id: 'lv1',
              title: 'a',
              watchPageUrl: 'https://live.nicovideo.jp/watch/lv1',
              programProvider: { id: 123, name: 'alice', icon: 'https://i/1.png' },
              socialGroup: { id: 'co1', name: 'g' },
              beginAt: 1_700_000_000_000,
              isFollowerOnly: true,
            },
            { id: 'lv2', title: 'b', beginAt: 'not a date' },
            { title: 'no id' },
            null,
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const programs = await fetchFollowingOnAirPrograms('user_session=abc');

    expect(programs).toHaveLength(2);
    expect(programs[0]).toMatchObject({
      id: 'lv1',
      providerId: '123',
      providerName: 'alice',
      socialGroupId: 'co1',
      isFollowerOnly: true,
    });
    expect(programs[0].beginAt?.getTime()).toBe(1_700_000_000_000);
    expect(programs[1]).toMatchObject({
      id: 'lv2',
      watchPageUrl: 'https://live.nicovideo.jp/watch/lv2',
      beginAt: undefined,
      isFollowerOnly: false,
    });
    const init = fetchMock.mock.calls[0][1];
    expect((init?.headers as Record<string, string>)['cookie']).toBe('user_session=abc');
  });

  test('未認証 (401 / 302) は NotAuthenticatedError、その他の失敗は通常の例外', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(401, '')),
    );
    await expect(fetchFollowingOnAirPrograms('x')).rejects.toBeInstanceOf(NotAuthenticatedError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(302, '')),
    );
    await expect(fetchFollowingOnAirPrograms('x')).rejects.toBeInstanceOf(NotAuthenticatedError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(500, 'oops')),
    );
    await expect(fetchFollowingOnAirPrograms('x')).rejects.toThrow(/HTTP 500/);
  });

  test('data.programs が無ければ空配列', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(200, { data: {} })),
    );
    expect(await fetchFollowingOnAirPrograms('x')).toEqual([]);
  });
});
