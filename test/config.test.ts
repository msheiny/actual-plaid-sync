import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadAccountsConfig,
  loadLinkConfig,
  loadSyncConfig,
  parseAccountsFile,
} from '../src/config.js';

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
};

const ACCOUNTS_YAML = `accounts:
  - plaid: "1234"
    actual: Chase Checking
  - plaid: { id: BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp }
    actual: Joint Visa
`;

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
    code: 'ENOENT',
  });
}

/** Reads fake files; the default accounts.yaml is always valid. */
function reader(files: Record<string, string> = {}): (path: string) => string {
  const all: Record<string, string> = { 'accounts.yaml': ACCOUNTS_YAML, ...files };
  return (path) => {
    const text = all[path];
    if (text === undefined) throw enoent(path);
    return text;
  };
}

const loadSync = (env: NodeJS.ProcessEnv) => loadSyncConfig(env, reader());

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
    const readFile = reader({ '/config/accounts.yaml': ACCOUNTS_YAML });
    const cfg = loadSyncConfig(
      {
        ...SYNC_ENV,
        PLAID_ENV: 'production',
        PLAID_ACCESS_TOKENS: 'access-production-aaaa,access-production-bbbb',
        ACCOUNTS_FILE: '/config/accounts.yaml',
        ACTUAL_ENCRYPTION_PASSWORD: 'e2e-pw',
        SYNC_DAYS: '14',
        DRY_RUN: 'true',
        LOG_LEVEL: 'debug',
      },
      readFile,
    );

    expect(cfg).toEqual({
      plaid: { clientId: 'client-123', secret: 'secret-456', env: 'production' },
      actual: {
        serverUrl: 'https://actual.example.com',
        password: 'actual-pw',
        syncId: 'sync-789',
        encryptionPassword: 'e2e-pw',
      },
      accessTokens: ['access-production-aaaa', 'access-production-bbbb'],
      accountsFile: '/config/accounts.yaml',
      accounts: [
        { plaid: { mask: '1234' }, actual: 'Chase Checking' },
        { plaid: { id: 'BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp' }, actual: 'Joint Visa' },
      ],
      syncDays: 14,
      dryRun: true,
      logLevel: 'debug',
    });
  });

  it('applies defaults for optional variables', () => {
    const cfg = loadSync(SYNC_ENV);

    expect(cfg.accountsFile).toBe('accounts.yaml');
    expect(cfg.syncDays).toBe(30);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.actual).not.toHaveProperty('encryptionPassword');
  });

  it('treats empty and whitespace-only values as unset', () => {
    const cfg = loadSync({
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
    const cfg = loadSync({ ...SYNC_ENV, PLAID_ACCESS_TOKENS: ' tok-1 , ,tok-2,' });

    expect(cfg.accessTokens).toEqual(['tok-1', 'tok-2']);
  });

  it('reports every missing required variable at once', () => {
    expect(problemsOf(() => loadSync({}))).toEqual([
      'PLAID_CLIENT_ID: is required',
      'PLAID_SECRET: is required',
      'PLAID_ENV: is required',
      'PLAID_ACCESS_TOKENS: is required',
      'ACTUAL_SERVER_URL: is required',
      'ACTUAL_PASSWORD: is required',
      'ACTUAL_SYNC_ID: is required',
    ]);
  });

  it('includes every problem in the error message', () => {
    expect(() => loadSync({ ...SYNC_ENV, PLAID_SECRET: undefined, SYNC_DAYS: 'x' })).toThrow(
      'Invalid configuration:\n  - PLAID_SECRET: is required\n  - SYNC_DAYS: must be an integer between 1 and 730 (got "x")',
    );
  });

  it('rejects lists that contain only separators', () => {
    expect(problemsOf(() => loadSync({ ...SYNC_ENV, PLAID_ACCESS_TOKENS: ',' }))).toEqual([
      'PLAID_ACCESS_TOKENS: must contain at least one entry',
    ]);
  });

  it('rejects unknown enum values', () => {
    expect(
      problemsOf(() => loadSync({ ...SYNC_ENV, PLAID_ENV: 'development', LOG_LEVEL: 'verbose' })),
    ).toEqual([
      'PLAID_ENV: must be one of: sandbox, production (got "development")',
      'LOG_LEVEL: must be one of: debug, info, warn, error (got "verbose")',
    ]);
  });

  it('rejects a server URL that is not http(s)', () => {
    expect(problemsOf(() => loadSync({ ...SYNC_ENV, ACTUAL_SERVER_URL: 'actual.local' }))).toEqual([
      'ACTUAL_SERVER_URL: must be an http(s) URL',
    ]);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['False', false],
    ['0', false],
  ])('parses DRY_RUN=%j as %s', (value, expected) => {
    expect(loadSync({ ...SYNC_ENV, DRY_RUN: value }).dryRun).toBe(expected);
  });

  it('rejects an invalid DRY_RUN', () => {
    expect(problemsOf(() => loadSync({ ...SYNC_ENV, DRY_RUN: 'yes' }))).toEqual([
      'DRY_RUN: must be one of: true, false, 1, 0 (got "yes")',
    ]);
  });

  it.each(['0', '-5', '1.5', 'abc', '731'])('rejects SYNC_DAYS=%j', (value) => {
    expect(problemsOf(() => loadSync({ ...SYNC_ENV, SYNC_DAYS: value }))).toEqual([
      `SYNC_DAYS: must be an integer between 1 and 730 (got "${value}")`,
    ]);
  });

  it('never echoes secret values in problems', () => {
    const problems = problemsOf(() =>
      loadSyncConfig(
        { ...SYNC_ENV, PLAID_ENV: 'bogus' },
        reader({ 'accounts.yaml': 'accounts:\n  - plaid: 1234\n' }),
      ),
    );

    expect(problems.join('\n')).not.toContain('secret-456');
    expect(problems.join('\n')).not.toContain('actual-pw');
  });
});

describe('loadSyncConfig accounts file', () => {
  it('reads ACCOUNTS_FILE instead of the default path', () => {
    const cfg = loadSyncConfig(
      { ...SYNC_ENV, ACCOUNTS_FILE: 'other.yaml' },
      reader({
        'accounts.yaml': 'not: used',
        'other.yaml': 'accounts:\n  - plaid: "9"\n    actual: X\n',
      }),
    );
    expect(cfg.accountsFile).toBe('other.yaml');
    expect(cfg.accounts).toEqual([{ plaid: { mask: '9' }, actual: 'X' }]);
  });

  it('reports a missing file as one problem without a stack', () => {
    expect(
      problemsOf(() => loadSyncConfig({ ...SYNC_ENV, ACCOUNTS_FILE: 'missing.yaml' }, reader())),
    ).toEqual(['missing.yaml: cannot read file (ENOENT)']);
  });

  it('falls back to the error message when a read error has no code', () => {
    const readFile = () => {
      throw new Error('boom\nstack-ish detail');
    };
    expect(problemsOf(() => loadSyncConfig(SYNC_ENV, readFile))).toEqual([
      'accounts.yaml: cannot read file (boom)',
    ]);
  });

  it('reports env problems and file problems together', () => {
    expect(
      problemsOf(() =>
        loadSyncConfig(
          { ...SYNC_ENV, PLAID_SECRET: undefined },
          reader({ 'accounts.yaml': 'accounts:\n  - plaid: "1"\n' }),
        ),
      ),
    ).toEqual(['PLAID_SECRET: is required', 'accounts.yaml: entry 1: actual is required']);
  });

  it('uses the real filesystem by default', () => {
    expect(
      problemsOf(() =>
        loadSyncConfig({ ...SYNC_ENV, ACCOUNTS_FILE: '/nonexistent/actual-plaid-sync.yaml' }),
      ),
    ).toEqual(['/nonexistent/actual-plaid-sync.yaml: cannot read file (ENOENT)']);
  });
});

describe('parseAccountsFile', () => {
  const parse = (text: string) => parseAccountsFile(text, 'accounts.yaml');

  it('parses masks and pinned ids, trimming values', () => {
    expect(
      parse(
        'accounts:\n  - plaid: " 1234 "\n    actual: "  Chase Checking "\n  - plaid: { id: abc }\n    actual: Visa\n',
      ),
    ).toEqual({
      accounts: [
        { plaid: { mask: '1234' }, actual: 'Chase Checking' },
        { plaid: { id: 'abc' }, actual: 'Visa' },
      ],
      problems: [],
    });
  });

  it.each([
    ['an empty file', ''],
    ['a comment-only file', '# nothing yet\n'],
    ['an empty accounts key', 'accounts:\n'],
    ['an empty list', 'accounts: []\n'],
  ])('rejects %s', (_label, text) => {
    expect(parse(text).problems).toEqual([
      'accounts.yaml: accounts must contain at least one entry',
    ]);
  });

  it('reports invalid YAML as one line with its position', () => {
    const { problems } = parse('accounts: [\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^accounts\.yaml: invalid YAML: .* at line 2, column 1$/);
  });

  it('reports duplicate YAML keys', () => {
    const { problems } = parse('accounts:\n  - plaid: "1"\n    plaid: "2"\n    actual: X\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^accounts\.yaml: invalid YAML: Map keys must be unique/);
  });

  it('rejects a non-mapping root, a non-list accounts, and unknown top-level keys', () => {
    expect(parse('- plaid: "1"\n').problems).toEqual([
      'accounts.yaml: must be a mapping with an "accounts" list',
    ]);
    expect(parse('accounts: nope\nextra: 1\n').problems).toEqual([
      'accounts.yaml: unknown key "extra"',
      'accounts.yaml: accounts must be a list',
    ]);
  });

  it('asks for quotes around an unquoted numeric mask, keeping leading zeros', () => {
    expect(
      parse('accounts:\n  - plaid: 1234\n    actual: A\n  - plaid: 0123\n    actual: B\n').problems,
    ).toEqual([
      'accounts.yaml: entry 1: plaid mask 1234 must be quoted ("1234")',
      'accounts.yaml: entry 2: plaid mask 0123 must be quoted ("0123")',
    ]);
  });

  it('accepts plain account IDs alongside quoted masks and legacy ID objects', () => {
    expect(
      parseAccountsFile(
        [
          'accounts:',
          '  - plaid: " p-checking "',
          '    actual: Checking',
          '  - plaid: "0123"',
          '    actual: Savings',
          '  - plaid: { id: p-card }',
          '    actual: Card',
        ].join('\n'),
        'accounts.yaml',
      ),
    ).toEqual({
      accounts: [
        { plaid: { id: 'p-checking' }, actual: 'Checking' },
        { plaid: { mask: '0123' }, actual: 'Savings' },
        { plaid: { id: 'p-card' }, actual: 'Card' },
      ],
      problems: [],
    });
  });

  it('reports every bad entry shape with its 1-based number', () => {
    const text = [
      'accounts:',
      '  - plaid: "1"',
      '    actual: One',
      '  - just a string',
      '  - actual: Three',
      '  - plaid: "4"',
      '  - plaid: ""',
      '    actual: "  "',
      '  - plaid: { id: "" }',
      '    actual: 7',
      '  - plaid: { account: x }',
      '    actual: [a]',
      '  - plaid: true',
      '    actual: Nine',
      '    actaul: typo',
      '  - plaid: { id: 5 }',
      '    actual: Ten',
    ].join('\n');
    expect(parse(text).problems).toEqual([
      'accounts.yaml: entry 2: must be a mapping with plaid and actual',
      'accounts.yaml: entry 3: plaid is required',
      'accounts.yaml: entry 4: actual is required',
      'accounts.yaml: entry 5: plaid must not be empty',
      'accounts.yaml: entry 5: actual must not be empty',
      'accounts.yaml: entry 6: plaid.id must not be empty',
      'accounts.yaml: entry 6: actual 7 must be quoted ("7")',
      'accounts.yaml: entry 7: plaid: unknown key "account"',
      'accounts.yaml: entry 7: plaid.id is required',
      'accounts.yaml: entry 7: actual must be an Actual account name',
      'accounts.yaml: entry 8: unknown key "actaul"',
      'accounts.yaml: entry 8: plaid must be an account ID string or a quoted mask like "1234"',
      'accounts.yaml: entry 9: plaid.id must be a string',
    ]);
  });

  it('rejects static duplicates of a mask, an id, or an Actual name (case-insensitive)', () => {
    const text = [
      'accounts:',
      '  - plaid: "1234"',
      '    actual: Chase Checking',
      '  - plaid: "1234"',
      '    actual: Other',
      '  - plaid: { id: abc }',
      '    actual: Visa',
      '  - plaid: { id: abc }',
      '    actual: Amex',
      '  - plaid: "9999"',
      '    actual: " chase CHECKING"',
    ].join('\n');
    expect(parse(text)).toEqual({
      accounts: [],
      problems: [
        'accounts.yaml: entry 2: plaid mask 1234 is already used by entry 1',
        'accounts.yaml: entry 4: plaid id abc is already used by entry 3',
        'accounts.yaml: entry 5: actual "chase CHECKING" is already used by entry 1',
      ],
    });
  });
});

describe('loadAccountsConfig', () => {
  it('parses a complete environment and ignores sync-only variables', () => {
    const cfg = loadAccountsConfig({
      ...PLAID_ENV_VARS,
      ...ACTUAL_ENV_VARS,
      PLAID_ACCESS_TOKENS: 'tok-1,tok-2',
      ACCOUNTS_FILE: '/does/not/exist.yaml',
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
