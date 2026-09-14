import type { PlaidApi } from 'plaid';
import { describe, expect, it, vi } from 'vitest';
import { PlaidRequestError } from '../../src/plaid/client.js';
import { fetchTransactions } from '../../src/plaid/transactions.js';

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

function fakeClient() {
  const transactionsGet = vi.fn();
  const client = { transactionsGet, accountsGet: vi.fn() } as unknown as PlaidApi;
  return { client, transactionsGet };
}

describe('fetchTransactions', () => {
  it('pages with count/offset until total_transactions is reached', async () => {
    const { client, transactionsGet } = fakeClient();
    const accounts = [{ account_id: 'acc-1' }, { account_id: 'acc-2' }];
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
    expect(result.accountIds).toEqual(['acc-1', 'acc-2']);
  });

  it('returns account ids even when there are no transactions', async () => {
    const { client, transactionsGet } = fakeClient();
    transactionsGet.mockResolvedValueOnce({
      data: { accounts: [{ account_id: 'acc-9' }], transactions: [], total_transactions: 0 },
    });
    const result = await fetchTransactions(client, 'tok', '2026-08-14', '2026-09-13');
    expect(transactionsGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ accountIds: ['acc-9'], transactions: [] });
  });

  it('maps Plaid fields to PlaidTxn', async () => {
    const { client, transactionsGet } = fakeClient();
    transactionsGet.mockResolvedValueOnce({
      data: {
        accounts: [{ account_id: 'acc-1' }],
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
