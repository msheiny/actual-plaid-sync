import { type CountryCode, type LinkTokenCreateRequest, type PlaidApi, Products } from 'plaid';
import { ConfigError, type LinkConfig } from '../config.js';
import { fetchAccounts, type PlaidAccountInfo } from '../plaid/accounts.js';
import { withRetry } from '../plaid/client.js';

export interface LinkDeps {
  createLinkToken(): Promise<string>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  fetchAccounts(accessToken: string): Promise<PlaidAccountInfo[]>;
}

const CLIENT_NAME = 'actual-plaid-sync';
const CLIENT_USER_ID = 'actual-plaid-sync';
const DAYS_REQUESTED = 730;

function buildLinkTokenRequest(cfg: LinkConfig, mode: 'create' | 'update'): LinkTokenCreateRequest {
  const base = {
    client_name: CLIENT_NAME,
    language: 'en',
    country_codes: cfg.countryCodes as CountryCode[],
    user: { client_user_id: CLIENT_USER_ID },
  };
  if (mode === 'create') {
    // No redirect_uri: desktop web Link opens OAuth banks in a pop-up without one.
    return {
      ...base,
      products: [Products.Transactions],
      transactions: { days_requested: DAYS_REQUESTED },
    };
  }
  if (!cfg.accessToken) {
    throw new ConfigError(['LINK_ACCESS_TOKEN (or --access-token) is required for link --update']);
  }
  // Update mode: same Item, same access token; no products; let the user add/remove accounts.
  return { ...base, access_token: cfg.accessToken, update: { account_selection_enabled: true } };
}

export function createLinkDeps(
  client: PlaidApi,
  cfg: LinkConfig,
  mode: 'create' | 'update',
): LinkDeps {
  const request = buildLinkTokenRequest(cfg, mode);
  return {
    async createLinkToken() {
      const res = await withRetry(() => client.linkTokenCreate(request));
      return res.data.link_token;
    },
    async exchangePublicToken(publicToken) {
      const res = await withRetry(() =>
        client.itemPublicTokenExchange({ public_token: publicToken }),
      );
      return { accessToken: res.data.access_token, itemId: res.data.item_id };
    },
    fetchAccounts(accessToken) {
      return fetchAccounts(client, accessToken);
    },
  };
}
