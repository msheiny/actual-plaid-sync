import { describe, expect, it, vi } from 'vitest';
import {
  classifyPlaidError,
  createPlaidClient,
  PlaidRequestError,
  withRetry,
} from '../../src/plaid/client.js';

function plaidHttpError(status: number, errorType: string, errorCode: string) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: {
      status,
      data: {
        error_type: errorType,
        error_code: errorCode,
        error_message: 'something happened',
        request_id: 'req-123',
      },
    },
  };
}

describe('createPlaidClient', () => {
  it('builds a client exposing the endpoints we use', () => {
    const client = createPlaidClient({ clientId: 'id', secret: 'secret', env: 'sandbox' });
    expect(typeof client.transactionsGet).toBe('function');
    expect(typeof client.accountsGet).toBe('function');
  });
});

describe('classifyPlaidError', () => {
  it.each([['ITEM_LOGIN_REQUIRED'], ['PENDING_EXPIRATION'], ['PENDING_DISCONNECT']])(
    'classifies %s as relink',
    (code) => {
      const err = classifyPlaidError(plaidHttpError(400, 'ITEM_ERROR', code));
      expect(err).toBeInstanceOf(PlaidRequestError);
      expect(err.kind).toBe('relink');
      expect(err.code).toBe(code);
      expect(err.requestId).toBe('req-123');
    },
  );

  it('classifies PRODUCT_NOT_READY as not-ready', () => {
    expect(classifyPlaidError(plaidHttpError(400, 'ITEM_ERROR', 'PRODUCT_NOT_READY')).kind).toBe(
      'not-ready',
    );
  });

  it('classifies HTTP 429 as retryable', () => {
    expect(
      classifyPlaidError(plaidHttpError(429, 'RATE_LIMIT_EXCEEDED', 'TRANSACTIONS_LIMIT')).kind,
    ).toBe('retryable');
  });

  it('classifies RATE_LIMIT_EXCEEDED error_type as retryable regardless of status', () => {
    expect(classifyPlaidError(plaidHttpError(400, 'RATE_LIMIT_EXCEEDED', 'RATE_LIMIT')).kind).toBe(
      'retryable',
    );
  });

  it('classifies HTTP 5xx as retryable', () => {
    expect(classifyPlaidError(plaidHttpError(502, 'API_ERROR', 'INTERNAL_SERVER_ERROR')).kind).toBe(
      'retryable',
    );
  });

  it('classifies errors without a response as retryable network errors', () => {
    const err = classifyPlaidError(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    expect(err.kind).toBe('retryable');
    expect(err.code).toBeNull();
    expect(err.message).toContain('socket hang up');
  });

  it('classifies other Plaid errors as fatal and keeps the code in the message', () => {
    const err = classifyPlaidError(plaidHttpError(400, 'INVALID_INPUT', 'INVALID_ACCESS_TOKEN'));
    expect(err.kind).toBe('fatal');
    expect(err.code).toBe('INVALID_ACCESS_TOKEN');
    expect(err.message).toBe('Plaid INVALID_ACCESS_TOKEN: something happened');
  });

  it('returns an existing PlaidRequestError unchanged', () => {
    const original = new PlaidRequestError('x', 'fatal', 'X', null);
    expect(classifyPlaidError(original)).toBe(original);
  });
});

describe('withRetry', () => {
  it('retries retryable errors with exponential backoff and returns the eventual result', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(plaidHttpError(500, 'API_ERROR', 'INTERNAL_SERVER_ERROR'))
      .mockRejectedValueOnce(plaidHttpError(429, 'RATE_LIMIT_EXCEEDED', 'TRANSACTIONS_LIMIT'))
      .mockResolvedValueOnce('ok');
    await expect(withRetry(fn, { baseDelayMs: 10, sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });

  it('gives up after the configured attempts and throws PlaidRequestError', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(plaidHttpError(503, 'API_ERROR', 'INTERNAL_SERVER_ERROR'));
    const error = await withRetry(fn, { sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlaidRequestError);
    expect((error as PlaidRequestError).kind).toBe('retryable');
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
  });

  it('does not retry relink errors', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(plaidHttpError(400, 'ITEM_ERROR', 'ITEM_LOGIN_REQUIRED'));
    await expect(withRetry(fn, { sleep })).rejects.toMatchObject({
      kind: 'relink',
      code: 'ITEM_LOGIN_REQUIRED',
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry fatal errors', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(plaidHttpError(400, 'INVALID_INPUT', 'INVALID_ACCESS_TOKEN'));
    await expect(withRetry(fn, { sleep })).rejects.toMatchObject({ kind: 'fatal' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
