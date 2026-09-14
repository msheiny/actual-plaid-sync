import type { PlaidApi } from 'plaid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, type LinkConfig } from '../../src/config.js';
import { createLinkDeps } from '../../src/link/plaid-link.js';

const accountsMock = vi.hoisted(() => ({ fetchAccounts: vi.fn() }));
vi.mock('../../src/plaid/accounts.js', () => accountsMock);

function fakeClient() {
  return {
    linkTokenCreate: vi.fn().mockResolvedValue({
      data: {
        link_token: 'link-sandbox-123',
        expiration: '2026-09-14T00:00:00Z',
        request_id: 'req-1',
      },
    }),
    itemPublicTokenExchange: vi.fn().mockResolvedValue({
      data: { access_token: 'access-sandbox-abc', item_id: 'item-1', request_id: 'req-2' },
    }),
  };
}

const baseCfg: LinkConfig = {
  plaid: { clientId: 'client-id', secret: 'secret', env: 'sandbox' },
  countryCodes: ['US', 'CA'],
  port: 8484,
  host: '127.0.0.1',
  logLevel: 'info',
};

describe('createLinkDeps', () => {
  beforeEach(() => {
    accountsMock.fetchAccounts.mockReset();
  });

  it('creates a transactions link token with 730 days of history and no redirect_uri', async () => {
    const client = fakeClient();
    const deps = createLinkDeps(client as unknown as PlaidApi, baseCfg, 'create');

    await expect(deps.createLinkToken()).resolves.toBe('link-sandbox-123');

    expect(client.linkTokenCreate).toHaveBeenCalledTimes(1);
    expect(client.linkTokenCreate.mock.calls[0]?.[0]).toStrictEqual({
      client_name: 'actual-plaid-sync',
      language: 'en',
      country_codes: ['US', 'CA'],
      user: { client_user_id: 'actual-plaid-sync' },
      products: ['transactions'],
      transactions: { days_requested: 730 },
    });
  });

  it('creates an update-mode link token with the access token, no products, and account selection', async () => {
    const client = fakeClient();
    const deps = createLinkDeps(
      client as unknown as PlaidApi,
      { ...baseCfg, accessToken: 'access-existing' },
      'update',
    );

    await deps.createLinkToken();

    expect(client.linkTokenCreate.mock.calls[0]?.[0]).toStrictEqual({
      client_name: 'actual-plaid-sync',
      language: 'en',
      country_codes: ['US', 'CA'],
      user: { client_user_id: 'actual-plaid-sync' },
      access_token: 'access-existing',
      update: { account_selection_enabled: true },
    });
  });

  it('refuses update mode without an access token', () => {
    const client = fakeClient();
    expect(() => createLinkDeps(client as unknown as PlaidApi, baseCfg, 'update')).toThrow(
      ConfigError,
    );
  });

  it('exchanges a public token for an access token and item id', async () => {
    const client = fakeClient();
    const deps = createLinkDeps(client as unknown as PlaidApi, baseCfg, 'create');

    await expect(deps.exchangePublicToken('public-sandbox-xyz')).resolves.toEqual({
      accessToken: 'access-sandbox-abc',
      itemId: 'item-1',
    });
    expect(client.itemPublicTokenExchange).toHaveBeenCalledWith({
      public_token: 'public-sandbox-xyz',
    });
  });

  it('delegates fetchAccounts to plaid/accounts with the same client', async () => {
    const client = fakeClient();
    const accounts = [
      {
        accountId: 'acc-1',
        name: 'Checking',
        officialName: null,
        mask: '0000',
        type: 'depository',
        subtype: 'checking',
      },
    ];
    accountsMock.fetchAccounts.mockResolvedValue(accounts);
    const deps = createLinkDeps(client as unknown as PlaidApi, baseCfg, 'create');

    await expect(deps.fetchAccounts('access-sandbox-abc')).resolves.toEqual(accounts);
    expect(accountsMock.fetchAccounts).toHaveBeenCalledWith(client, 'access-sandbox-abc');
  });
});
