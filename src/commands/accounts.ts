import type { ActualAccountInfo, ActualGateway } from '../actual/session.js';
import type { AccountMapping, AccountsConfig } from '../config.js';
import type { Logger } from '../log.js';
import { maskToken } from '../log.js';
import type { PlaidAccountInfo } from '../plaid/accounts.js';
import { PlaidRequestError } from '../plaid/client.js';

export interface AccountsDeps {
  fetchAccounts(accessToken: string): Promise<PlaidAccountInfo[]>;
  gateway: ActualGateway;
  log: Logger;
  print(line: string): void;
}

export function suggestAccountMap(
  plaidAccounts: PlaidAccountInfo[],
  actualAccounts: ActualAccountInfo[],
): AccountMapping[] {
  const open = actualAccounts.filter((a) => !a.closed);
  const used = new Set<string>();
  const suggestions: AccountMapping[] = [];
  for (const p of plaidAccounts) {
    const available = open.filter((a) => !used.has(a.id));
    let match: ActualAccountInfo | undefined;
    if (p.mask) {
      const mask = p.mask.toLowerCase();
      match = available.find((a) => a.name.toLowerCase().includes(mask));
    }
    if (!match) {
      const names = [p.name, p.officialName]
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
        .map((n) => n.toLowerCase());
      match = available.find((a) => names.includes(a.name.toLowerCase()));
    }
    if (match) {
      used.add(match.id);
      suggestions.push({ plaidAccountId: p.accountId, actualAccountId: match.id });
    }
  }
  return suggestions;
}

export function formatTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

export function plaidAccountRow(account: PlaidAccountInfo): string[] {
  return [
    account.accountId,
    account.name,
    account.mask ?? '-',
    account.subtype ? `${account.type}/${account.subtype}` : account.type,
  ];
}

function describeError(err: unknown): string {
  if (err instanceof PlaidRequestError) {
    const relink =
      err.kind === 'relink'
        ? ' (run `link --update` with LINK_ACCESS_TOKEN set to this token)'
        : '';
    return `${err.message}${relink}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function runAccounts(cfg: AccountsConfig, deps: AccountsDeps): Promise<0 | 1> {
  const { log, print } = deps;
  let failed = false;
  const plaidAccounts: PlaidAccountInfo[] = [];

  for (const token of cfg.accessTokens) {
    const masked = maskToken(token);
    let accounts: PlaidAccountInfo[];
    try {
      accounts = await deps.fetchAccounts(token);
    } catch (err) {
      log.error(`Fetching Plaid accounts for bank ${masked} failed: ${describeError(err)}`);
      failed = true;
      continue;
    }
    plaidAccounts.push(...accounts);
    print(`Plaid accounts for access token ${masked}:`);
    const rows = accounts.map(plaidAccountRow);
    for (const l of formatTable(['PLAID ACCOUNT ID', 'NAME', 'MASK', 'TYPE'], rows)) print(l);
    print('');
  }

  const actualAccounts = await deps.gateway.getAccounts();
  print('Actual accounts:');
  const actualRows = actualAccounts.map((a) => {
    const flags = [a.closed ? 'closed' : '', a.offbudget ? 'off-budget' : '']
      .filter(Boolean)
      .join(', ');
    return [a.id, a.name, flags];
  });
  for (const l of formatTable(['ACTUAL ACCOUNT ID', 'NAME', 'FLAGS'], actualRows)) print(l);
  print('');

  const suggestion = suggestAccountMap(plaidAccounts, actualAccounts);
  if (suggestion.length === 0) {
    print(
      'No confident ACCOUNT_MAP matches found; build it by hand as plaidAccountId:actualAccountId pairs.',
    );
  } else {
    print('Suggested ACCOUNT_MAP (review before use; unmatched accounts are omitted):');
    print(
      `ACCOUNT_MAP=${suggestion.map((m) => `${m.plaidAccountId}:${m.actualAccountId}`).join(',')}`,
    );
  }

  return failed ? 1 : 0;
}
