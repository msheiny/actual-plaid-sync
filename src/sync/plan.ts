import { effectiveDate, toActualAmount, toImportTxn } from './mapping.js';
import type {
  AccountPlan,
  ActualTxn,
  ImportTxn,
  Notice,
  PlaidTxn,
  PlannedDelete,
  PlannedUpdate,
  SyncWindow,
  UpdateFields,
} from './types.js';

// Returns a notice when a row must not be mutated or deleted, otherwise null.
function protectedRowNotice(row: ActualTxn, action: string): Notice | null {
  if (row.reconciled) {
    return {
      actualId: row.id,
      reason: 'reconciled',
      detail: `reconciled transaction not ${action}`,
    };
  }
  if (row.isParent) {
    return { actualId: row.id, reason: 'split', detail: `split transaction not ${action}` };
  }
  return null;
}

/**
 * Plans the changes for ONE Actual account. Pure: no I/O.
 * plaidTxns and actualTxns must already be filtered to this account.
 */
export function planAccount(
  actualAccountId: string,
  plaidTxns: PlaidTxn[],
  actualTxns: ActualTxn[],
  window: SyncWindow,
): AccountPlan {
  const updates: PlannedUpdate[] = [];
  const imports: ImportTxn[] = [];
  const deletes: PlannedDelete[] = [];
  const notices: Notice[] = [];

  // Index Actual rows by importedId (first row wins if a budget contains duplicates).
  const byImportedId = new Map<string, ActualTxn>();
  for (const row of actualTxns) {
    if (row.importedId !== null && !byImportedId.has(row.importedId)) {
      byImportedId.set(row.importedId, row);
    }
  }

  const plaidIds = new Set(plaidTxns.map((t) => t.transactionId));

  // Pending ids that a posted txn in this batch replaces. If Plaid briefly returns both,
  // the pending one must be neither imported nor amount/date-updated, or the next run
  // would re-import it after step 3 renamed its row.
  const supersededPendingIds = new Set<string>();
  for (const t of plaidTxns) {
    if (!t.pending && t.pendingTransactionId !== null) {
      supersededPendingIds.add(t.pendingTransactionId);
    }
  }

  // Actual row ids linked to a posted txn by step 3 (updated or protected).
  const consumed = new Set<string>();

  for (const t of plaidTxns) {
    const existing = byImportedId.get(t.transactionId);

    if (existing !== undefined) {
      // Step 4: pending amount/date changed. Posted rows already in Actual are left alone,
      // as are pending rows the user already cleared.
      if (
        !t.pending ||
        existing.cleared ||
        supersededPendingIds.has(t.transactionId) ||
        consumed.has(existing.id)
      ) {
        continue;
      }
      const fields: UpdateFields = {};
      const amount = toActualAmount(t.amount);
      if (amount !== existing.amount) fields.amount = amount;
      const date = effectiveDate(t);
      if (date !== existing.date) fields.date = date;
      if (fields.amount === undefined && fields.date === undefined) continue;

      const notice = protectedRowNotice(
        existing,
        `updated to pending changes from ${t.transactionId}`,
      );
      if (notice !== null) {
        notices.push(notice);
      } else {
        updates.push({ kind: 'changed', actualId: existing.id, fields });
      }
      continue;
    }

    if (t.pending) {
      // Step 5 (pending): new unless a posted txn in this batch replaces it.
      if (!supersededPendingIds.has(t.transactionId)) imports.push(toImportTxn(t));
      continue;
    }

    // Step 3: pending -> posted.
    const pendingRow =
      t.pendingTransactionId === null ? undefined : byImportedId.get(t.pendingTransactionId);
    if (pendingRow === undefined || consumed.has(pendingRow.id)) {
      // Step 5 (posted): new.
      imports.push(toImportTxn(t));
      continue;
    }
    consumed.add(pendingRow.id);
    const notice = protectedRowNotice(
      pendingRow,
      `linked to posted transaction ${t.transactionId}`,
    );
    if (notice !== null) {
      notices.push(notice);
      continue;
    }
    updates.push({
      kind: 'posted',
      actualId: pendingRow.id,
      fields: {
        imported_id: t.transactionId,
        amount: toActualAmount(t.amount),
        date: effectiveDate(t),
        cleared: true,
      },
    });
  }

  // Step 6: cancelled holds.
  for (const row of actualTxns) {
    if (
      row.importedId === null ||
      row.cleared ||
      plaidIds.has(row.importedId) ||
      consumed.has(row.id)
    ) {
      continue;
    }
    if (row.date < window.trustedStart) {
      notices.push({
        actualId: row.id,
        reason: 'stale-pending',
        detail: `uncleared transaction ${row.importedId} dated ${row.date} is before ${window.trustedStart} and no longer returned by Plaid; clear or delete it manually`,
      });
      continue;
    }
    const notice = protectedRowNotice(row, `deleted as cancelled hold ${row.importedId}`);
    if (notice !== null) {
      notices.push(notice);
    } else {
      deletes.push({ actualId: row.id, importedId: row.importedId });
    }
  }

  // Notices follow Actual row order (Array.prototype.sort is stable).
  const rowOrder = new Map(actualTxns.map((row, i) => [row.id, i] as const));
  notices.sort((a, b) => (rowOrder.get(a.actualId) ?? 0) - (rowOrder.get(b.actualId) ?? 0));

  return { actualAccountId, updates, imports, deletes, notices };
}

export function isEmptyPlan(plan: AccountPlan): boolean {
  return plan.updates.length === 0 && plan.imports.length === 0 && plan.deletes.length === 0;
}
