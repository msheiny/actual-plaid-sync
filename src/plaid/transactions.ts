import type { PlaidApi, Transaction } from 'plaid';
import type { PlaidFetchResult, PlaidTxn } from '../sync/types.js';
import { type PlaidAccountInfo, toPlaidAccountInfo } from './accounts.js';
import { withRetry } from './client.js';

const PAGE_SIZE = 500;

export function toPlaidTxn(t: Transaction): PlaidTxn {
  return {
    transactionId: t.transaction_id,
    accountId: t.account_id,
    amount: t.amount,
    date: t.date,
    authorizedDate: t.authorized_date ?? null,
    name: t.name,
    merchantName: t.merchant_name ?? null,
    pending: t.pending,
    pendingTransactionId: t.pending_transaction_id ?? null,
  };
}

export async function fetchTransactions(
  client: PlaidApi,
  accessToken: string,
  start: string,
  end: string,
): Promise<PlaidFetchResult> {
  const transactions: PlaidTxn[] = [];
  let accounts: PlaidAccountInfo[] = [];
  let offset = 0;
  for (;;) {
    const response = await withRetry(() =>
      client.transactionsGet({
        access_token: accessToken,
        start_date: start,
        end_date: end,
        options: { count: PAGE_SIZE, offset },
      }),
    );
    const data = response.data;
    if (offset === 0) accounts = data.accounts.map(toPlaidAccountInfo);
    transactions.push(...data.transactions.map(toPlaidTxn));
    offset += data.transactions.length;
    if (data.transactions.length === 0 || offset >= data.total_transactions) break;
  }
  return { accounts, transactions };
}
