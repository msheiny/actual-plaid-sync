import { describe, expect, it } from 'vitest';
import { isEmptyPlan, planAccount } from '../../src/sync/plan.js';
import type { AccountPlan, ActualTxn, PlaidTxn } from '../../src/sync/types.js';
import { computeWindow } from '../../src/sync/window.js';

const ACCOUNT = 'actual-acc-1';
// start 2026-08-14, trustedStart 2026-08-17, lookbackStart 2026-07-15, end 2026-09-13
const WINDOW = computeWindow('2026-09-13', 30);

function plaid(overrides: Partial<PlaidTxn> & { transactionId: string }): PlaidTxn {
  return {
    accountId: 'plaid-acc-1',
    amount: 10,
    date: '2026-09-10',
    authorizedDate: null,
    name: 'SQ *COFFEE SHOP #12',
    merchantName: 'Coffee Shop',
    pending: false,
    pendingTransactionId: null,
    ...overrides,
  };
}

function actualRow(overrides: Partial<ActualTxn> & { id: string }): ActualTxn {
  return {
    account: ACCOUNT,
    date: '2026-09-10',
    amount: -1000,
    importedId: null,
    cleared: true,
    reconciled: false,
    isParent: false,
    ...overrides,
  };
}

function plan(plaidTxns: PlaidTxn[], rows: ActualTxn[]): AccountPlan {
  return planAccount(ACCOUNT, plaidTxns, rows, WINDOW);
}

function emptyPlan(): AccountPlan {
  return { actualAccountId: ACCOUNT, updates: [], imports: [], deletes: [], notices: [] };
}

// Simulates Actual applying a plan: updates merge fields, imports append rows, deletes remove rows.
function applyPlan(rows: ActualTxn[], p: AccountPlan, accountId: string): ActualTxn[] {
  const deleted = new Set(p.deletes.map((d) => d.actualId));
  const result = rows
    .filter((row) => !deleted.has(row.id))
    .map((row) => {
      let next = { ...row };
      for (const { actualId, fields } of p.updates) {
        if (actualId !== row.id) continue;
        next = {
          ...next,
          ...(fields.imported_id !== undefined ? { importedId: fields.imported_id } : {}),
          ...(fields.amount !== undefined ? { amount: fields.amount } : {}),
          ...(fields.date !== undefined ? { date: fields.date } : {}),
          ...(fields.cleared !== undefined ? { cleared: fields.cleared } : {}),
        };
      }
      return next;
    });
  for (const t of p.imports) {
    result.push({
      id: `new-${t.imported_id}`,
      account: accountId,
      date: t.date,
      amount: t.amount,
      importedId: t.imported_id,
      cleared: t.cleared,
      reconciled: false,
      isParent: false,
    });
  }
  return result;
}

describe('planAccount: new transactions', () => {
  it('imports a new posted transaction', () => {
    const result = plan(
      [
        plaid({
          transactionId: 'p1',
          amount: 12.5,
          authorizedDate: '2026-09-09',
          date: '2026-09-10',
        }),
      ],
      [],
    );
    expect(result).toEqual({
      ...emptyPlan(),
      imports: [
        {
          date: '2026-09-09',
          amount: -1250,
          payee_name: 'Coffee Shop',
          imported_payee: 'SQ *COFFEE SHOP #12',
          imported_id: 'p1',
          cleared: true,
        },
      ],
    });
  });

  it('imports a new pending transaction as uncleared', () => {
    const result = plan([plaid({ transactionId: 'q1', amount: 8, pending: true })], []);
    expect(result).toEqual({
      ...emptyPlan(),
      imports: [
        {
          date: '2026-09-10',
          amount: -800,
          payee_name: 'Coffee Shop',
          imported_payee: 'SQ *COFFEE SHOP #12',
          imported_id: 'q1',
          cleared: false,
        },
      ],
    });
  });

  it('does nothing for a posted transaction that is already imported', () => {
    const result = plan(
      [plaid({ transactionId: 'p1', amount: 10 })],
      [actualRow({ id: 'a1', importedId: 'p1', amount: -1000, cleared: true })],
    );
    expect(result).toEqual(emptyPlan());
  });

  it('never re-compares posted transactions that are already imported', () => {
    const result = plan(
      [plaid({ transactionId: 'p1', amount: 99, date: '2026-09-12' })],
      [
        actualRow({
          id: 'a1',
          importedId: 'p1',
          amount: -1000,
          date: '2026-09-10',
          cleared: false,
        }),
      ],
    );
    expect(result).toEqual(emptyPlan());
  });
});

describe('planAccount: pending -> posted', () => {
  it('updates the pending row in place and does not import the posted transaction', () => {
    const result = plan(
      [
        plaid({
          transactionId: 'p1',
          pendingTransactionId: 'q1',
          amount: 12.5,
          authorizedDate: '2026-09-09',
          date: '2026-09-11',
        }),
      ],
      [
        actualRow({
          id: 'a1',
          importedId: 'q1',
          amount: -1000,
          date: '2026-09-10',
          cleared: false,
        }),
      ],
    );
    expect(result).toEqual({
      ...emptyPlan(),
      updates: [
        {
          kind: 'posted',
          actualId: 'a1',
          fields: { imported_id: 'p1', amount: -1250, date: '2026-09-09', cleared: true },
        },
      ],
    });
  });

  it.each([
    ['reconciled', { reconciled: true }],
    ['split', { isParent: true }],
  ] as const)('emits a %s notice instead of updating, importing, or deleting', (reason, flags) => {
    const result = plan(
      [plaid({ transactionId: 'p1', pendingTransactionId: 'q1', amount: 12.5 })],
      [actualRow({ id: 'a1', importedId: 'q1', cleared: false, ...flags })],
    );
    expect(result).toEqual({
      ...emptyPlan(),
      notices: [{ actualId: 'a1', reason, detail: expect.any(String) }],
    });
  });

  it('when Plaid returns both the pending and its posted replacement, updates once and imports nothing', () => {
    const txns = [
      plaid({ transactionId: 'q1', pending: true, amount: 11 }),
      plaid({ transactionId: 'p1', pendingTransactionId: 'q1', amount: 12.5 }),
    ];
    const rows = [actualRow({ id: 'a1', importedId: 'q1', amount: -1000, cleared: false })];
    const first = plan(txns, rows);
    expect(first).toEqual({
      ...emptyPlan(),
      updates: [
        {
          kind: 'posted',
          actualId: 'a1',
          fields: { imported_id: 'p1', amount: -1250, date: '2026-09-10', cleared: true },
        },
      ],
    });
    expect(isEmptyPlan(plan(txns, applyPlan(rows, first, ACCOUNT)))).toBe(true);
  });

  it('when Plaid returns both the pending and its posted replacement and neither is in Actual, imports only the posted one', () => {
    const result = plan(
      [
        plaid({ transactionId: 'q1', pending: true }),
        plaid({ transactionId: 'p1', pendingTransactionId: 'q1' }),
      ],
      [],
    );
    expect(result.imports.map((t) => t.imported_id)).toEqual(['p1']);
    expect(result.updates).toEqual([]);
  });
});

describe('planAccount: pending changes', () => {
  it.each([
    ['amount only', { amount: 12.34 }, { amount: -1234 }],
    ['date only', { authorizedDate: '2026-09-09' }, { date: '2026-09-09' }],
    [
      'amount and date',
      { amount: 12.34, date: '2026-09-11' },
      { amount: -1234, date: '2026-09-11' },
    ],
  ] as const)('updates only the differing fields (%s)', (_case, changes, fields) => {
    const result = plan(
      [plaid({ transactionId: 'q1', pending: true, amount: 10, date: '2026-09-10', ...changes })],
      [
        actualRow({
          id: 'a1',
          importedId: 'q1',
          amount: -1000,
          date: '2026-09-10',
          cleared: false,
        }),
      ],
    );
    expect(result).toEqual({
      ...emptyPlan(),
      updates: [{ kind: 'changed', actualId: 'a1', fields }],
    });
  });

  it('does nothing when the pending transaction is unchanged', () => {
    const result = plan(
      [plaid({ transactionId: 'q1', pending: true, amount: 10, date: '2026-09-10' })],
      [
        actualRow({
          id: 'a1',
          importedId: 'q1',
          amount: -1000,
          date: '2026-09-10',
          cleared: false,
        }),
      ],
    );
    expect(result).toEqual(emptyPlan());
  });

  it('does nothing when the user already cleared the pending row', () => {
    const result = plan(
      [plaid({ transactionId: 'q1', pending: true, amount: 12.34 })],
      [actualRow({ id: 'a1', importedId: 'q1', amount: -1000, cleared: true })],
    );
    expect(result).toEqual(emptyPlan());
  });

  it.each([
    ['reconciled', { reconciled: true }],
    ['split', { isParent: true }],
  ] as const)('emits a %s notice instead of updating a changed pending row', (reason, flags) => {
    const result = plan(
      [plaid({ transactionId: 'q1', pending: true, amount: 12.34 })],
      [actualRow({ id: 'a1', importedId: 'q1', amount: -1000, cleared: false, ...flags })],
    );
    expect(result).toEqual({
      ...emptyPlan(),
      notices: [{ actualId: 'a1', reason, detail: expect.any(String) }],
    });
  });
});

describe('planAccount: cancelled holds', () => {
  it.each(['2026-08-17', '2026-09-13'])(
    'deletes an uncleared row missing from Plaid dated %s (inside trusted range)',
    (date) => {
      const result = plan(
        [],
        [actualRow({ id: 'a1', importedId: 'q-gone', date, cleared: false })],
      );
      expect(result).toEqual({
        ...emptyPlan(),
        deletes: [{ actualId: 'a1', importedId: 'q-gone' }],
      });
    },
  );

  it('emits a stale-pending notice for a row dated before trustedStart', () => {
    const result = plan(
      [],
      [actualRow({ id: 'a1', importedId: 'q-gone', date: '2026-08-16', cleared: false })],
    );
    expect(result).toEqual({
      ...emptyPlan(),
      notices: [{ actualId: 'a1', reason: 'stale-pending', detail: expect.any(String) }],
    });
  });

  it.each([
    ['reconciled', { reconciled: true }],
    ['split', { isParent: true }],
  ] as const)('emits a %s notice instead of deleting', (reason, flags) => {
    const result = plan(
      [],
      [actualRow({ id: 'a1', importedId: 'q-gone', cleared: false, ...flags })],
    );
    expect(result).toEqual({
      ...emptyPlan(),
      notices: [{ actualId: 'a1', reason, detail: expect.any(String) }],
    });
  });

  it('bank without pendingTransactionId: imports the posted txn and deletes the vanished pending row', () => {
    const result = plan(
      [plaid({ transactionId: 'p1', pendingTransactionId: null, amount: 10 })],
      [actualRow({ id: 'a1', importedId: 'q1', date: '2026-09-09', cleared: false })],
    );
    expect(result.updates).toEqual([]);
    expect(result.imports.map((t) => t.imported_id)).toEqual(['p1']);
    expect(result.deletes).toEqual([{ actualId: 'a1', importedId: 'q1' }]);
    expect(result.notices).toEqual([]);
  });

  it('never deletes cleared rows whose importedId Plaid no longer returns', () => {
    const result = plan(
      [],
      [actualRow({ id: 'a1', importedId: 'old-posted', date: '2026-09-01', cleared: true })],
    );
    expect(result).toEqual(emptyPlan());
  });

  it('ignores rows with a null importedId entirely', () => {
    const result = plan(
      [plaid({ transactionId: 'p1' })],
      [
        actualRow({ id: 'manual-1', importedId: null, date: '2026-09-10', cleared: false }),
        actualRow({
          id: 'manual-2',
          importedId: null,
          date: '2026-08-01',
          cleared: false,
          reconciled: true,
        }),
      ],
    );
    expect(result.updates).toEqual([]);
    expect(result.imports.map((t) => t.imported_id)).toEqual(['p1']);
    expect(result.deletes).toEqual([]);
    expect(result.notices).toEqual([]);
  });
});

describe('planAccount: ordering', () => {
  it('orders updates/imports by Plaid input order and deletes/notices by Actual row order', () => {
    const result = plan(
      [
        plaid({ transactionId: 'p-b', pendingTransactionId: 'q-b' }),
        plaid({ transactionId: 'new-2' }),
        plaid({ transactionId: 'q-a', pending: true, amount: 50 }),
        plaid({ transactionId: 'new-1' }),
        plaid({ transactionId: 'p-rec', pendingTransactionId: 'q-rec' }),
      ],
      [
        actualRow({ id: 'r-stale', importedId: 'q-stale', date: '2026-08-01', cleared: false }),
        actualRow({ id: 'r-del-2', importedId: 'q-del-2', cleared: false }),
        actualRow({ id: 'r-a', importedId: 'q-a', cleared: false }),
        actualRow({ id: 'r-rec', importedId: 'q-rec', cleared: false, reconciled: true }),
        actualRow({ id: 'r-b', importedId: 'q-b', cleared: false }),
        actualRow({ id: 'r-del-1', importedId: 'q-del-1', cleared: false }),
      ],
    );
    expect(result.updates.map((u) => [u.kind, u.actualId])).toEqual([
      ['posted', 'r-b'],
      ['changed', 'r-a'],
    ]);
    expect(result.imports.map((t) => t.imported_id)).toEqual(['new-2', 'new-1']);
    expect(result.deletes.map((d) => d.actualId)).toEqual(['r-del-2', 'r-del-1']);
    expect(result.notices.map((n) => [n.actualId, n.reason])).toEqual([
      ['r-stale', 'stale-pending'],
      ['r-rec', 'reconciled'],
    ]);
  });
});

describe('isEmptyPlan', () => {
  it('is true for a plan with only notices', () => {
    expect(
      isEmptyPlan({
        ...emptyPlan(),
        notices: [{ actualId: 'a1', reason: 'stale-pending', detail: 'x' }],
      }),
    ).toBe(true);
  });

  const nonEmpty: Array<[string, Partial<AccountPlan>]> = [
    ['updates', { updates: [{ kind: 'changed', actualId: 'a1', fields: { amount: -1 } }] }],
    [
      'imports',
      {
        imports: [
          {
            date: '2026-09-10',
            amount: -1,
            payee_name: 'x',
            imported_payee: 'x',
            imported_id: 'p1',
            cleared: true,
          },
        ],
      },
    ],
    ['deletes', { deletes: [{ actualId: 'a1', importedId: 'q1' }] }],
  ];
  it.each(nonEmpty)('is false when %s is non-empty', (_case, part) => {
    expect(isEmptyPlan({ ...emptyPlan(), ...part })).toBe(false);
  });
});

describe('planAccount: idempotency', () => {
  const plaidTxns: PlaidTxn[] = [
    plaid({ transactionId: 'p-existing', amount: 5 }),
    plaid({
      transactionId: 'p-coffee',
      pendingTransactionId: 'q-coffee',
      amount: 5.25,
      authorizedDate: '2026-09-08',
      date: '2026-09-10',
    }),
    plaid({ transactionId: 'q-gas', pending: true, amount: 52.1, date: '2026-09-11' }),
    plaid({
      transactionId: 'p-capone',
      pendingTransactionId: null,
      amount: 30,
      date: '2026-09-07',
    }),
    plaid({ transactionId: 'p-split', pendingTransactionId: 'q-split', amount: 70 }),
    plaid({ transactionId: 'q-new', pending: true, amount: 3.5, date: '2026-09-12' }),
    plaid({
      transactionId: 'p-new',
      amount: -2000,
      name: 'PAYROLL',
      merchantName: null,
      date: '2026-09-12',
    }),
  ];

  const rows: ActualTxn[] = [
    actualRow({
      id: 'r-existing',
      importedId: 'p-existing',
      amount: -500,
      date: '2026-09-10',
      cleared: true,
    }),
    actualRow({
      id: 'r-coffee',
      importedId: 'q-coffee',
      amount: -450,
      date: '2026-09-08',
      cleared: false,
    }),
    actualRow({
      id: 'r-gas',
      importedId: 'q-gas',
      amount: -4000,
      date: '2026-09-11',
      cleared: false,
    }),
    actualRow({
      id: 'r-hotel',
      importedId: 'q-hotel',
      amount: -20000,
      date: '2026-09-05',
      cleared: false,
    }),
    actualRow({
      id: 'r-stale',
      importedId: 'q-old',
      amount: -100,
      date: '2026-08-01',
      cleared: false,
    }),
    actualRow({
      id: 'r-rec-hold',
      importedId: 'q-rec',
      date: '2026-09-02',
      cleared: false,
      reconciled: true,
    }),
    actualRow({ id: 'r-manual', importedId: null, date: '2026-09-09', cleared: false }),
    actualRow({
      id: 'r-capone',
      importedId: 'q-capone',
      amount: -3000,
      date: '2026-09-06',
      cleared: false,
    }),
    actualRow({
      id: 'r-split',
      importedId: 'q-split',
      amount: -7000,
      cleared: false,
      isParent: true,
    }),
  ];

  const plan1 = plan(plaidTxns, rows);

  it('plans the mixed scenario as expected', () => {
    expect(plan1.updates).toEqual([
      {
        kind: 'posted',
        actualId: 'r-coffee',
        fields: { imported_id: 'p-coffee', amount: -525, date: '2026-09-08', cleared: true },
      },
      { kind: 'changed', actualId: 'r-gas', fields: { amount: -5210 } },
    ]);
    expect(plan1.imports.map((t) => t.imported_id)).toEqual(['p-capone', 'q-new', 'p-new']);
    expect(plan1.deletes).toEqual([
      { actualId: 'r-hotel', importedId: 'q-hotel' },
      { actualId: 'r-capone', importedId: 'q-capone' },
    ]);
    expect(plan1.notices.map((n) => [n.actualId, n.reason])).toEqual([
      ['r-stale', 'stale-pending'],
      ['r-rec-hold', 'reconciled'],
      ['r-split', 'split'],
    ]);
  });

  it('produces an empty plan when re-run against the applied result', () => {
    const applied = applyPlan(rows, plan1, ACCOUNT);
    const plan2 = plan(plaidTxns, applied);
    expect(isEmptyPlan(plan2)).toBe(true);
    expect(plan2.notices).toEqual(plan1.notices);
  });

  // [crash point, plan parts NOT applied before the crash, plan parts already done]
  const crashPoints: Array<[string, Partial<AccountPlan>, Partial<AccountPlan>]> = [
    ['updates', { imports: [], deletes: [] }, { updates: [] }],
    ['updates and imports', { deletes: [] }, { updates: [], imports: [] }],
  ];
  it.each(crashPoints)(
    'recovers from a crash after %s without repeating work',
    (_case, dropped, done) => {
      const partial = applyPlan(rows, { ...plan1, ...dropped }, ACCOUNT);
      const plan2 = plan(plaidTxns, partial);
      expect(plan2).toEqual({ ...plan1, ...done });
      expect(applyPlan(partial, plan2, ACCOUNT)).toEqual(applyPlan(rows, plan1, ACCOUNT));
      expect(isEmptyPlan(plan(plaidTxns, applyPlan(partial, plan2, ACCOUNT)))).toBe(true);
    },
  );
});
