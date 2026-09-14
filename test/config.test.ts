import { describe, expect, it } from 'vitest';
import { ConfigError, loadAccountsConfig, loadLinkConfig, loadSyncConfig } from '../src/config.js';

const PLAID_ENV_VARS = {
  PLAID_CLIENT_ID: 'client-123',
  PLAID_SECRET: 'secret-456',
  PLAID_ENV: 'sandbox',
};

const ACTUAL_ENV_VARS = {
  ACTUAL_SERVER_URL: 'https://actual.example.com',
  ACTUAL_PASSWORD: 'actual-pw',
  ACTUAL_SYNC_ID: 'sync-789',
};

const SYNC_ENV = {
  ...PLAID_ENV_VARS,
  ...ACTUAL_ENV_VARS,
  PLAID_ACCESS_TOKENS: 'access-sandbox-aaaa',
  ACCOUNT_MAP: 'plaidA:actualA',
};

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected ConfigError to be thrown');
}

function problemVars(fn: () => unknown): string[] {
  return problemsOf(fn).map((problem) => problem.slice(0, problem.indexOf(':')));
}

describe('ConfigError', () => {
  it('keeps the problems and prints one line per problem', () => {
    const err = new ConfigError(['A: is required', 'B: is required']);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ConfigError');
    expect(err.problems).toEqual(['A: is required', 'B: is required']);
    expect(err.message).toBe('Invalid configuration:\n  - A: is required\n  - B: is required');
  });
});

describe('loadSyncConfig', () => {
  it('parses a complete environment', () => {
    const cfg = loadSyncConfig({
      ...SYNC_ENV,
      PLAID_ENV: 'production',
      PLAID_ACCESS_TOKENS: 'access-production-aaaa,access-production-bbbb',
      ACCOUNT_MAP: 'plaidA:actualA,plaidB:actualB',
      ACTUAL_ENCRYPTION_PASSWORD: 'e2e-pw',
      SYNC_DAYS: '14',
      DRY_RUN: 'true',
      LOG_LEVEL: 'debug',
    });

    expect(cfg).toEqual({
      plaid: { clientId: 'client-123', secret: 'secret-456', env: 'production' },
      actual: {
        serverUrl: 'https://actual.example.com',
        password: 'actual-pw',
        syncId: 'sync-789',
        encryptionPassword: 'e2e-pw',
      },
      accessTokens: ['access-production-aaaa', 'access-production-bbbb'],
      accountMap: [
        { plaidAccountId: 'plaidA', actualAccountId: 'actualA' },
        { plaidAccountId: 'plaidB', actualAccountId: 'actualB' },
      ],
      syncDays: 14,
      dryRun: true,
      logLevel: 'debug',
    });
  });

  it('applies defaults for optional variables', () => {
    const cfg = loadSyncConfig(SYNC_ENV);

    expect(cfg.syncDays).toBe(30);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.actual).not.toHaveProperty('encryptionPassword');
  });

  it('treats empty and whitespace-only values as unset', () => {
    const cfg = loadSyncConfig({
      ...SYNC_ENV,
      ACTUAL_ENCRYPTION_PASSWORD: '',
      SYNC_DAYS: '  ',
      LOG_LEVEL: '',
    });

    expect(cfg.syncDays).toBe(30);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.actual).not.toHaveProperty('encryptionPassword');
  });

  it('trims comma lists and drops empty entries', () => {
    const cfg = loadSyncConfig({
      ...SYNC_ENV,
      PLAID_ACCESS_TOKENS: ' tok-1 , ,tok-2,',
      ACCOUNT_MAP: ' plaidA : actualA ,, plaidB:actualB , ',
    });

    expect(cfg.accessTokens).toEqual(['tok-1', 'tok-2']);
    expect(cfg.accountMap).toEqual([
      { plaidAccountId: 'plaidA', actualAccountId: 'actualA' },
      { plaidAccountId: 'plaidB', actualAccountId: 'actualB' },
    ]);
  });

  it('reports every missing required variable at once', () => {
    expect(problemsOf(() => loadSyncConfig({}))).toEqual([
      'PLAID_CLIENT_ID: is required',
      'PLAID_SECRET: is required',
      'PLAID_ENV: is required',
      'PLAID_ACCESS_TOKENS: is required',
      'ACCOUNT_MAP: is required',
      'ACTUAL_SERVER_URL: is required',
      'ACTUAL_PASSWORD: is required',
      'ACTUAL_SYNC_ID: is required',
    ]);
  });

  it('includes every problem in the error message', () => {
    expect(() => loadSyncConfig({ ...SYNC_ENV, PLAID_SECRET: undefined, SYNC_DAYS: 'x' })).toThrow(
      'Invalid configuration:\n  - PLAID_SECRET: is required\n  - SYNC_DAYS: must be an integer between 1 and 730 (got "x")',
    );
  });

  it('reports each malformed ACCOUNT_MAP entry', () => {
    expect(
      problemsOf(() =>
        loadSyncConfig({ ...SYNC_ENV, ACCOUNT_MAP: 'plaidA:actualA,oops,:actualC,plaidD:,a:b:c' }),
      ),
    ).toEqual([
      'ACCOUNT_MAP: entry 2 "oops" must be plaidAccountId:actualAccountId',
      'ACCOUNT_MAP: entry 3 ":actualC" must be plaidAccountId:actualAccountId',
      'ACCOUNT_MAP: entry 4 "plaidD:" must be plaidAccountId:actualAccountId',
      'ACCOUNT_MAP: entry 5 "a:b:c" must be plaidAccountId:actualAccountId',
    ]);
  });

  it('rejects a Plaid account mapped twice', () => {
    expect(
      problemsOf(() =>
        loadSyncConfig({ ...SYNC_ENV, ACCOUNT_MAP: 'plaidA:actualA,plaidA:actualB' }),
      ),
    ).toEqual(['ACCOUNT_MAP: plaid account "plaidA" is mapped more than once']);
  });

  it('rejects an Actual account mapped twice', () => {
    expect(
      problemsOf(() =>
        loadSyncConfig({ ...SYNC_ENV, ACCOUNT_MAP: 'plaidA:actualA,plaidB:actualA' }),
      ),
    ).toEqual(['ACCOUNT_MAP: Actual account "actualA" is mapped more than once']);
  });

  it('rejects lists that contain only separators', () => {
    expect(
      problemsOf(() =>
        loadSyncConfig({ ...SYNC_ENV, PLAID_ACCESS_TOKENS: ',', ACCOUNT_MAP: ' , ' }),
      ),
    ).toEqual([
      'PLAID_ACCESS_TOKENS: must contain at least one entry',
      'ACCOUNT_MAP: must contain at least one entry',
    ]);
  });

  it('rejects unknown enum values', () => {
    expect(
      problemsOf(() =>
        loadSyncConfig({ ...SYNC_ENV, PLAID_ENV: 'development', LOG_LEVEL: 'verbose' }),
      ),
    ).toEqual([
      'PLAID_ENV: must be one of: sandbox, production (got "development")',
      'LOG_LEVEL: must be one of: debug, info, warn, error (got "verbose")',
    ]);
  });

  it('rejects a server URL that is not http(s)', () => {
    expect(
      problemsOf(() => loadSyncConfig({ ...SYNC_ENV, ACTUAL_SERVER_URL: 'actual.local' })),
    ).toEqual(['ACTUAL_SERVER_URL: must be an http(s) URL']);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['False', false],
    ['0', false],
  ])('parses DRY_RUN=%j as %s', (value, expected) => {
    expect(loadSyncConfig({ ...SYNC_ENV, DRY_RUN: value }).dryRun).toBe(expected);
  });

  it('rejects an invalid DRY_RUN', () => {
    expect(problemsOf(() => loadSyncConfig({ ...SYNC_ENV, DRY_RUN: 'yes' }))).toEqual([
      'DRY_RUN: must be one of: true, false, 1, 0 (got "yes")',
    ]);
  });

  it.each(['0', '-5', '1.5', 'abc', '731'])('rejects SYNC_DAYS=%j', (value) => {
    expect(problemsOf(() => loadSyncConfig({ ...SYNC_ENV, SYNC_DAYS: value }))).toEqual([
      `SYNC_DAYS: must be an integer between 1 and 730 (got "${value}")`,
    ]);
  });

  it('never echoes secret values in problems', () => {
    const problems = problemsOf(() =>
      loadSyncConfig({ ...SYNC_ENV, PLAID_ENV: 'bogus', ACCOUNT_MAP: 'bad' }),
    );

    expect(problems.join('\n')).not.toContain('secret-456');
    expect(problems.join('\n')).not.toContain('actual-pw');
  });
});

describe('loadAccountsConfig', () => {
  it('parses a complete environment and ignores sync-only variables', () => {
    const cfg = loadAccountsConfig({
      ...PLAID_ENV_VARS,
      ...ACTUAL_ENV_VARS,
      PLAID_ACCESS_TOKENS: 'tok-1,tok-2',
      ACCOUNT_MAP: 'not valid but unused',
      SYNC_DAYS: 'not used either',
    });

    expect(cfg).toEqual({
      plaid: { clientId: 'client-123', secret: 'secret-456', env: 'sandbox' },
      actual: {
        serverUrl: 'https://actual.example.com',
        password: 'actual-pw',
        syncId: 'sync-789',
      },
      accessTokens: ['tok-1', 'tok-2'],
      logLevel: 'info',
    });
  });

  it('reports every missing required variable at once', () => {
    expect(problemVars(() => loadAccountsConfig({}))).toEqual([
      'PLAID_CLIENT_ID',
      'PLAID_SECRET',
      'PLAID_ENV',
      'PLAID_ACCESS_TOKENS',
      'ACTUAL_SERVER_URL',
      'ACTUAL_PASSWORD',
      'ACTUAL_SYNC_ID',
    ]);
  });
});

describe('loadLinkConfig', () => {
  it('applies defaults', () => {
    expect(loadLinkConfig(PLAID_ENV_VARS)).toEqual({
      plaid: { clientId: 'client-123', secret: 'secret-456', env: 'sandbox' },
      countryCodes: ['US'],
      port: 8484,
      host: '127.0.0.1',
      logLevel: 'info',
    });
  });

  it('parses overrides', () => {
    expect(
      loadLinkConfig({
        ...PLAID_ENV_VARS,
        PLAID_COUNTRY_CODES: 'us, ca,,GB',
        LINK_PORT: '3000',
        LINK_HOST: '0.0.0.0',
        LINK_ACCESS_TOKEN: 'access-sandbox-zzzz',
        LOG_LEVEL: 'warn',
      }),
    ).toEqual({
      plaid: { clientId: 'client-123', secret: 'secret-456', env: 'sandbox' },
      countryCodes: ['US', 'CA', 'GB'],
      port: 3000,
      host: '0.0.0.0',
      accessToken: 'access-sandbox-zzzz',
      logLevel: 'warn',
    });
  });

  it('does not require Actual or access-token variables', () => {
    expect(problemVars(() => loadLinkConfig({}))).toEqual([
      'PLAID_CLIENT_ID',
      'PLAID_SECRET',
      'PLAID_ENV',
    ]);
  });

  it.each(['0', '65536', 'http'])('rejects LINK_PORT=%j', (value) => {
    expect(problemsOf(() => loadLinkConfig({ ...PLAID_ENV_VARS, LINK_PORT: value }))).toEqual([
      `LINK_PORT: must be an integer between 1 and 65535 (got "${value}")`,
    ]);
  });

  it('rejects malformed country codes', () => {
    expect(
      problemsOf(() => loadLinkConfig({ ...PLAID_ENV_VARS, PLAID_COUNTRY_CODES: 'US,USA' })),
    ).toEqual(['PLAID_COUNTRY_CODES: "USA" is not a 2-letter country code']);
  });
});
