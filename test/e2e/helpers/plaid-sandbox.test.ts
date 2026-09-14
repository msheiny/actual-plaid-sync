import type { PlaidApi } from 'plaid';
import { describe, expect, it } from 'vitest';
import { PlaidRequestError } from '../../../src/plaid/client.js';
import { waitForDepositoryTransactions } from './plaid-sandbox.js';

/** Casts a minimal transactionsGet stub to PlaidApi for these unit tests (no network involved). */
function fakeClient(transactionsGet: () => Promise<unknown>): PlaidApi {
  return { transactionsGet } as unknown as PlaidApi;
}

describe('waitForDepositoryTransactions', () => {
  it('propagates its own "no depository account" error unchanged, not as a classified Plaid error', async () => {
    const client = fakeClient(async () => ({
      data: {
        accounts: [{ account_id: 'a1', type: 'credit' }],
        transactions: [],
        total_transactions: 0,
      },
    }));

    const promise = waitForDepositoryTransactions(
      client,
      'token',
      '2026-01-01',
      '2026-01-31',
      1_000,
    );
    await expect(promise).rejects.toMatchObject({
      message: 'Sandbox Item has no depository account',
    });
    await expect(promise).rejects.not.toBeInstanceOf(PlaidRequestError);
  });

  it('resolves with the first depository account and its transaction ids when present', async () => {
    const client = fakeClient(async () => ({
      data: {
        accounts: [
          { account_id: 'checking', type: 'depository' },
          { account_id: 'card', type: 'credit' },
        ],
        transactions: [
          { account_id: 'checking', transaction_id: 't1' },
          { account_id: 'card', transaction_id: 't2' },
        ],
        total_transactions: 2,
      },
    }));

    await expect(
      waitForDepositoryTransactions(client, 'token', '2026-01-01', '2026-01-31', 1_000),
    ).resolves.toEqual({ plaidAccountId: 'checking', transactionIds: ['t1'] });
  });
});
