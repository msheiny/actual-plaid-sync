import type { ImportTxn, PlaidTxn } from './types.js';

export function toActualAmount(plaidAmount: number): number {
  const cents = Math.round(plaidAmount * -100);
  // Math.round(0 * -100) is -0; normalize so equality checks and JSON output stay clean.
  return cents === 0 ? 0 : cents;
}

export function effectiveDate(t: PlaidTxn): string {
  return t.authorizedDate ?? t.date;
}

export function toImportTxn(t: PlaidTxn): ImportTxn {
  return {
    date: effectiveDate(t),
    amount: toActualAmount(t.amount),
    payee_name: t.merchantName ?? t.name,
    imported_payee: t.name,
    imported_id: t.transactionId,
    cleared: !t.pending,
  };
}
