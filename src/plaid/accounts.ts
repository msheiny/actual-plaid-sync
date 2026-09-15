import type { AccountBase, PlaidApi } from 'plaid';
import { withRetry } from './client.js';

export interface PlaidAccountInfo {
  accountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
}

export function toPlaidAccountInfo(a: AccountBase): PlaidAccountInfo {
  return {
    accountId: a.account_id,
    name: a.name,
    officialName: a.official_name ?? null,
    mask: a.mask ?? null,
    type: a.type,
    subtype: a.subtype ?? null,
  };
}

export async function fetchAccounts(
  client: PlaidApi,
  accessToken: string,
): Promise<PlaidAccountInfo[]> {
  const response = await withRetry(() => client.accountsGet({ access_token: accessToken }));
  return response.data.accounts.map(toPlaidAccountInfo);
}
