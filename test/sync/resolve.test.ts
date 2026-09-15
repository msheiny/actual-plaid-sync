import { describe, expect, it } from 'vitest';
import type { ActualAccountInfo } from '../../src/actual/session.js';
import type { AccountEntry } from '../../src/config.js';
import type { PlaidAccountInfo } from '../../src/plaid/accounts.js';
import { describePlaidAccount, entryLabel, resolveAccounts } from '../../src/sync/resolve.js';

function plaid(accountId: string, name: string, mask: string | null): PlaidAccountInfo {
  return { accountId, name, mask, officialName: null, type: 'depository', subtype: 'checking' };
}

function actual(id: string, name: string, closed = false): ActualAccountInfo {
  return { id, name, closed, offbudget: false };
}

const PLAID = [
  plaid('p-chk', 'Plaid Checking', '0000'),
  plaid('p-sav', 'Plaid Saving', '1111'),
  plaid('p-visa', 'Visa', null),
];
const ACTUAL = [actual('a-chk', 'Chase Checking'), actual('a-sav', 'Savings')];
const OPTS = { file: 'accounts.yaml', incomplete: false };

describe('entryLabel', () => {
  it('names the file, 1-based entry number, Plaid selector and Actual name', () => {
    expect(entryLabel('accounts.yaml', 1, { plaid: { mask: '1234' }, actual: 'Chase' })).toBe(
      'accounts.yaml entry 2 (plaid 1234 → Chase)',
    );
    expect(entryLabel('/config/a.yaml', 0, { plaid: { id: 'abc' }, actual: 'Visa' })).toBe(
      '/config/a.yaml entry 1 (plaid id abc → Visa)',
    );
  });
});

describe('describePlaidAccount', () => {
  it('shows the mask, or the id when there is no mask', () => {
    expect(describePlaidAccount(plaid('p1', 'Plaid Checking', '0000'))).toBe(
      'Plaid Checking (…0000)',
    );
    expect(describePlaidAccount(plaid('p1', 'Visa', null))).toBe('Visa (id p1)');
  });
});

describe('resolveAccounts', () => {
  it('resolves a unique mask and a pinned id to open Actual accounts by name', () => {
    const entries: AccountEntry[] = [
      { plaid: { mask: '0000' }, actual: 'chase checking' },
      { plaid: { id: 'p-visa' }, actual: 'Savings' },
    ];
    const result = resolveAccounts(entries, PLAID, ACTUAL, OPTS);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.resolved).toEqual([
      {
        plaidAccountId: 'p-chk',
        actualAccount: ACTUAL[0],
        label: 'accounts.yaml entry 1 (plaid 0000 → chase checking)',
      },
      {
        plaidAccountId: 'p-visa',
        actualAccount: ACTUAL[1],
        label: 'accounts.yaml entry 2 (plaid id p-visa → Savings)',
      },
    ]);
  });

  it('matches Actual names ignoring surrounding whitespace in the budget', () => {
    const result = resolveAccounts(
      [{ plaid: { mask: '0000' }, actual: 'Chase Checking' }],
      PLAID,
      [actual('a-chk', '  CHASE checking ')],
      OPTS,
    );
    expect(result.errors).toEqual([]);
    expect(result.resolved.map((r) => r.actualAccount.id)).toEqual(['a-chk']);
  });

  it('reports a Plaid mask or id that no access token returned', () => {
    const result = resolveAccounts(
      [
        { plaid: { mask: '9999' }, actual: 'Chase Checking' },
        { plaid: { id: 'p-ghost' }, actual: 'Savings' },
      ],
      PLAID,
      ACTUAL,
      OPTS,
    );
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual([
      'accounts.yaml entry 1 (plaid 9999 → Chase Checking): no Plaid account with mask 9999 on any access token',
      'accounts.yaml entry 2 (plaid id p-ghost → Savings): no Plaid account with id p-ghost on any access token',
    ]);
  });

  it('skips a missing Plaid account instead of failing when a bank failed to fetch', () => {
    const result = resolveAccounts(
      [
        { plaid: { mask: '9999' }, actual: 'Chase Checking' },
        { plaid: { mask: '1111' }, actual: 'Savings' },
      ],
      PLAID,
      ACTUAL,
      { ...OPTS, incomplete: true },
    );
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([
      'accounts.yaml entry 1 (plaid 9999 → Chase Checking): skipped, its Plaid account was not fetched this run',
    ]);
    expect(result.resolved.map((r) => r.plaidAccountId)).toEqual(['p-sav']);
  });

  it('still reports an Actual problem for an entry skipped on an incomplete run', () => {
    const result = resolveAccounts([{ plaid: { mask: '9999' }, actual: 'Nope' }], PLAID, ACTUAL, {
      ...OPTS,
      incomplete: true,
    });
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([
      'accounts.yaml entry 1 (plaid 9999 → Nope): no open Actual account named "Nope"',
    ]);
  });

  it('lists the candidates and suggests pinning an id when a mask is ambiguous', () => {
    const accounts = [...PLAID, plaid('p-other', 'Other Checking', '0000')];
    const result = resolveAccounts(
      [{ plaid: { mask: '0000' }, actual: 'Chase Checking' }],
      accounts,
      ACTUAL,
      { ...OPTS, incomplete: true },
    );
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual([
      'accounts.yaml entry 1 (plaid 0000 → Chase Checking): mask 0000 matches 2 Plaid accounts: Plaid Checking (…0000, id p-chk), Other Checking (…0000, id p-other); pin one with plaid: <account id>',
    ]);
  });

  it('does not treat the same account fetched under two tokens as ambiguous', () => {
    const result = resolveAccounts(
      [{ plaid: { mask: '0000' }, actual: 'Chase Checking' }],
      [...PLAID, ...PLAID],
      ACTUAL,
      OPTS,
    );
    expect(result.errors).toEqual([]);
    expect(result.resolved).toHaveLength(1);
  });

  it('reports a missing, closed-only, or ambiguous Actual name', () => {
    const result = resolveAccounts(
      [
        { plaid: { mask: '0000' }, actual: 'Missing' },
        { plaid: { mask: '1111' }, actual: 'Old Card' },
        { plaid: { id: 'p-visa' }, actual: 'Joint' },
      ],
      PLAID,
      [actual('a-old', 'Old Card', true), actual('a-j1', 'Joint'), actual('a-j2', 'JOINT')],
      OPTS,
    );
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual([
      'accounts.yaml entry 1 (plaid 0000 → Missing): no open Actual account named "Missing"',
      'accounts.yaml entry 2 (plaid 1111 → Old Card): no open Actual account named "Old Card" (an account with that name is closed)',
      'accounts.yaml entry 3 (plaid id p-visa → Joint): 2 open Actual accounts are named "Joint"; rename one in Actual so the name is unique',
    ]);
  });

  it('rejects a later entry that resolves to an already-claimed Plaid or Actual account', () => {
    const result = resolveAccounts(
      [
        { plaid: { mask: '0000' }, actual: 'Chase Checking' },
        { plaid: { id: 'p-chk' }, actual: 'Savings' },
        { plaid: { id: 'p-visa' }, actual: 'Savings' },
      ],
      PLAID,
      ACTUAL,
      OPTS,
    );
    expect(result.resolved.map((r) => r.plaidAccountId)).toEqual(['p-chk', 'p-visa']);
    expect(result.errors).toEqual([
      'accounts.yaml entry 2 (plaid id p-chk → Savings): resolves to the same Plaid account as accounts.yaml entry 1 (plaid 0000 → Chase Checking)',
    ]);
  });

  it('keeps the first claim on an Actual account', () => {
    const result = resolveAccounts(
      [
        { plaid: { mask: '0000' }, actual: 'Savings' },
        { plaid: { mask: '1111' }, actual: 'Savings' },
      ],
      PLAID,
      ACTUAL,
      OPTS,
    );
    expect(result.resolved.map((r) => r.plaidAccountId)).toEqual(['p-chk']);
    expect(result.errors).toEqual([
      'accounts.yaml entry 2 (plaid 1111 → Savings): resolves to the same Actual account as accounts.yaml entry 1 (plaid 0000 → Savings)',
    ]);
  });
});
