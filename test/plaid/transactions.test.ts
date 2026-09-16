import { inspect } from 'node:util';
import type { PlaidApi } from 'plaid';
import { describe, expect, it, vi } from 'vitest';
import { PlaidRequestError } from '../../src/plaid/client.js';
import { fetchTransactions, refreshTransactions } from '../../src/plaid/transactions.js';

function rawTxn(id: string, overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    account_id: 'acc-1',
    amount: 12.34,
    date: '2026-09-10',
    authorized_date: '2026-09-09',
    name: 'SQ *COFFEE SHOP',
    merchant_name: 'Coffee Shop',
    pending: false,
    pending_transaction_id: null,
    ...overrides,
  };
}

function rawAccount(id: string) {
  return {
    account_id: id,
    name: 'Plaid Checking',
    official_name: null,
    mask: '0000',
    type: 'depository',
    subtype: 'checking',
  };
}

function fakeClient() {
  const transactionsGet = vi.fn();
  const itemGet = vi.fn();
  const transactionsRefresh = vi.fn();
  const client = {
    transactionsGet,
    itemGet,
    transactionsRefresh,
    accountsGet: vi.fn(),
  } as unknown as PlaidApi;
  return { client, transactionsGet, itemGet, transactionsRefresh };
}

describe('refreshTransactions', () => {
  it('checks the initialized products before refreshing', async () => {
    const { client, itemGet, transactionsRefresh } = fakeClient();
    itemGet.mockResolvedValue({ data: { item: { products: ['auth', 'transactions'] } } });
    transactionsRefresh.mockResolvedValue({ data: {} });

    await refreshTransactions(client, 'access-sandbox-abc');

    expect(itemGet).toHaveBeenCalledWith({ access_token: 'access-sandbox-abc' });
    expect(transactionsRefresh).toHaveBeenCalledWith({ access_token: 'access-sandbox-abc' });
  });

  it('falls back to billed_products when products is absent', async () => {
    const { client, itemGet, transactionsRefresh } = fakeClient();
    itemGet.mockResolvedValue({ data: { item: { billed_products: ['transactions'] } } });
    transactionsRefresh.mockResolvedValue({ data: {} });

    await refreshTransactions(client, 'tok');
    expect(transactionsRefresh).toHaveBeenCalledTimes(1);
  });

  it('fails without refreshing when Transactions is not initialized', async () => {
    const { client, itemGet, transactionsRefresh } = fakeClient();
    itemGet.mockResolvedValue({ data: { item: { products: ['auth'] } } });

    const error = await refreshTransactions(client, 'tok').catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'PlaidRequestError',
      kind: 'fatal',
      code: 'TRANSACTIONS_NOT_INITIALIZED',
    });
    expect(transactionsRefresh).not.toHaveBeenCalled();
  });

  it('retries transient item and refresh failures', async () => {
    const { client, itemGet, transactionsRefresh } = fakeClient();
    const retryable = {
      message: 'server error',
      response: {
        status: 500,
        data: { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' },
      },
    };
    itemGet.mockRejectedValueOnce(retryable).mockResolvedValueOnce({
      data: { item: { products: ['transactions'] } },
    });
    transactionsRefresh.mockRejectedValueOnce(retryable).mockResolvedValueOnce({ data: {} });

    await refreshTransactions(client, 'tok');
    expect(itemGet).toHaveBeenCalledTimes(2);
    expect(transactionsRefresh).toHaveBeenCalledTimes(2);
  });

  it.each(['itemGet', 'transactionsRefresh'] as const)(
    'classifies unsupported %s errors and redacts Axios secrets',
    async (operation) => {
      const { client, itemGet, transactionsRefresh } = fakeClient();
      const secret = 'super-secret';
      const unsupported = {
        message: 'Request failed',
        isAxiosError: true,
        config: {
          headers: { 'PLAID-SECRET': secret },
          data: { access_token: 'access-token-secret' },
        },
        response: {
          status: 400,
          data: {
            error_type: 'ITEM_ERROR',
            error_code: 'PRODUCTS_NOT_SUPPORTED',
            request_id: 'req-1',
          },
        },
      };
      if (operation === 'itemGet') itemGet.mockRejectedValue(unsupported);
      else {
        itemGet.mockResolvedValue({ data: { item: { products: ['transactions'] } } });
        transactionsRefresh.mockRejectedValue(unsupported);
      }

      const error = await refreshTransactions(client, 'tok').catch((e: unknown) => e);
      expect(error).toMatchObject({ kind: 'fatal', code: 'PRODUCTS_NOT_SUPPORTED' });
      expect(inspect(error, { depth: null })).not.toContain(secret);
      expect(inspect(error, { depth: null })).not.toContain('access-token-secret');
      expect(itemGet).toHaveBeenCalledTimes(1);
      expect(transactionsRefresh).toHaveBeenCalledTimes(operation === 'itemGet' ? 0 : 1);
    },
  );
});

describe('fetchTransactions', () => {
  it('pages with count/offset until total_transactions is reached', async () => {
    const { client, transactionsGet } = fakeClient();
    const accounts = [rawAccount('acc-1'), rawAccount('acc-2')];
    const page1 = Array.from({ length: 500 }, (_, i) => rawTxn(`t${i}`));
    const page2 = [rawTxn('t500'), rawTxn('t501')];
    transactionsGet
      .mockResolvedValueOnce({ data: { accounts, transactions: page1, total_transactions: 502 } })
      .mockResolvedValueOnce({ data: { accounts, transactions: page2, total_transactions: 502 } });

    const result = await fetchTransactions(
      client,
      'access-sandbox-abc',
      '2026-08-14',
      '2026-09-13',
    );

    expect(transactionsGet).toHaveBeenCalledTimes(2);
    expect(transactionsGet.mock.calls[0]?.[0]).toEqual({
      access_token: 'access-sandbox-abc',
      start_date: '2026-08-14',
      end_date: '2026-09-13',
      options: { count: 500, offset: 0 },
    });
    expect(transactionsGet.mock.calls[1]?.[0]).toMatchObject({
      options: { count: 500, offset: 500 },
    });
    expect(result.transactions).toHaveLength(502);
    expect(result.accounts.map((a) => a.accountId)).toEqual(['acc-1', 'acc-2']);
  });

  it('returns accounts even when there are no transactions', async () => {
    const { client, transactionsGet } = fakeClient();
    transactionsGet.mockResolvedValueOnce({
      data: { accounts: [rawAccount('acc-9')], transactions: [], total_transactions: 0 },
    });
    const result = await fetchTransactions(client, 'tok', '2026-08-14', '2026-09-13');
    expect(transactionsGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      accounts: [
        {
          accountId: 'acc-9',
          name: 'Plaid Checking',
          officialName: null,
          mask: '0000',
          type: 'depository',
          subtype: 'checking',
        },
      ],
      transactions: [],
    });
  });

  it('maps Plaid fields to PlaidTxn', async () => {
    const { client, transactionsGet } = fakeClient();
    transactionsGet.mockResolvedValueOnce({
      data: {
        accounts: [rawAccount('acc-1')],
        transactions: [
          rawTxn('posted-1', { pending_transaction_id: 'pending-1' }),
          rawTxn('pending-2', { pending: true, authorized_date: null, merchant_name: undefined }),
        ],
        total_transactions: 2,
      },
    });
    const result = await fetchTransactions(client, 'tok', '2026-08-14', '2026-09-13');
    expect(result.transactions).toEqual([
      {
        transactionId: 'posted-1',
        accountId: 'acc-1',
        amount: 12.34,
        date: '2026-09-10',
        authorizedDate: '2026-09-09',
        name: 'SQ *COFFEE SHOP',
        merchantName: 'Coffee Shop',
        pending: false,
        pendingTransactionId: 'pending-1',
      },
      {
        transactionId: 'pending-2',
        accountId: 'acc-1',
        amount: 12.34,
        date: '2026-09-10',
        authorizedDate: null,
        name: 'SQ *COFFEE SHOP',
        merchantName: null,
        pending: true,
        pendingTransactionId: null,
      },
    ]);
  });

  it('surfaces Plaid errors as PlaidRequestError without retrying non-retryable ones', async () => {
    const { client, transactionsGet } = fakeClient();
    transactionsGet.mockRejectedValue({
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', request_id: 'r1' },
      },
    });
    const error = await fetchTransactions(client, 'tok', '2026-08-14', '2026-09-13').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PlaidRequestError);
    expect((error as PlaidRequestError).kind).toBe('relink');
    expect(transactionsGet).toHaveBeenCalledTimes(1);
  });
});
