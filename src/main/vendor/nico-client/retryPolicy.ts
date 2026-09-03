import { ViewUriNotReceivedError, ViewUriTimeoutError } from './errors';
import { HttpError } from './internal/httpClient';

const RETRYABLE_UNDICI_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const RETRYABLE_NODE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED']);
const RETRYABLE_MESSAGE_PATTERNS = [
  /Unexpected server response:\s*(?:429|5\d{2})/i,
  /TLS WRAP/i,
  /socket hang up/i,
  /getaddrinfo ENOTFOUND/i,
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const extractStatusCode = (error: unknown): number | undefined => {
  if (error instanceof HttpError) {
    return error.statusCode;
  }
  if (isRecord(error) && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  return undefined;
};

const extractErrorCode = (error: unknown): string | undefined => {
  if (isRecord(error) && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
};

const extractMessage = (error: unknown): string | undefined => {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return undefined;
};

export function isRetryableNicoHttpStatus(statusCode: number): boolean {
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}

export function isRetryableNicoError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof ViewUriNotReceivedError) {
    return true;
  }
  if (error instanceof ViewUriTimeoutError) {
    return true;
  }

  const statusCode = extractStatusCode(error);
  if (typeof statusCode === 'number' && isRetryableNicoHttpStatus(statusCode)) {
    return true;
  }

  const code = extractErrorCode(error);
  if (typeof code === 'string') {
    const upperCode = code.toUpperCase();
    if (upperCode === 'VIEW_URI_NOT_RECEIVED') {
      return true;
    }
    if (upperCode === 'VIEW_URI_TIMEOUT') {
      return true;
    }
    if (RETRYABLE_UNDICI_ERROR_CODES.has(upperCode)) {
      return true;
    }
    if (RETRYABLE_NODE_ERROR_CODES.has(upperCode)) {
      return true;
    }
  }

  const message = extractMessage(error);
  if (message) {
    for (const pattern of RETRYABLE_MESSAGE_PATTERNS) {
      if (pattern.test(message)) {
        return true;
      }
    }
  }

  return false;
}
