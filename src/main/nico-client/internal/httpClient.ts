import { request, Dispatcher } from 'undici';
import setCookieParser from 'set-cookie-parser';
import { URLSearchParams } from 'url';
import { pipeline, Readable, Transform } from 'stream';
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  createGunzip,
  createBrotliDecompress,
  createInflate,
} from 'zlib';

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: string | Buffer | URLSearchParams;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly url: string,
  ) {
    super(`HTTP ${statusCode} (${url})`);
    this.name = 'HttpError';
  }
}

export type ContentEncoding = 'gzip' | 'br' | 'deflate' | 'identity';

// pipe() はソース側のエラーを宛先へ伝播しないため、pipeline() でエラー伝播と両ストリームの破棄を
// 一元化する。エラーは戻り値のストリームに伝播し、for-await 側で reject される。
export function createDecodedBodyStream(
  rawStream: Readable,
  encoding: ContentEncoding | undefined,
): Readable {
  if (!encoding || encoding === 'identity') {
    return rawStream;
  }
  return pipeline(rawStream, createDecompressor(encoding), () => {
    // 消費側の途中離脱による ERR_STREAM_PREMATURE_CLOSE を含め、ここでは何もしない
  });
}

function createDecompressor(encoding: 'gzip' | 'br' | 'deflate'): Transform {
  switch (encoding) {
    case 'gzip':
      return createGunzip();
    case 'br':
      return createBrotliDecompress();
    case 'deflate':
      return createInflate();
  }
}

const DEFAULT_HEADERS: Record<string, string> = {
  accept: '*/*',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'ja',
  origin: 'https://live.nicovideo.jp',
  referer: 'https://live.nicovideo.jp/',
  'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
};

export class CookieJar {
  private readonly jar = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    if (initial) {
      for (const [key, value] of Object.entries(initial)) {
        this.jar.set(key, value);
      }
    }
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  load(cookies: Record<string, string> | undefined): void {
    if (!cookies) {
      return;
    }
    for (const [key, value] of Object.entries(cookies)) {
      this.jar.set(key, value);
    }
  }

  serialize(): string | undefined {
    if (this.jar.size === 0) {
      return undefined;
    }
    return Array.from(this.jar.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  storeFromSetCookie(setCookieHeader: string[] | string | undefined): void {
    if (!setCookieHeader) {
      return;
    }
    const parsed = setCookieParser.parse(setCookieHeader, { map: false });
    for (const cookie of parsed) {
      if (cookie.name && cookie.value !== undefined) {
        this.jar.set(cookie.name, cookie.value);
      }
    }
  }
}

export class HttpClient {
  constructor(
    public readonly userAgent: string,
    private readonly cookieJar: CookieJar,
  ) {}

  private async rawRequest(
    method: Dispatcher.HttpMethod,
    url: string,
    options: RequestOptions,
  ): Promise<Dispatcher.ResponseData> {
    const headers = this.buildHeaders(options.headers);

    const body = options.body instanceof URLSearchParams ? options.body.toString() : options.body;

    const response = await request(url, {
      method,
      headers,
      body,
      signal: options.signal ?? undefined,
    });

    this.cookieJar.storeFromSetCookie(response.headers['set-cookie']);
    return response;
  }

  async request(
    method: Dispatcher.HttpMethod,
    url: string,
    options: RequestOptions = {},
    maxRedirects = 5,
  ): Promise<Dispatcher.ResponseData> {
    let currentUrl = url;
    let currentMethod = method;
    let currentBody = options.body;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
      const response = await this.rawRequest(currentMethod, currentUrl, {
        ...options,
        body: currentBody,
      });

      if (!this.isRedirectStatus(response.statusCode)) {
        return response;
      }

      const locationHeader = this.getHeader(response.headers, 'location');
      if (!locationHeader) {
        return response;
      }

      await this.discardBody(response.body);

      if (redirectCount === maxRedirects) {
        throw new HttpError(response.statusCode, 'Too many redirects', currentUrl);
      }

      currentUrl = this.resolveLocation(currentUrl, locationHeader);

      if (
        currentMethod !== 'GET' &&
        (response.statusCode === 303 || response.statusCode === 301 || response.statusCode === 302)
      ) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
    }

    throw new HttpError(500, 'Unexpected redirect handling error', url);
  }

  async getText(url: string, options?: RequestOptions): Promise<string> {
    const response = await this.request('GET', url, options);
    const text = await this.readBodyAsText(response);
    if (response.statusCode >= 400) {
      throw new HttpError(response.statusCode, text, url);
    }
    return text;
  }

  async post(url: string, options: RequestOptions = {}): Promise<Dispatcher.ResponseData> {
    const response = await this.request('POST', url, {
      ...options,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(options.headers ?? {}),
      },
    });
    if (response.statusCode >= 400) {
      const body = await this.readBodyAsText(response);
      throw new HttpError(response.statusCode, body, url);
    }
    return response;
  }

  async *stream(url: string, options?: RequestOptions): AsyncGenerator<Uint8Array, void, unknown> {
    const response = await this.request('GET', url, options);
    if (response.statusCode >= 400) {
      const body = await this.readBodyAsText(response);
      throw new HttpError(response.statusCode, body, url);
    }

    const encoding = this.normalizeEncoding(response.headers['content-encoding']);
    const rawStream = response.body as unknown as Readable;
    const bodyStream = createDecodedBodyStream(rawStream, encoding);
    try {
      for await (const chunk of bodyStream) {
        yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      }
    } finally {
      bodyStream.destroy();
      rawStream.destroy();
    }
  }

  private async readBodyAsText(response: Dispatcher.ResponseData): Promise<string> {
    const buffer = await this.collectBody(response.body);
    const encoding = this.normalizeEncoding(response.headers['content-encoding']);
    return this.decodeBuffer(buffer, encoding);
  }

  private async collectBody(body: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else {
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks);
  }

  private decodeBuffer(buffer: Buffer, encoding?: string): string {
    if (!encoding || encoding === 'identity') {
      return buffer.toString('utf-8');
    }
    try {
      switch (encoding) {
        case 'gzip':
          return gunzipSync(buffer).toString('utf-8');
        case 'br':
          return brotliDecompressSync(buffer).toString('utf-8');
        case 'deflate':
          return inflateSync(buffer).toString('utf-8');
        default:
          return buffer.toString('utf-8');
      }
    } catch {
      return buffer.toString('utf-8');
    }
  }

  private isRedirectStatus(status: number): boolean {
    return status >= 300 && status < 400;
  }

  private resolveLocation(baseUrl: string, location: string): string {
    try {
      return new URL(location, baseUrl).toString();
    } catch {
      return location;
    }
  }

  private async discardBody(body: Readable): Promise<void> {
    const maybeDump = (body as Readable & { dump?: () => Promise<void> }).dump;
    if (typeof maybeDump === 'function') {
      await maybeDump.call(body);
      return;
    }
    for await (const _chunk of body) {
      // 本文を捨てる
    }
  }

  private buildHeaders(additional?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      'user-agent': this.userAgent,
      ...additional,
    };
    const cookieHeader = this.cookieJar.serialize();
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }
    return headers;
  }

  private normalizeEncoding(encoding: string | string[] | undefined): ContentEncoding | undefined {
    if (!encoding) {
      return undefined;
    }
    const value = Array.isArray(encoding) ? encoding[0] : encoding;
    const normalized = value?.toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (normalized.includes('gzip')) {
      return 'gzip';
    }
    if (normalized.includes('br')) {
      return 'br';
    }
    if (normalized.includes('deflate')) {
      return 'deflate';
    }
    if (normalized === 'identity') {
      return 'identity';
    }
    return undefined;
  }

  private getHeader(headers: Dispatcher.ResponseData['headers'], key: string): string | undefined {
    const value = headers[key] ?? headers[key.toLowerCase()];
    if (!value) {
      return undefined;
    }
    return Array.isArray(value) ? value[0] : value;
  }
}
