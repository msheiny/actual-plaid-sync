import type { ActualGateway, ImportResult } from '../actual/session.js';
import { ActualError } from '../actual/session.js';
import type { SyncConfig } from '../config.js';
import type { Logger } from '../log.js';
import { maskToken } from '../log.js';
import type { PlaidAccountInfo } from '../plaid/accounts.js';
import { PlaidRequestError } from '../plaid/client.js';
import { planAccount } from './plan.js';
import { describePlaidAccount, resolveAccounts } from './resolve.js';
import type { AccountPlan, PlaidFetchResult, PlaidTxn } from './types.js';
import { computeWindow } from './window.js';

export interface SyncDeps {
  fetchTransactions(accessToken: string, start: string, end: string): Promise<PlaidFetchResult>;
  gateway: ActualGateway;
  log: Logger;
  today: string;
}

export async function executePlan(gw: ActualGateway, plan: AccountPlan): Promise<ImportResult> {
  for (const update of plan.updates) {
    await gw.updateTransaction(update.actualId, update.fields);
  }
  let result: ImportResult = { added: [], updated: [], errors: [] };
  if (plan.imports.length > 0) {
    result = await gw.importTransactions(plan.actualAccountId, plan.imports);
  }
  for (const del of plan.deletes) {
    await gw.deleteTransaction(del.actualId);
  }
  return result;
}

export function formatSummary(accountName: string, plan: AccountPlan): string {
  const posted = plan.updates.filter((u) => u.kind === 'posted').length;
  const changed = plan.updates.filter((u) => u.kind === 'changed').length;
  return `${accountName}: ${plan.imports.length} added, ${posted} posted, ${changed} amount updated, ${plan.deletes.length} cancelled hold, ${plan.notices.length} skipped`;
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

// Never includes a raw error object or unmasked secret: only the message (and, for an
// ActualError, its hint) are ever attacker/PII-free text produced by our own error classes.
function accountFailureDetail(err: unknown): string {
  if (err instanceof ActualError) return `${err.message} (${err.hint})`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function logDryRun(log: Logger, name: string, plan: AccountPlan): void {
  for (const u of plan.updates) {
    log.info(`[dry run] ${name}: update (${u.kind}) ${u.actualId} ${JSON.stringify(u.fields)}`);
  }
  for (const t of plan.imports) {
    log.info(
      `[dry run] ${name}: import ${t.date} ${formatCents(t.amount)} ${t.payee_name} (${t.imported_id})`,
    );
  }
  for (const d of plan.deletes) {
    log.info(`[dry run] ${name}: delete cancelled hold ${d.actualId} (${d.importedId})`);
  }
  log.info(`[dry run] ${formatSummary(name, plan)}`);
}

export async function runSync(cfg: SyncConfig, deps: SyncDeps): Promise<0 | 1> {
  const { gateway, log } = deps;
  const window = computeWindow(deps.today, cfg.syncDays);
  let failed = false;
  let incomplete = false;
  const txnsByAccount = new Map<string, PlaidTxn[]>();
  const plaidAccounts: PlaidAccountInfo[] = [];

  log.info(`Syncing Plaid transactions from ${window.start} to ${window.end}`);

  for (const token of cfg.accessTokens) {
    const masked = maskToken(token);
    try {
      const result = await deps.fetchTransactions(token, window.start, window.end);
      plaidAccounts.push(...result.accounts);
      for (const txn of result.transactions) {
        const list = txnsByAccount.get(txn.accountId) ?? [];
        list.push(txn);
        txnsByAccount.set(txn.accountId, list);
      }
      log.debug(`Fetched ${result.transactions.length} Plaid transactions for bank ${masked}`);
    } catch (err) {
      incomplete = true;
      if (err instanceof PlaidRequestError && err.kind === 'relink') {
        log.error(
          `Bank ${masked} needs re-authentication: run \`link --update\` with LINK_ACCESS_TOKEN set to this token`,
        );
        failed = true;
      } else if (err instanceof PlaidRequestError && err.kind === 'not-ready') {
        log.warn(
          `Bank ${masked} transactions are not ready yet (PRODUCT_NOT_READY); skipping this run`,
        );
      } else if (err instanceof PlaidRequestError) {
        const requestId = err.requestId ? ` (request ${err.requestId})` : '';
        log.error(`Bank ${masked} failed with ${err.code ?? err.kind}: ${err.message}${requestId}`);
        failed = true;
      } else {
        log.error(`Bank ${masked} failed: ${err instanceof Error ? err.message : String(err)}`);
        failed = true;
      }
    }
  }

  // An entry whose Plaid account wasn't fetched is only skipped (never planned against an empty
  // txn list) when a bank failed this run, so its uncleared rows can't be deleted as cancelled holds.
  const resolution = resolveAccounts(cfg.accounts, plaidAccounts, await gateway.getAccounts(), {
    file: cfg.accountsFile,
    incomplete,
  });
  for (const message of resolution.errors) {
    log.error(message);
    failed = true;
  }
  for (const message of resolution.skipped) log.debug(message);

  const mappedPlaidIds = new Set(resolution.resolved.map((r) => r.plaidAccountId));
  const logged = new Set<string>();
  for (const account of plaidAccounts) {
    if (mappedPlaidIds.has(account.accountId) || logged.has(account.accountId)) continue;
    logged.add(account.accountId);
    log.info(`Skipping unmapped Plaid account ${describePlaidAccount(account)}`);
  }

  for (const { plaidAccountId, actualAccount: account } of resolution.resolved) {
    // planAccount does no account filtering itself, so only this entry's Plaid txns and
    // only this entry's Actual rows (loaded with the extended lookback window) are passed in.
    // A gateway failure anywhere in this block (read, plan, or write) must not abort later
    // entries, so it is caught and turned into a failed-account log line instead of a thrown
    // error escaping runSync.
    try {
      const rows = await gateway.getTransactions(account.id, window.lookbackStart, window.end);
      const plan = planAccount(account.id, txnsByAccount.get(plaidAccountId) ?? [], rows, window);
      for (const notice of plan.notices) {
        log.warn(
          `${account.name}: skipped ${notice.actualId} (${notice.reason}): ${notice.detail}`,
        );
      }

      if (cfg.dryRun) {
        logDryRun(log, account.name, plan);
        continue;
      }

      const result = await executePlan(gateway, plan);
      // F-I4: importTransactions fuzzy-matches a new row against an existing uncleared row
      // (same amount, date within ~7 days) instead of adding it, and reports the matched row's
      // id here. That match is silent otherwise, and if the matched hold later disappears from
      // Plaid, the existing (possibly hand-entered) transaction could be deleted as a cancelled
      // hold -- so it's surfaced as a warning rather than left invisible.
      for (const id of result.updated) {
        log.warn(
          `${account.name}: import matched an existing transaction ${id} instead of adding a new one; if a pending hold later disappears from Plaid, that transaction may be deleted`,
        );
      }
      for (const message of result.errors) {
        log.error(`${account.name}: import error: ${message}`);
        failed = true;
      }
      log.info(formatSummary(account.name, plan));
    } catch (err) {
      failed = true;
      log.error(`${account.name}: failed: ${accountFailureDetail(err)}`);
    }
  }

  return failed ? 1 : 0;
}
