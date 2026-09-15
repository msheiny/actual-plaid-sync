import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActualAccountInfo, ActualGateway } from '../../src/actual/session.js';
import {
  formatAccountsYaml,
  formatTable,
  plaidAccountRow,
  runAccounts,
  suggestAccounts,
} from '../../src/commands/accounts.js';
import { type AccountsConfig, parseAccountsFile } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import type { PlaidAccountInfo } from '../../src/plaid/accounts.js';
import { PlaidRequestError } from '../../src/plaid/client.js';

function plaid(
  overrides: Partial<PlaidAccountInfo> & Pick<PlaidAccountInfo, 'accountId' | 'name'>,
): PlaidAccountInfo {
  return { officialName: null, mask: null, type: 'depository', subtype: 'checking', ...overrides };
}

function actualAcct(
  overrides: Partial<ActualAccountInfo> & Pick<ActualAccountInfo, 'id' | 'name'>,
): ActualAccountInfo {
  return { closed: false, offbudget: false, ...overrides };
}

/** [plaid account id, suggested Actual account id or null] per Plaid account. */
function pairs(plaidAccounts: PlaidAccountInfo[], actualAccounts: ActualAccountInfo[]) {
  return suggestAccounts(plaidAccounts, actualAccounts).map((s) => [
    s.plaid.accountId,
    s.actual?.id ?? null,
  ]);
}

describe('suggestAccounts', () => {
  it('matches by mask contained in the Actual account name', () => {
    const result = pairs(
      [plaid({ accountId: 'p1', name: 'TOTAL CHECKING', mask: '1234' })],
      [
        actualAcct({ id: 'a0', name: 'Savings 9999' }),
        actualAcct({ id: 'a1', name: 'Chase Checking (1234)' }),
      ],
    );
    expect(result).toEqual([['p1', 'a1']]);
  });

  it('falls back to case-insensitive name or official name equality', () => {
    const result = pairs(
      [
        plaid({ accountId: 'p1', name: 'Plaid Checking', mask: '0000' }),
        plaid({
          accountId: 'p2',
          name: 'CREDIT CARD',
          officialName: 'Amex Blue Cash',
          mask: null,
          type: 'credit',
          subtype: 'credit card',
        }),
      ],
      [
        actualAcct({ id: 'a1', name: 'plaid checking' }),
        actualAcct({ id: 'a2', name: 'AMEX BLUE CASH' }),
      ],
    );
    expect(result).toEqual([
      ['p1', 'a1'],
      ['p2', 'a2'],
    ]);
  });

  it('ignores closed Actual accounts and uses each Actual account at most once', () => {
    const result = pairs(
      [
        plaid({ accountId: 'p1', name: 'Checking', mask: '1111' }),
        plaid({ accountId: 'p2', name: 'Checking', mask: '2222' }),
      ],
      [
        actualAcct({ id: 'closed', name: 'Checking', closed: true }),
        actualAcct({ id: 'a1', name: 'Checking' }),
      ],
    );
    expect(result).toEqual([
      ['p1', 'a1'],
      ['p2', null],
    ]);
  });

  it('leaves Plaid accounts without a confident match unmatched', () => {
    expect(
      pairs(
        [plaid({ accountId: 'p1', name: 'Brokerage', mask: '7777' })],
        [actualAcct({ id: 'a1', name: 'Checking' })],
      ),
    ).toEqual([['p1', null]]);
  });
});

describe('formatAccountsYaml', () => {
  it('quotes masks, uses ids for shared or missing masks, and comments out unmatched accounts', () => {
    const plaidAccounts = [
      plaid({ accountId: 'p1', name: 'Plaid Checking', mask: '1234' }),
      plaid({ accountId: 'p2', name: 'Plaid Saving', mask: '0123' }),
      plaid({ accountId: 'p3', name: 'Card A', mask: '5555' }),
      plaid({ accountId: 'p4', name: 'Card B', mask: '5555' }),
      plaid({ accountId: 'p5', name: 'Brokerage', mask: null }),
      plaid({ accountId: 'p6', name: 'CD', mask: '7777' }),
    ];
    const lines = formatAccountsYaml(
      [
        {
          plaid: plaidAccounts[0] as PlaidAccountInfo,
          actual: actualAcct({ id: 'a1', name: 'Checking' }),
        },
        {
          plaid: plaidAccounts[1] as PlaidAccountInfo,
          actual: actualAcct({ id: 'a2', name: '0123' }),
        },
        {
          plaid: plaidAccounts[2] as PlaidAccountInfo,
          actual: actualAcct({ id: 'a3', name: 'Card: A #1' }),
        },
        { plaid: plaidAccounts[3] as PlaidAccountInfo, actual: null },
        { plaid: plaidAccounts[4] as PlaidAccountInfo, actual: null },
        { plaid: plaidAccounts[5] as PlaidAccountInfo, actual: null },
      ],
      plaidAccounts,
    );
    expect(lines).toEqual([
      'accounts:',
      '  - plaid: "1234"',
      '    actual: Checking # Plaid: Plaid Checking',
      '  - plaid: "0123"',
      '    actual: "0123" # Plaid: Plaid Saving',
      '  - plaid: p3',
      '    actual: "Card: A #1" # Plaid: Card A',
      '  # - plaid: p4  # Card B — no matching Actual account',
      '  # - plaid: p5  # Brokerage — no matching Actual account',
      '  # - plaid: "7777"  # CD — no matching Actual account',
    ]);
    expect(parseAccountsFile(lines.join('\n'), 'accounts.yaml')).toEqual({
      accounts: [
        { plaid: { mask: '1234' }, actual: 'Checking' },
        { plaid: { mask: '0123' }, actual: '0123' },
        { plaid: { id: 'p3' }, actual: 'Card: A #1' },
      ],
      problems: [],
    });
  });

  it('prints a complete parseable example using IDs even for unique masks when nothing matched', () => {
    const accounts = [
      plaid({ accountId: 'p1', name: 'Plaid Checking', mask: '0000' }),
      plaid({ accountId: 'p2', name: 'Card A', mask: '5555' }),
      plaid({ accountId: 'p3', name: 'Card B', mask: '5555' }),
      plaid({ accountId: 'p4', name: 'Brokerage', mask: null }),
    ];
    const lines = formatAccountsYaml(
      accounts.map((p) => ({ plaid: p, actual: null })),
      accounts,
    );
    expect(lines).toEqual([
      'accounts:',
      '  - plaid: p1',
      '    actual: REPLACE_WITH_ACTUAL_ACCOUNT_NAME_1 # Plaid: Plaid Checking',
      '  - plaid: p2',
      '    actual: REPLACE_WITH_ACTUAL_ACCOUNT_NAME_2 # Plaid: Card A',
      '  - plaid: p3',
      '    actual: REPLACE_WITH_ACTUAL_ACCOUNT_NAME_3 # Plaid: Card B',
      '  - plaid: p4',
      '    actual: REPLACE_WITH_ACTUAL_ACCOUNT_NAME_4 # Plaid: Brokerage',
    ]);
    expect(parseAccountsFile(lines.join('\n'), 'accounts.yaml')).toEqual({
      accounts: [
        { plaid: { id: 'p1' }, actual: 'REPLACE_WITH_ACTUAL_ACCOUNT_NAME_1' },
        { plaid: { id: 'p2' }, actual: 'REPLACE_WITH_ACTUAL_ACCOUNT_NAME_2' },
        { plaid: { id: 'p3' }, actual: 'REPLACE_WITH_ACTUAL_ACCOUNT_NAME_3' },
        { plaid: { id: 'p4' }, actual: 'REPLACE_WITH_ACTUAL_ACCOUNT_NAME_4' },
      ],
      problems: [],
    });
  });
});

describe('formatTable', () => {
  it('pads columns to the widest cell', () => {
    expect(
      formatTable(
        ['ID', 'NAME'],
        [
          ['a-long-id', 'x'],
          ['b', 'yy'],
        ],
      ),
    ).toEqual(['ID         NAME', 'a-long-id  x', 'b          yy']);
  });
});

describe('plaidAccountRow', () => {
  it('maps a Plaid account to a table row with mask fallback and type/subtype', () => {
    expect(
      plaidAccountRow(
        plaid({
          accountId: 'p1',
          name: 'Plaid Checking',
          mask: '0000',
          type: 'depository',
          subtype: 'checking',
        }),
      ),
    ).toEqual(['p1', 'Plaid Checking', '0000', 'depository/checking']);
  });

  it('falls back to a dash for a null mask and bare type when subtype is null', () => {
    expect(
      plaidAccountRow(
        plaid({ accountId: 'p2', name: 'Savings', mask: null, type: 'depository', subtype: null }),
      ),
    ).toEqual(['p2', 'Savings', '-', 'depository']);
  });
});

function gatewayWith(accounts: ActualAccountInfo[]): ActualGateway {
  return {
    getAccounts: async () => accounts,
    getTransactions: async () => [],
    importTransactions: async () => ({ added: [], updated: [], errors: [] }),
    updateTransaction: async () => {},
    deleteTransaction: async () => {},
  };
}

const baseConfig: AccountsConfig = {
  accountsFile: 'accounts.yaml',
  plaid: { clientId: 'id', secret: 'secret', env: 'sandbox' },
  actual: { serverUrl: 'http://actual', password: 'pw', syncId: 'sync' },
  accessTokens: ['access-sandbox-aaaa1111'],
  logLevel: 'info',
};

describe('runAccounts', () => {
  it('writes editable YAML to the configured path and preserves it on reruns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'accounts-test-'));
    const accountsFile = join(dir, 'custom.yaml');
    const out: string[] = [];
    const deps = {
      fetchAccounts: async () => [plaid({ accountId: 'p1', name: 'Checking' })],
      gateway: gatewayWith([actualAcct({ id: 'a1', name: 'Checking' })]),
      log: createLogger('error', () => {}),
      print: (line: string) => out.push(line),
    };
    try {
      expect(await runAccounts({ ...baseConfig, accountsFile }, deps)).toBe(0);
      const saved = await readFile(accountsFile, 'utf8');
      expect(parseAccountsFile(saved, accountsFile)).toEqual({
        accounts: [{ plaid: { id: 'p1' }, actual: 'Checking' }],
        problems: [],
      });
      expect(
        await runAccounts(
          { ...baseConfig, accountsFile },
          {
            ...deps,
            gateway: gatewayWith([]),
          },
        ),
      ).toBe(0);
      expect(await readFile(accountsFile, 'utf8')).toBe(saved);
      expect(out).toContain(`Kept existing ${accountsFile}; suggested YAML is shown above.`);
      expect(
        await runAccounts(
          { ...baseConfig, accountsFile: join(dir, 'missing', 'accounts.yaml') },
          deps,
        ),
      ).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints Plaid and Actual tables and a suggested accounts.yaml', async () => {
    const out: string[] = [];
    const code = await runAccounts(baseConfig, {
      writeAccountsFile: async () => {},
      fetchAccounts: async () => [
        plaid({ accountId: 'plaid-1', name: 'Plaid Checking', mask: '0000' }),
      ],
      gateway: gatewayWith([
        actualAcct({ id: 'actual-1', name: 'Checking 0000' }),
        actualAcct({ id: 'actual-2', name: 'Old', closed: true, offbudget: true }),
      ]),
      log: createLogger('error', () => {}),
      print: (line) => out.push(line),
    });

    expect(code).toBe(0);
    expect(out).toContain('Plaid accounts for access token …1111:');
    expect(
      out.some(
        (l) =>
          l.includes('plaid-1') &&
          l.includes('Plaid Checking') &&
          l.includes('0000') &&
          l.includes('depository/checking'),
      ),
    ).toBe(true);
    expect(out).toContain('Actual accounts:');
    expect(out.some((l) => l.includes('actual-2') && l.includes('closed, off-budget'))).toBe(true);
    expect(out).toContain('Suggested accounts.yaml (review before use):');
    expect(out.slice(out.indexOf('Suggested accounts.yaml (review before use):') + 1)).toEqual([
      'accounts:',
      '  - plaid: "0000"',
      '    actual: Checking 0000 # Plaid: Plaid Checking',
      '',
      'Wrote accounts.yaml; review and edit it before syncing.',
      'accounts.yaml is git-ignored in this checkout, so it will not appear in git status.',
    ]);
    expect(out.join('\n')).not.toContain('access-sandbox-aaaa1111');
  });

  it('logs token failures, continues with other tokens, and returns 1', async () => {
    const out: string[] = [];
    const logLines: string[] = [];
    const code = await runAccounts(
      { ...baseConfig, accessTokens: ['access-bad-2222', 'access-good-3333'] },
      {
        writeAccountsFile: async () => {},
        fetchAccounts: async (token) => {
          if (token === 'access-bad-2222') {
            throw new PlaidRequestError(
              'Plaid ITEM_LOGIN_REQUIRED: login required',
              'relink',
              'ITEM_LOGIN_REQUIRED',
              null,
            );
          }
          return [plaid({ accountId: 'plaid-9', name: 'Savings', mask: null })];
        },
        gateway: gatewayWith([actualAcct({ id: 'actual-9', name: 'Groceries' })]),
        log: createLogger('info', (line) => logLines.push(line)),
        print: (line) => out.push(line),
      },
    );

    expect(code).toBe(1);
    expect(
      logLines.some(
        (l) => l.includes('ERROR') && l.includes('…2222') && l.includes('link --update'),
      ),
    ).toBe(true);
    expect(out).toContain('Plaid accounts for access token …3333:');
    expect(out).not.toContain('Plaid accounts for access token …2222:');
    expect(out).toContain('  - plaid: plaid-9');
    expect(out).toContain('    actual: REPLACE_WITH_ACTUAL_ACCOUNT_NAME_1 # Plaid: Savings');
    expect(out.some((l) => l.startsWith('No confident matches found'))).toBe(true);
  });
});
