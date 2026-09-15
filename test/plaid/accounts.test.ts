import type { PlaidApi } from 'plaid';
import { describe, expect, it, vi } from 'vitest';
import { fetchAccounts } from '../../src/plaid/accounts.js';

describe('fetchAccounts', () => {
  it('calls accountsGet with the access token and maps the accounts', async () => {
    const accountsGet = vi.fn().mockResolvedValueOnce({
      data: {
        accounts: [
          {
            account_id: 'acc-1',
            name: 'Plaid Checking',
            official_name: 'Plaid Gold Standard 0% Interest Checking',
            mask: '0000',
            type: 'depository',
            subtype: 'checking',
          },
          {
            account_id: 'acc-2',
            name: 'Plaid Credit Card',
            official_name: null,
            mask: null,
            type: 'credit',
            subtype: null,
          },
        ],
        item: {},
        request_id: 'req',
      },
    });
    const client = { transactionsGet: vi.fn(), accountsGet } as unknown as PlaidApi;

    const accounts = await fetchAccounts(client, 'access-sandbox-abc');

    expect(accountsGet).toHaveBeenCalledWith({ access_token: 'access-sandbox-abc' });
    expect(accounts).toEqual([
      {
        accountId: 'acc-1',
        name: 'Plaid Checking',
        officialName: 'Plaid Gold Standard 0% Interest Checking',
        mask: '0000',
        type: 'depository',
        subtype: 'checking',
      },
      {
        accountId: 'acc-2',
        name: 'Plaid Credit Card',
        officialName: null,
        mask: null,
        type: 'credit',
        subtype: null,
      },
    ]);
  });
});
