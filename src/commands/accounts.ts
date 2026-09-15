import { Document, isMap, isScalar, isSeq } from 'yaml';
import type { ActualAccountInfo, ActualGateway } from '../actual/session.js';
import type { AccountsConfig } from '../config.js';
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

export interface AccountSuggestion {
  plaid: PlaidAccountInfo;
  actual: ActualAccountInfo | null;
}

export function suggestAccounts(
  plaidAccounts: PlaidAccountInfo[],
  actualAccounts: ActualAccountInfo[],
): AccountSuggestion[] {
  const open = actualAccounts.filter((a) => !a.closed);
  const used = new Set<string>();
  return plaidAccounts.map((p) => {
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
    if (match) used.add(match.id);
    return { plaid: p, actual: match ?? null };
  });
}

/** Renders a value on one line in YAML flow style, e.g. "1234" or { id: abc }. */
function flowYaml(value: unknown): string {
  const doc = new Document(value);
  if (isMap(doc.contents)) doc.contents.flow = true;
  return doc.toString().trimEnd();
}

/**
 * Builds a paste-ready accounts.yaml. Uses the mask when it is unique across every fetched Plaid
 * account, otherwise pins the account id. If nothing matches, emits a full example with
 * Plaid account IDs and placeholder Actual names; otherwise unmatched Plaid accounts are commented out.
 */
export function formatAccountsYaml(
  suggestions: AccountSuggestion[],
  plaidAccounts: PlaidAccountInfo[],
): string[] {
  const maskCounts = new Map<string, number>();
  for (const p of plaidAccounts) {
    if (p.mask) maskCounts.set(p.mask, (maskCounts.get(p.mask) ?? 0) + 1);
  }
  const selector = (p: PlaidAccountInfo) =>
    p.mask && maskCounts.get(p.mask) === 1 ? p.mask : p.accountId;

  const matched = suggestions.filter((s) => s.actual !== null);
  const example = matched.length === 0;
  const entries = example ? suggestions : matched;
  const lines: string[] = [];
  if (entries.length === 0) {
    lines.push('accounts:');
  } else {
    const doc = new Document({
      accounts: entries.map((s, i) => ({
        plaid: example ? s.plaid.accountId : selector(s.plaid),
        actual: s.actual?.name ?? `REPLACE_WITH_ACTUAL_ACCOUNT_NAME_${i + 1}`,
      })),
    });
    const items = doc.getIn(['accounts'], true);
    if (isSeq(items)) {
      items.items.forEach((item, i) => {
        if (!isMap(item)) return;
        const plaid = item.get('plaid', true);
        if (isMap(plaid)) plaid.flow = true;
        const actual = item.get('actual', true);
        const name = entries[i]?.plaid.name;
        if (isScalar(actual) && name) actual.comment = ` Plaid: ${name}`;
      });
    }
    lines.push(...doc.toString().trimEnd().split('\n'));
  }
  for (const s of suggestions) {
    if (example || s.actual !== null) continue;
    lines.push(
      `  # - plaid: ${flowYaml(selector(s.plaid))}  # ${s.plaid.name} — no matching Actual account`,
    );
  }
  return lines;
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

  if (plaidAccounts.length > 0) {
    const suggestions = suggestAccounts(plaidAccounts, actualAccounts);
    print('Suggested accounts.yaml (review before use):');
    for (const l of formatAccountsYaml(suggestions, plaidAccounts)) print(l);
    if (suggestions.every((s) => s.actual === null)) {
      print('');
      print(
        'No confident matches found; replace each placeholder with an Actual account name, or remove accounts you do not want to sync.',
      );
    }
  }

  return failed ? 1 : 0;
}
