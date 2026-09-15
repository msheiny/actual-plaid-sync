import type { ActualAccountInfo } from '../actual/session.js';
import type { AccountEntry } from '../config.js';
import type { PlaidAccountInfo } from '../plaid/accounts.js';

export interface ResolvedAccount {
  plaidAccountId: string;
  actualAccount: ActualAccountInfo;
  label: string;
}

export interface AccountResolution {
  resolved: ResolvedAccount[];
  /** One line per entry problem; each one fails the run. */
  errors: string[];
  /** Entries whose Plaid account may belong to a bank that failed to fetch this run. */
  skipped: string[];
}

export interface ResolveOptions {
  /** Accounts file path, used only in messages. */
  file: string;
  /** A bank failed to fetch, so a Plaid account that wasn't found is skipped, not an error. */
  incomplete: boolean;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function entryLabel(file: string, index: number, entry: AccountEntry): string {
  const plaid = 'mask' in entry.plaid ? entry.plaid.mask : `id ${entry.plaid.id}`;
  return `${file} entry ${index + 1} (plaid ${plaid} → ${entry.actual})`;
}

export function describePlaidAccount(account: PlaidAccountInfo): string {
  return account.mask
    ? `${account.name} (…${account.mask})`
    : `${account.name} (id ${account.accountId})`;
}

/**
 * Matches accounts-file entries to live accounts: Actual by open-account name, Plaid by mask
 * across every fetched account or by pinned id. Problems are isolated per entry so the other
 * entries can still sync.
 */
export function resolveAccounts(
  entries: AccountEntry[],
  plaidAccounts: PlaidAccountInfo[],
  actualAccounts: ActualAccountInfo[],
  opts: ResolveOptions,
): AccountResolution {
  // Keyed by id so a bank listed under two access tokens doesn't look like a mask collision.
  const plaid = [...new Map(plaidAccounts.map((a) => [a.accountId, a])).values()];
  const open = actualAccounts.filter((a) => !a.closed);
  const result: AccountResolution = { resolved: [], errors: [], skipped: [] };
  // The static duplicate check can't see a mask and an id naming the same account, so claims
  // are tracked on the resolved accounts; the later entry is the one reported.
  const plaidClaims = new Map<string, string>();
  const actualClaims = new Map<string, string>();

  entries.forEach((entry, index) => {
    const label = entryLabel(opts.file, index, entry);
    const errors: string[] = [];

    const name = normalizeName(entry.actual);
    const actualMatches = open.filter((a) => normalizeName(a.name) === name);
    if (actualMatches.length === 0) {
      const closed = actualAccounts.some((a) => a.closed && normalizeName(a.name) === name);
      errors.push(
        `no open Actual account named "${entry.actual}"${closed ? ' (an account with that name is closed)' : ''}`,
      );
    } else if (actualMatches.length > 1) {
      errors.push(
        `${actualMatches.length} open Actual accounts are named "${entry.actual}"; rename one in Actual so the name is unique`,
      );
    }

    const selector = entry.plaid;
    const what = 'mask' in selector ? `mask ${selector.mask}` : `id ${selector.id}`;
    const plaidMatches = plaid.filter((a) =>
      'mask' in selector ? a.mask === selector.mask : a.accountId === selector.id,
    );
    let skipped = false;
    if (plaidMatches.length === 0) {
      if (opts.incomplete) skipped = true;
      else errors.push(`no Plaid account with ${what} on any access token`);
    } else if (plaidMatches.length > 1) {
      const candidates = plaidMatches
        .map((a) => `${a.name} (…${a.mask}, id ${a.accountId})`)
        .join(', ');
      errors.push(
        `${what} matches ${plaidMatches.length} Plaid accounts: ${candidates}; pin one with plaid: <account id>`,
      );
    }

    const plaidAccount = plaidMatches.length === 1 ? plaidMatches[0] : undefined;
    const actualAccount = actualMatches.length === 1 ? actualMatches[0] : undefined;
    const plaidOwner = plaidAccount && plaidClaims.get(plaidAccount.accountId);
    if (plaidOwner) errors.push(`resolves to the same Plaid account as ${plaidOwner}`);
    const actualOwner = actualAccount && actualClaims.get(actualAccount.id);
    if (actualOwner) errors.push(`resolves to the same Actual account as ${actualOwner}`);

    if (errors.length > 0) {
      for (const error of errors) result.errors.push(`${label}: ${error}`);
    } else if (skipped) {
      result.skipped.push(`${label}: skipped, its Plaid account was not fetched this run`);
    } else if (plaidAccount && actualAccount) {
      // Only entries that will sync claim accounts, so one bad entry doesn't cascade.
      plaidClaims.set(plaidAccount.accountId, label);
      actualClaims.set(actualAccount.id, label);
      result.resolved.push({ plaidAccountId: plaidAccount.accountId, actualAccount, label });
    }
  });

  return result;
}
