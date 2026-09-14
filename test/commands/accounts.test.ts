import { describe, expect, it } from 'vitest';
import type { ActualAccountInfo, ActualGateway } from '../../src/actual/session.js';
import {
  formatTable,
  plaidAccountRow,
  runAccounts,
  suggestAccountMap,
} from '../../src/commands/accounts.js';
import type { AccountsConfig } from '../../src/config.js';
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

describe('suggestAccountMap', () => {
  it('matches by mask contained in the Actual account name', () => {
    const result = suggestAccountMap(
      [plaid({ accountId: 'p1', name: 'TOTAL CHECKING', mask: '1234' })],
      [
        actualAcct({ id: 'a0', name: 'Savings 9999' }),
        actualAcct({ id: 'a1', name: 'Chase Checking (1234)' }),
      ],
    );
    expect(result).toEqual([{ plaidAccountId: 'p1', actualAccountId: 'a1' }]);
  });

  it('falls back to case-insensitive name or official name equality', () => {
    const result = suggestAccountMap(
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
      { plaidAccountId: 'p1', actualAccountId: 'a1' },
      { plaidAccountId: 'p2', actualAccountId: 'a2' },
    ]);
  });

  it('ignores closed Actual accounts and uses each Actual account at most once', () => {
    const result = suggestAccountMap(
      [
        plaid({ accountId: 'p1', name: 'Checking', mask: '1111' }),
        plaid({ accountId: 'p2', name: 'Checking', mask: '2222' }),
      ],
      [
        actualAcct({ id: 'closed', name: 'Checking', closed: true }),
        actualAcct({ id: 'a1', name: 'Checking' }),
      ],
    );
    expect(result).toEqual([{ plaidAccountId: 'p1', actualAccountId: 'a1' }]);
  });

  it('omits Plaid accounts without a confident match', () => {
    expect(
      suggestAccountMap(
        [plaid({ accountId: 'p1', name: 'Brokerage', mask: '7777' })],
        [actualAcct({ id: 'a1', name: 'Checking' })],
      ),
    ).toEqual([]);
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
  plaid: { clientId: 'id', secret: 'secret', env: 'sandbox' },
  actual: { serverUrl: 'http://actual', password: 'pw', syncId: 'sync' },
  accessTokens: ['access-sandbox-aaaa1111'],
  logLevel: 'info',
};

describe('runAccounts', () => {
  it('prints Plaid and Actual tables and a suggested ACCOUNT_MAP', async () => {
    const out: string[] = [];
    const code = await runAccounts(baseConfig, {
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
    expect(out).toContain('ACCOUNT_MAP=plaid-1:actual-1');
    expect(out.join('\n')).not.toContain('access-sandbox-aaaa1111');
  });

  it('logs token failures, continues with other tokens, and returns 1', async () => {
    const out: string[] = [];
    const logLines: string[] = [];
    const code = await runAccounts(
      { ...baseConfig, accessTokens: ['access-bad-2222', 'access-good-3333'] },
      {
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
    expect(out.some((l) => l.startsWith('No confident ACCOUNT_MAP matches'))).toBe(true);
  });
});
