import type { PlaidAccountInfo } from '../plaid/accounts.js';

export interface PlaidTxn {
  transactionId: string;
  accountId: string;
  amount: number; // Plaid convention: positive = money out
  date: string; // YYYY-MM-DD
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  pending: boolean;
  pendingTransactionId: string | null;
}

export interface ActualTxn {
  id: string;
  account: string;
  date: string; // YYYY-MM-DD
  amount: number; // integer cents, negative = outflow
  importedId: string | null;
  cleared: boolean;
  reconciled: boolean;
  isParent: boolean;
}

export interface PlaidFetchResult {
  accounts: PlaidAccountInfo[]; // every account on the Item (from the /transactions/get `accounts` field), even with zero txns
  transactions: PlaidTxn[];
}

// Passed directly to actual.importTransactions
export interface ImportTxn {
  date: string;
  amount: number;
  payee_name: string;
  imported_payee: string;
  imported_id: string;
  cleared: boolean;
}

export interface UpdateFields {
  imported_id?: string;
  amount?: number;
  date?: string;
  cleared?: boolean;
}

export interface PlannedUpdate {
  kind: 'posted' | 'changed';
  actualId: string;
  fields: UpdateFields;
}

export interface PlannedDelete {
  actualId: string;
  importedId: string;
}

export interface Notice {
  actualId: string;
  reason: 'reconciled' | 'split' | 'stale-pending';
  detail: string;
}

export interface AccountPlan {
  actualAccountId: string;
  updates: PlannedUpdate[];
  imports: ImportTxn[];
  deletes: PlannedDelete[];
  notices: Notice[];
}

export interface SyncWindow {
  start: string; // today - syncDays  (Plaid fetch start)
  end: string; // today
  trustedStart: string; // start + 3 days    (cancelled-hold deletes allowed on/after this)
  lookbackStart: string; // start - 30 days   (Actual load start)
}
