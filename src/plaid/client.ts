import { setTimeout as delay } from 'node:timers/promises';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import type { PlaidConfig } from '../config.js';

export function createPlaidClient(cfg: PlaidConfig): PlaidApi {
  const configuration = new Configuration({
    basePath: PlaidEnvironments[cfg.env],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': cfg.clientId,
        'PLAID-SECRET': cfg.secret,
      },
    },
  });
  return new PlaidApi(configuration);
}

export type PlaidErrorKind = 'relink' | 'not-ready' | 'retryable' | 'fatal';

export class PlaidRequestError extends Error {
  readonly kind: PlaidErrorKind;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(
    message: string,
    kind: PlaidErrorKind,
    code: string | null,
    requestId: string | null,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'PlaidRequestError';
    this.kind = kind;
    this.code = code;
    this.requestId = requestId;
  }
}

const RELINK_CODES = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT']);

interface AxiosLikeError {
  message?: unknown;
  response?: {
    status?: unknown;
    data?: {
      error_type?: unknown;
      error_code?: unknown;
      error_message?: unknown;
      request_id?: unknown;
    };
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function classifyPlaidError(err: unknown): PlaidRequestError {
  if (err instanceof PlaidRequestError) return err;
  const e = (typeof err === 'object' && err !== null ? err : {}) as AxiosLikeError;
  const response = e.response;
  if (!response) {
    const message = str(e.message) ?? String(err);
    return new PlaidRequestError(`Plaid network error: ${message}`, 'retryable', null, null, err);
  }
  const status = typeof response.status === 'number' ? response.status : 0;
  const code = str(response.data?.error_code);
  const type = str(response.data?.error_type);
  const requestId = str(response.data?.request_id);
  const detail = str(response.data?.error_message) ?? `HTTP ${status}`;
  const message = `Plaid ${code ?? `HTTP ${status}`}: ${detail}`;

  let kind: PlaidErrorKind;
  if (code !== null && RELINK_CODES.has(code)) kind = 'relink';
  else if (code === 'PRODUCT_NOT_READY') kind = 'not-ready';
  else if (status === 429 || status >= 500 || type === 'RATE_LIMIT_EXCEEDED') kind = 'retryable';
  else kind = 'fatal';

  return new PlaidRequestError(message, kind, code, requestId, err);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => delay(ms).then(() => undefined));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const classified = classifyPlaidError(err);
      if (classified.kind !== 'retryable' || attempt >= attempts) throw classified;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
