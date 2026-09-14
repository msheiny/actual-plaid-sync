import { describe, expect, it } from 'vitest';
import { effectiveDate, toActualAmount, toImportTxn } from '../../src/sync/mapping.js';
import type { PlaidTxn } from '../../src/sync/types.js';

function plaid(overrides: Partial<PlaidTxn> = {}): PlaidTxn {
  return {
    transactionId: 'txn-1',
    accountId: 'plaid-acc-1',
    amount: 12.5,
    date: '2026-09-10',
    authorizedDate: null,
    name: 'SQ *COFFEE SHOP #12',
    merchantName: 'Coffee Shop',
    pending: false,
    pendingTransactionId: null,
    ...overrides,
  };
}

describe('toActualAmount', () => {
  it.each([
    // [case, plaid amount, expected Actual cents]
    ['depository debit (money out)', 42.1, -4210],
    ['depository credit (deposit)', -1500, 150000],
    ['credit card charge', 89.99, -8999],
    ['credit card payment', -250, 25000],
    ['loan payment received', -310.45, 31045],
  ])('%s: %d -> %i', (_case, amount, expected) => {
    expect(toActualAmount(amount)).toBe(expected);
  });

  it.each([
    // Binary floats: 19.99 * -100 = -1998.9999999999998, rounds to -1999.
    [19.99, -1999],
    [-19.99, 1999],
    // 0.07 * -100 = -7.000000000000001, rounds to -7.
    [0.07, -7],
    // 0.1 + 0.2 = 0.30000000000000004 -> -30.000000000000004 -> -30.
    [0.1 + 0.2, -30],
    // Exact half-cent results round toward +Infinity (Math.round semantics):
    // 1234.565 * -100 = -123456.5 -> -123456. Plaid amounts have at most 2 decimals, so this is theoretical.
    [1234.565, -123456],
  ])('rounds float noise: %d -> %i', (amount, expected) => {
    expect(toActualAmount(amount)).toBe(expected);
  });

  it.each([0, -0, 0.004, 0.005])('normalizes negative zero for %d', (amount) => {
    const result = toActualAmount(amount);
    expect(result).toBe(0);
    expect(Object.is(result, -0)).toBe(false);
  });
});

describe('effectiveDate', () => {
  it('prefers authorizedDate', () => {
    expect(effectiveDate(plaid({ authorizedDate: '2026-09-08', date: '2026-09-10' }))).toBe(
      '2026-09-08',
    );
  });

  it('falls back to date when authorizedDate is null', () => {
    expect(effectiveDate(plaid({ authorizedDate: null, date: '2026-09-10' }))).toBe('2026-09-10');
  });
});

describe('toImportTxn', () => {
  it('maps a posted transaction', () => {
    expect(
      toImportTxn(
        plaid({
          transactionId: 'posted-1',
          amount: 12.5,
          authorizedDate: '2026-09-09',
          date: '2026-09-10',
          name: 'SQ *COFFEE SHOP #12',
          merchantName: 'Coffee Shop',
          pending: false,
        }),
      ),
    ).toEqual({
      date: '2026-09-09',
      amount: -1250,
      payee_name: 'Coffee Shop',
      imported_payee: 'SQ *COFFEE SHOP #12',
      imported_id: 'posted-1',
      cleared: true,
    });
  });

  it('falls back to name for payee_name when merchantName is null', () => {
    const t = toImportTxn(plaid({ name: 'ACH DEPOSIT PAYROLL', merchantName: null }));
    expect(t.payee_name).toBe('ACH DEPOSIT PAYROLL');
    expect(t.imported_payee).toBe('ACH DEPOSIT PAYROLL');
  });

  it.each([
    [false, true],
    [true, false],
  ])('pending=%s -> cleared=%s', (pending, cleared) => {
    expect(toImportTxn(plaid({ pending })).cleared).toBe(cleared);
  });
});
