import { describe, expect, it, vi } from 'vitest';
import type { ActualAccountInfo, ActualGateway, ImportResult } from '../../src/actual/session.js';
import { ActualError } from '../../src/actual/session.js';
import type { SyncConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import type { PlaidAccountInfo } from '../../src/plaid/accounts.js';
import { PlaidRequestError } from '../../src/plaid/client.js';
import { executePlan, formatSummary, runSync } from '../../src/sync/run.js';
import type {
  AccountPlan,
  ActualTxn,
  ImportTxn,
  PlaidFetchResult,
  PlaidTxn,
  UpdateFields,
} from '../../src/sync/types.js';

const TODAY = '2026-09-13';

class FakeGateway implements ActualGateway {
  calls: string[] = [];
  importErrors: string[] = [];
  importUpdated: string[] = [];
  getTransactionsCalls: Array<{ accountId: string; start: string; end: string }> = [];
  getTransactionsErrors: Map<string, Error> = new Map();
  updateErrors: Map<string, Error> = new Map();
  constructor(
    public accounts: ActualAccountInfo[],
    public rows: Map<string, ActualTxn[]> = new Map(),
  ) {}
  async getAccounts(): Promise<ActualAccountInfo[]> {
    return this.accounts;
  }
  async getTransactions(accountId: string, start: string, end: string): Promise<ActualTxn[]> {
    this.getTransactionsCalls.push({ accountId, start, end });
    const err = this.getTransactionsErrors.get(accountId);
    if (err) throw err;
    return (this.rows.get(accountId) ?? []).filter((r) => r.date >= start && r.date <= end);
  }
  async importTransactions(accountId: string, txns: ImportTxn[]): Promise<ImportResult> {
    this.calls.push(`import ${accountId} ${txns.map((t) => t.imported_id).join(',')}`);
    return {
      added: txns.map((t) => t.imported_id),
      updated: this.importUpdated,
      errors: this.importErrors,
    };
  }
  async updateTransaction(id: string, fields: UpdateFields): Promise<void> {
    const err = this.updateErrors.get(id);
    if (err) throw err;
    this.calls.push(`update ${id} ${JSON.stringify(fields)}`);
  }
  async deleteTransaction(id: string): Promise<void> {
    this.calls.push(`delete ${id}`);
  }
}

function plaidTxn(overrides: Partial<PlaidTxn> & Pick<PlaidTxn, 'transactionId'>): PlaidTxn {
  return {
    accountId: 'plaid-chk',
    amount: 10,
    date: '2026-09-12',
    authorizedDate: null,
    name: 'MERCHANT',
    merchantName: null,
    pending: false,
    pendingTransactionId: null,
    ...overrides,
  };
}

function plaidAccount(accountId: string, name: string, mask: string | null): PlaidAccountInfo {
  return { accountId, name, mask, officialName: null, type: 'depository', subtype: 'checking' };
}

function actualRow(overrides: Partial<ActualTxn> & Pick<ActualTxn, 'id'>): ActualTxn {
  return {
    account: 'actual-chk',
    date: '2026-09-10',
    amount: -1000,
    importedId: null,
    cleared: false,
    reconciled: false,
    isParent: false,
    ...overrides,
  };
}

function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    plaid: { clientId: 'id', secret: 'secret', env: 'sandbox' },
    actual: { serverUrl: 'http://actual', password: 'pw', syncId: 'sync' },
    accessTokens: ['access-good-1111'],
    accountsFile: 'accounts.yaml',
    accounts: [{ plaid: { id: 'plaid-chk' }, actual: 'Chase Checking' }],
    syncDays: 30,
    dryRun: false,
    refreshTransactions: false,
    logLevel: 'debug',
    ...overrides,
  };
}

// Scenario covering every plan category for one account:
// - pend-1 (Actual, uncleared) posts as post-1        -> 1 posted
// - pend-2 (Actual, uncleared) amount changed in Plaid -> 1 amount updated
// - pend-3 (Actual, uncleared) gone from Plaid, dated inside trusted range -> 1 cancelled hold
// - new-1 only in Plaid                                -> 1 added
function scenario() {
  const gateway = new FakeGateway(
    [{ id: 'actual-chk', name: 'Chase Checking', closed: false, offbudget: false }],
    new Map([
      [
        'actual-chk',
        [
          actualRow({ id: 'row-1', importedId: 'pend-1', date: '2026-09-10', amount: -1000 }),
          actualRow({ id: 'row-2', importedId: 'pend-2', date: '2026-09-11', amount: -500 }),
          actualRow({ id: 'row-3', importedId: 'pend-3', date: '2026-09-01', amount: -300 }),
        ],
      ],
    ]),
  );
  const good: PlaidFetchResult = {
    accounts: [plaidAccount('plaid-chk', 'Plaid Checking', '0000')],
    transactions: [
      plaidTxn({
        transactionId: 'post-1',
        pendingTransactionId: 'pend-1',
        amount: 10.5,
        date: '2026-09-12',
        authorizedDate: '2026-09-10',
      }),
      plaidTxn({ transactionId: 'pend-2', pending: true, amount: 7.25, date: '2026-09-11' }),
      plaidTxn({ transactionId: 'new-1', amount: 20, date: '2026-09-12' }),
    ],
  };
  return { gateway, good };
}

function logSink() {
  const lines: string[] = [];
  const log = createLogger('debug', (line) => lines.push(line));
  const has = (text: string) => lines.some((l) => l.includes(text));
  return { lines, log, has };
}

function plaidError(kind: PlaidRequestError['kind'], code: string): PlaidRequestError {
  return new PlaidRequestError(`Plaid ${code}: failed`, kind, code, 'req-1');
}

describe('formatSummary', () => {
  it('formats counts per category', () => {
    const plan: AccountPlan = {
      actualAccountId: 'a',
      updates: [
        { kind: 'posted', actualId: '1', fields: {} },
        { kind: 'posted', actualId: '2', fields: {} },
        { kind: 'changed', actualId: '3', fields: {} },
      ],
      imports: Array.from({ length: 5 }, (_, i) => ({
        date: '2026-09-01',
        amount: -1,
        payee_name: 'p',
        imported_payee: 'p',
        imported_id: `i${i}`,
        cleared: true,
      })),
      deletes: [{ actualId: '4', importedId: 'x' }],
      notices: [],
    };
    expect(formatSummary('Chase Checking', plan)).toBe(
      'Chase Checking: 5 added, 2 posted, 1 amount updated, 1 cancelled hold, 0 skipped',
    );
  });
});

describe('executePlan', () => {
  it('runs updates, then one import, then deletes', async () => {
    const gateway = new FakeGateway([]);
    const plan: AccountPlan = {
      actualAccountId: 'acct',
      updates: [
        { kind: 'posted', actualId: 'u1', fields: { imported_id: 'p1', cleared: true } },
        { kind: 'changed', actualId: 'u2', fields: { amount: -5 } },
      ],
      imports: [
        {
          date: '2026-09-01',
          amount: -1,
          payee_name: 'a',
          imported_payee: 'a',
          imported_id: 'i1',
          cleared: true,
        },
        {
          date: '2026-09-02',
          amount: -2,
          payee_name: 'b',
          imported_payee: 'b',
          imported_id: 'i2',
          cleared: false,
        },
      ],
      deletes: [{ actualId: 'd1', importedId: 'x1' }],
      notices: [],
    };
    const result = await executePlan(gateway, plan);
    expect(gateway.calls).toEqual([
      'update u1 {"imported_id":"p1","cleared":true}',
      'update u2 {"amount":-5}',
      'import acct i1,i2',
      'delete d1',
    ]);
    expect(result).toEqual({ added: ['i1', 'i2'], updated: [], errors: [] });
  });

  it('skips the import call and returns empty arrays when there is nothing to import', async () => {
    const gateway = new FakeGateway([]);
    const result = await executePlan(gateway, {
      actualAccountId: 'acct',
      updates: [],
      imports: [],
      deletes: [],
      notices: [],
    });
    expect(gateway.calls).toEqual([]);
    expect(result).toEqual({ added: [], updated: [], errors: [] });
  });
});

describe('runSync', () => {
  it('refreshes each token in order before fetching when enabled', async () => {
    const { gateway, good } = scenario();
    const { log, has } = logSink();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const pending = runSync(
      config({
        refreshTransactions: true,
        accessTokens: ['access-first-1111', 'access-second-2222'],
      }),
      {
        gateway,
        log,
        today: TODAY,
        refreshTransactions: async (token) => {
          events.push(`refresh ${token}`);
          if (first) {
            first = false;
            await gate;
          }
        },
        fetchTransactions: async (token) => {
          events.push(`fetch ${token}`);
          return token === 'access-first-1111' ? good : { accounts: [], transactions: [] };
        },
      },
    );
    await Promise.resolve();
    expect(events).toEqual(['refresh access-first-1111']);
    release();
    const code = await pending;
    expect(code).toBe(0);
    expect(events).toEqual([
      'refresh access-first-1111',
      'fetch access-first-1111',
      'refresh access-second-2222',
      'fetch access-second-2222',
    ]);
    // Refresh is billed per request, so each one stays visible at the default info level.
    expect(has('INFO Refreshed Plaid transactions for Bank 1 (…1111)')).toBe(true);
    expect(has('INFO Refreshed Plaid transactions for Bank 2 (…2222)')).toBe(true);
  });

  it('does not refresh by default', async () => {
    const { gateway, good } = scenario();
    const { log } = logSink();
    const refresh = vi.fn();
    await runSync(config(), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: refresh,
      fetchTransactions: async () => good,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('skips refresh during dry runs and logs the notice once', async () => {
    const { gateway, good } = scenario();
    const { log, lines } = logSink();
    const refresh = vi.fn();
    await runSync(config({ refreshTransactions: true, dryRun: true }), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: refresh,
      fetchTransactions: async () => good,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(
      lines.filter((line) => line.includes('Skipping Plaid transaction refresh')),
    ).toHaveLength(1);
  });

  it.each([
    ['not-ready', 'PRODUCT_NOT_READY'],
    ['fatal', 'PRODUCTS_NOT_SUPPORTED'],
    ['fatal', 'TRANSACTIONS_NOT_INITIALIZED'],
    ['relink', 'ITEM_LOGIN_REQUIRED'],
    ['retryable', 'RATE_LIMIT_EXCEEDED'],
  ] as const)(
    'falls back to cached transactions after refresh %s/%s and continues',
    async (kind, errorCode) => {
      const { gateway, good } = scenario();
      gateway.accounts.push({ id: 'actual-card', name: 'Amex', closed: false, offbudget: false });
      const second: PlaidFetchResult = {
        accounts: [plaidAccount('plaid-card', 'Plaid Card', '5555')],
        transactions: [plaidTxn({ accountId: 'plaid-card', transactionId: 'new-card' })],
      };
      const { log, has, lines } = logSink();
      const fetch = vi.fn(async (token: string) => (token === 'access-bad-9999' ? good : second));
      const code = await runSync(
        config({
          refreshTransactions: true,
          accessTokens: ['access-bad-9999', 'access-good-1111'],
          accounts: [
            { plaid: { id: 'plaid-chk' }, actual: 'Chase Checking' },
            { plaid: { id: 'plaid-card' }, actual: 'Amex' },
          ],
        }),
        {
          gateway,
          log,
          today: TODAY,
          refreshTransactions: async (token) => {
            if (token === 'access-bad-9999') throw plaidError(kind, errorCode);
          },
          fetchTransactions: fetch,
        },
      );
      expect(code).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(1, 'access-bad-9999', '2026-08-14', '2026-09-13');
      expect(fetch).toHaveBeenNthCalledWith(2, 'access-good-1111', '2026-08-14', '2026-09-13');
      expect(has(`Bank 1 (…9999) refresh failed with ${errorCode}`)).toBe(true);
      expect(lines.join('\n')).not.toContain('access-bad-9999');
      expect(lines.join('\n')).not.toContain('access-good-1111');
      expect(has('Chase Checking: 1 added')).toBe(true);
      expect(has('Amex: 1 added')).toBe(true);
      expect(gateway.calls).toContain('import actual-card new-card');
    },
  );

  it('preserves Actual transactions and gives the repair hint when refresh fallback also fails', async () => {
    const { gateway } = scenario();
    const { log, has } = logSink();
    const fetch = vi.fn(async () => {
      throw plaidError('relink', 'ITEM_LOGIN_REQUIRED');
    });
    const code = await runSync(config({ refreshTransactions: true }), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: async () => {
        throw plaidError('relink', 'ITEM_LOGIN_REQUIRED');
      },
      fetchTransactions: fetch,
    });
    expect(code).toBe(1);
    expect(fetch).toHaveBeenCalledWith('access-good-1111', '2026-08-14', '2026-09-13');
    expect(gateway.calls).toEqual([]);
    expect(has('needs re-authentication')).toBe(true);
    expect(has('mise run link:update')).toBe(true);
  });

  it('applies the plan and logs a summary per account', async () => {
    const { gateway, good } = scenario();
    const { log, has } = logSink();
    const fetched: string[] = [];
    const code = await runSync(config(), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: async () => undefined,
      fetchTransactions: async (token, start, end) => {
        fetched.push(`${token} ${start} ${end}`);
        return good;
      },
    });
    expect(code).toBe(0);
    expect(fetched).toEqual(['access-good-1111 2026-08-14 2026-09-13']);
    expect(
      has('Chase Checking: 1 added, 1 posted, 1 amount updated, 1 cancelled hold, 0 skipped'),
    ).toBe(true);
    expect(gateway.calls.map((c) => c.split(' ')[0])).toEqual([
      'update',
      'update',
      'import',
      'delete',
    ]);
    expect(gateway.calls).toContain('delete row-3');
    expect(gateway.calls).toContain('import actual-chk new-1');
  });

  it('performs no writes in dry run and logs the planned changes', async () => {
    const { gateway, good } = scenario();
    const { log, has } = logSink();
    const code = await runSync(config({ dryRun: true }), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: async () => undefined,
      fetchTransactions: async () => good,
    });
    expect(code).toBe(0);
    expect(gateway.calls).toEqual([]);
    expect(
      has(
        '[dry run] Chase Checking: 1 added, 1 posted, 1 amount updated, 1 cancelled hold, 0 skipped',
      ),
    ).toBe(true);
    expect(has('[dry run] Chase Checking: import 2026-09-12 -20.00 MERCHANT (new-1)')).toBe(true);
    expect(has('[dry run] Chase Checking: delete cancelled hold row-3 (pend-3)')).toBe(true);
  });

  it('logs a relink error for one bank, still syncs the other, and returns 1', async () => {
    const { gateway, good } = scenario();
    gateway.accounts.push({ id: 'actual-card', name: 'Amex', closed: false, offbudget: false });
    // Mass-delete guard: if the account-not-covered check were removed, this uncleared row
    // (non-null importedId, dated inside the trusted range) would be planned against an empty
    // Plaid txn list for the unfetched bank and deleted as a "cancelled hold".
    gateway.rows.set('actual-card', [
      actualRow({
        id: 'card-row-1',
        account: 'actual-card',
        importedId: 'card-pend-1',
        date: '2026-09-05',
        amount: -400,
      }),
    ]);
    const { log, has } = logSink();
    const code = await runSync(
      config({
        accessTokens: ['access-bad-9999', 'access-good-1111'],
        accounts: [
          { plaid: { id: 'plaid-card' }, actual: 'Amex' },
          { plaid: { id: 'plaid-chk' }, actual: 'Chase Checking' },
        ],
      }),
      {
        gateway,
        log,
        today: TODAY,
        refreshTransactions: async () => undefined,
        fetchTransactions: async (token) => {
          if (token === 'access-bad-9999') throw plaidError('relink', 'ITEM_LOGIN_REQUIRED');
          return good;
        },
      },
    );
    expect(code).toBe(1);
    expect(
      has('Bank 1 (…9999) needs re-authentication: run `mise run link:update` and choose bank 1'),
    ).toBe(true);
    expect(has('access-bad-9999')).toBe(false);
    expect(has('on any access token')).toBe(false);
    expect(has('(plaid id plaid-card → Amex): skipped')).toBe(true);
    expect(has('Chase Checking: 1 added')).toBe(true);
    expect(gateway.getTransactionsCalls.some((c) => c.accountId === 'actual-card')).toBe(false);
    expect(gateway.calls).not.toContain('delete card-row-1');
  });

  it('treats PRODUCT_NOT_READY as a warning and returns 0', async () => {
    const { gateway, good } = scenario();
    gateway.accounts.push({ id: 'actual-card', name: 'Amex', closed: false, offbudget: false });
    // Mass-delete guard: see the relink test above for why this row must survive untouched.
    gateway.rows.set('actual-card', [
      actualRow({
        id: 'card-row-1',
        account: 'actual-card',
        importedId: 'card-pend-1',
        date: '2026-09-05',
        amount: -400,
      }),
    ]);
    const { log, lines, has } = logSink();
    const code = await runSync(
      config({
        accessTokens: ['access-new-2222', 'access-good-1111'],
        accounts: [
          { plaid: { id: 'plaid-card' }, actual: 'Amex' },
          { plaid: { id: 'plaid-chk' }, actual: 'Chase Checking' },
        ],
      }),
      {
        gateway,
        log,
        today: TODAY,
        refreshTransactions: async () => undefined,
        fetchTransactions: async (token) => {
          if (token === 'access-new-2222') throw plaidError('not-ready', 'PRODUCT_NOT_READY');
          return good;
        },
      },
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes(' WARN ') && l.includes('…2222'))).toBe(true);
    expect(lines.some((l) => l.includes(' ERROR '))).toBe(false);
    expect(has('Chase Checking: 1 added')).toBe(true);
    expect(gateway.getTransactionsCalls.some((c) => c.accountId === 'actual-card')).toBe(false);
    expect(gateway.calls).not.toContain('delete card-row-1');
  });

  it('logs other Plaid errors with their code and returns 1', async () => {
    const { gateway } = scenario();
    const { log, has } = logSink();
    const code = await runSync(config(), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: async () => undefined,
      fetchTransactions: async () => {
        throw plaidError('fatal', 'INVALID_ACCESS_TOKEN');
      },
    });
    expect(code).toBe(1);
    expect(has('Bank 1 (…1111) failed with INVALID_ACCESS_TOKEN')).toBe(true);
    expect(gateway.calls).toEqual([]);
  });

  it('logs unmapped Plaid accounts at info level', async () => {
    const { gateway, good } = scenario();
    const { log, has } = logSink();
    const code = await runSync(config(), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: async () => undefined,
      fetchTransactions: async () => ({
        ...good,
        accounts: [...good.accounts, plaidAccount('plaid-savings', 'Plaid Saving', '1111')],
      }),
    });
    expect(code).toBe(0);
    expect(has('INFO Skipping unmapped Plaid account Plaid Saving (…1111)')).toBe(true);
    expect(has('Skipping unmapped Plaid account Plaid Checking')).toBe(false);
  });

  it('returns 1 when an entry names an Actual account that does not exist', async () => {
    const { gateway, good } = scenario();
    const { log, has } = logSink();
    const code = await runSync(
      config({ accounts: [{ plaid: { id: 'plaid-chk' }, actual: 'Missing Account' }] }),
      {
        gateway,
        log,
        today: TODAY,
        refreshTransactions: async () => undefined,
        fetchTransactions: async () => good,
      },
    );
    expect(code).toBe(1);
    expect(
      has(
        'ERROR accounts.yaml entry 1 (plaid id plaid-chk → Missing Account): no open Actual account named "Missing Account"',
      ),
    ).toBe(true);
    expect(gateway.calls).toEqual([]);
  });

  it('returns 1 when an entry names a Plaid account no token returned', async () => {
    const { gateway, good } = scenario();
    const { log, has } = logSink();
    const code = await runSync(
      config({ accounts: [{ plaid: { mask: '9999' }, actual: 'Chase Checking' }] }),
      {
        gateway,
        log,
        today: TODAY,
        refreshTransactions: async () => undefined,
        fetchTransactions: async () => good,
      },
    );
    expect(code).toBe(1);
    expect(
      has(
        'ERROR accounts.yaml entry 1 (plaid 9999 → Chase Checking): no Plaid account with mask 9999 on any access token',
      ),
    ).toBe(true);
    expect(gateway.calls).toEqual([]);
  });

  it('resolves masks across every token and still syncs good entries when one is ambiguous', async () => {
    const { gateway, good } = scenario();
    gateway.accounts.push({ id: 'actual-card', name: 'Amex', closed: false, offbudget: false });
    const { log, has } = logSink();
    const code = await runSync(
      config({
        accessTokens: ['access-good-1111', 'access-card-2222'],
        accounts: [
          { plaid: { mask: '0000' }, actual: 'Chase Checking' },
          { plaid: { mask: '5555' }, actual: 'Amex' },
        ],
      }),
      {
        gateway,
        log,
        today: TODAY,
        refreshTransactions: async () => undefined,
        fetchTransactions: async (token) =>
          token === 'access-good-1111'
            ? good
            : {
                accounts: [
                  plaidAccount('plaid-card', 'Card', '5555'),
                  plaidAccount('plaid-card-2', 'Card 2', '5555'),
                ],
                transactions: [],
              },
      },
    );
    expect(code).toBe(1);
    expect(has('(plaid 5555 → Amex): mask 5555 matches 2 Plaid accounts')).toBe(true);
    expect(has('Chase Checking: 1 added')).toBe(true);
    expect(gateway.getTransactionsCalls.some((c) => c.accountId === 'actual-card')).toBe(false);
  });

  it('returns 1 and logs each import error', async () => {
    const { gateway, good } = scenario();
    gateway.importErrors = ['Transaction date is invalid'];
    const { log, has } = logSink();
    const code = await runSync(config(), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: async () => undefined,
      fetchTransactions: async () => good,
    });
    expect(code).toBe(1);
    expect(has('Chase Checking: import error: Transaction date is invalid')).toBe(true);
  });

  // F-I4: importTransactions fuzzy-matches new rows against an existing uncleared row (same
  // amount, date within ~7 days) and reports the matched row's id in `updated`. That must be
  // surfaced as a warning, since a later-cancelled hold could delete the matched row instead of
  // a newly-added one.
  it('warns once per id reported in result.updated after a non-dry-run import', async () => {
    const { gateway, good } = scenario();
    gateway.importUpdated = ['row-x'];
    const { log, has } = logSink();
    const code = await runSync(config(), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: async () => undefined,
      fetchTransactions: async () => good,
    });
    expect(code).toBe(0);
    expect(
      has(
        'Chase Checking: import matched an existing transaction row-x instead of adding a new one',
      ),
    ).toBe(true);
  });

  // Controller review, fix round 1, finding 1: a gateway write rejecting for one account must
  // not abort later entries in the accounts file, and must not throw out of runSync.
  it('logs an ActualError with its hint for one account, still applies the other, and returns 1', async () => {
    const gateway = new FakeGateway(
      [
        { id: 'actual-a', name: 'Account A', closed: false, offbudget: false },
        { id: 'actual-b', name: 'Account B', closed: false, offbudget: false },
      ],
      new Map([
        [
          'actual-a',
          [
            actualRow({
              id: 'row-a',
              account: 'actual-a',
              importedId: 'pend-a',
              date: '2026-09-11',
              amount: -500,
            }),
          ],
        ],
        ['actual-b', []],
      ]),
    );
    gateway.updateErrors.set(
      'row-a',
      new ActualError('write failed', 'network-failure', 'check ACTUAL_SERVER_URL is reachable'),
    );
    const { log, has } = logSink();
    const code = await runSync(
      config({
        accounts: [
          { plaid: { mask: '1111' }, actual: 'Account A' },
          { plaid: { id: 'plaid-b' }, actual: 'account b' },
        ],
      }),
      {
        gateway,
        log,
        today: TODAY,
        refreshTransactions: async () => undefined,
        fetchTransactions: async () => ({
          accounts: [
            plaidAccount('plaid-a', 'Plaid A', '1111'),
            plaidAccount('plaid-b', 'Plaid B', '2222'),
          ],
          transactions: [
            plaidTxn({
              transactionId: 'pend-a',
              accountId: 'plaid-a',
              pending: true,
              amount: 6,
              date: '2026-09-11',
            }),
            plaidTxn({
              transactionId: 'new-b',
              accountId: 'plaid-b',
              amount: 12,
              date: '2026-09-12',
            }),
          ],
        }),
      },
    );
    expect(code).toBe(1);
    expect(has('Account A: failed: write failed (check ACTUAL_SERVER_URL is reachable)')).toBe(
      true,
    );
    expect(gateway.calls).toContain('import actual-b new-b');
  });

  it('logs a getTransactions failure for one account, still applies the other, and returns 1', async () => {
    const gateway = new FakeGateway(
      [
        { id: 'actual-a', name: 'Account A', closed: false, offbudget: false },
        { id: 'actual-b', name: 'Account B', closed: false, offbudget: false },
      ],
      new Map([['actual-b', []]]),
    );
    gateway.getTransactionsErrors.set(
      'actual-a',
      new ActualError('budget locked', 'network-failure', 'check ACTUAL_SERVER_URL is reachable'),
    );
    const { log, has } = logSink();
    const code = await runSync(
      config({
        accounts: [
          { plaid: { mask: '1111' }, actual: 'Account A' },
          { plaid: { id: 'plaid-b' }, actual: 'account b' },
        ],
      }),
      {
        gateway,
        log,
        today: TODAY,
        refreshTransactions: async () => undefined,
        fetchTransactions: async () => ({
          accounts: [
            plaidAccount('plaid-a', 'Plaid A', '1111'),
            plaidAccount('plaid-b', 'Plaid B', '2222'),
          ],
          transactions: [
            plaidTxn({
              transactionId: 'new-b',
              accountId: 'plaid-b',
              amount: 12,
              date: '2026-09-12',
            }),
          ],
        }),
      },
    );
    expect(code).toBe(1);
    expect(has('Account A: failed: budget locked (check ACTUAL_SERVER_URL is reachable)')).toBe(
      true,
    );
    expect(gateway.calls).toContain('import actual-b new-b');
  });

  // Controller decision 1 (Task 4 review): planAccount does no account filtering itself, so
  // runSync must not leak an unmapped Plaid account's transactions into a mapped account's plan,
  // and must load Actual rows with the extended lookback window, not the plain fetch window.
  it('does not leak an unmapped Plaid account transaction into a mapped account plan', async () => {
    const gateway = new FakeGateway(
      [{ id: 'actual-chk', name: 'Chase Checking', closed: false, offbudget: false }],
      new Map([['actual-chk', []]]),
    );
    const { log, has } = logSink();
    const code = await runSync(config(), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: async () => undefined,
      fetchTransactions: async () => ({
        accounts: [
          plaidAccount('plaid-chk', 'Plaid Checking', '0000'),
          plaidAccount('plaid-savings', 'Plaid Saving', '1111'),
        ],
        transactions: [
          plaidTxn({ transactionId: 'chk-1', accountId: 'plaid-chk', amount: 5 }),
          plaidTxn({ transactionId: 'savings-1', accountId: 'plaid-savings', amount: 999 }),
        ],
      }),
    });
    expect(code).toBe(0);
    expect(gateway.calls).toEqual(['import actual-chk chk-1']);
    expect(has('savings-1')).toBe(false);
  });

  it('loads Actual transactions using the extended lookback window, not the plain fetch window', async () => {
    const { gateway, good } = scenario();
    const { log } = logSink();
    await runSync(config(), {
      gateway,
      log,
      today: TODAY,
      refreshTransactions: async () => undefined,
      fetchTransactions: async () => good,
    });
    expect(gateway.getTransactionsCalls).toEqual([
      { accountId: 'actual-chk', start: '2026-07-15', end: '2026-09-13' },
    ]);
  });
});
