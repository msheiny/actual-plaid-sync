import type { PlaidApi, Products, TransactionsGetResponse } from 'plaid';
import { classifyPlaidError } from '../../../src/plaid/client.js';

/** "First Platypus Bank", the standard non-OAuth Sandbox institution. */
export const SANDBOX_INSTITUTION_ID = 'ins_109508';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates a Sandbox Item (default test user `user_good`) and returns its access token. */
export async function createSandboxAccessToken(client: PlaidApi): Promise<string> {
  const { data: created } = await client.sandboxPublicTokenCreate({
    institution_id: SANDBOX_INSTITUTION_ID,
    initial_products: ['transactions' as Products],
    options: { transactions: { days_requested: 90 } },
  });
  const { data: exchanged } = await client.itemPublicTokenExchange({
    public_token: created.public_token,
  });
  return exchanged.access_token;
}

export interface SandboxAccount {
  plaidAccountId: string;
  transactionIds: string[];
}

/**
 * Polls /transactions/get until the Item's initial pull is done (no PRODUCT_NOT_READY) and the
 * first depository account has transactions in [start, end]. Returns that account and its txn ids.
 *
 * Only errors from the Plaid API call itself go through `classifyPlaidError`. A missing depository
 * account is this helper's own error and propagates unchanged, so callers never see it relabeled as
 * a retryable "Plaid network error".
 */
export async function waitForDepositoryTransactions(
  client: PlaidApi,
  accessToken: string,
  start: string,
  end: string,
  timeoutMs = 180_000,
): Promise<SandboxAccount> {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'no response yet';
  while (Date.now() < deadline) {
    let data: TransactionsGetResponse;
    try {
      ({ data } = await client.transactionsGet({
        access_token: accessToken,
        start_date: start,
        end_date: end,
        options: { count: 500, offset: 0 },
      }));
    } catch (err) {
      const classified = classifyPlaidError(err);
      if (classified.kind !== 'not-ready') throw classified;
      lastState = 'PRODUCT_NOT_READY';
      await sleep(5_000);
      continue;
    }

    const depository = data.accounts.find((a) => a.type === 'depository');
    if (!depository) throw new Error('Sandbox Item has no depository account');
    const transactionIds = data.transactions
      .filter((t) => t.account_id === depository.account_id)
      .map((t) => t.transaction_id);
    if (transactionIds.length > 0) return { plaidAccountId: depository.account_id, transactionIds };
    lastState = `0 transactions for ${depository.account_id} (total_transactions=${data.total_transactions})`;
    await sleep(5_000);
  }
  throw new Error(`Plaid Sandbox transactions not ready after ${timeoutMs}ms: ${lastState}`);
}
