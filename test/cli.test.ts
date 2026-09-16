import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withBudget: vi.fn(),
  runSync: vi.fn(),
  plaidFetchTransactions: vi.fn(),
  plaidRefreshTransactions: vi.fn(),
  sessionLoads: 0,
  startLinkServer: vi.fn(),
}));

// Keep @actual-app/api (native sqlite) and the real sync out of CLI tests; no network happens.
// The factory runs only when src/cli.ts actually imports the module, so sessionLoads tracks lazy
// loading. vi.resetModules() in beforeEach forces every test's `await import('../src/cli.js')` to
// re-evaluate the module graph from scratch, so the factory (and this counter) is order-independent.
vi.mock('../src/actual/session.js', () => {
  mocks.sessionLoads += 1;
  return { withBudget: mocks.withBudget };
});
vi.mock('../src/sync/run.js', () => ({ runSync: mocks.runSync }));
vi.mock('../src/plaid/transactions.js', () => ({
  fetchTransactions: mocks.plaidFetchTransactions,
  refreshTransactions: mocks.plaidRefreshTransactions,
}));
// Only startLinkServer is faked (no real socket); formatLinkResult stays real so the success-path
// test below exercises the actual output formatting too.
vi.mock('../src/link/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/link/server.js')>();
  return { ...actual, startLinkServer: mocks.startLinkServer };
});

const accountsDir = mkdtempSync(join(tmpdir(), 'actual-plaid-sync-cli-test-'));
const accountsFile = join(accountsDir, 'accounts.yaml');
writeFileSync(accountsFile, 'accounts:\n  - plaid: "1234"\n    actual: Checking\n');
afterAll(() => rmSync(accountsDir, { recursive: true, force: true }));

const SYNC_ENV: NodeJS.ProcessEnv = {
  PLAID_CLIENT_ID: 'client-id',
  PLAID_SECRET: 'secret',
  PLAID_ENV: 'sandbox',
  PLAID_ACCESS_TOKENS: 'access-sandbox-1',
  ACCOUNTS_FILE: accountsFile,
  ACTUAL_SERVER_URL: 'http://actual.example.test',
  ACTUAL_PASSWORD: 'password',
  ACTUAL_SYNC_ID: '00000000-0000-4000-8000-000000000000',
};

let stdout: string[];
let stderr: string[];
let main: typeof import('../src/cli.js').main;
let ActualError: typeof import('../src/actual/errors.js').ActualError;
let PlaidRequestError: typeof import('../src/plaid/client.js').PlaidRequestError;

beforeEach(async () => {
  stdout = [];
  stderr = [];
  mocks.withBudget.mockReset();
  mocks.runSync.mockReset();
  mocks.plaidFetchTransactions.mockReset();
  mocks.plaidRefreshTransactions.mockReset();
  mocks.startLinkServer.mockReset();
  mocks.sessionLoads = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(`${args.map(String).join(' ')}\n`);
  });
  // Force a fresh module graph per test: without this, src/cli.ts's dynamic
  // `await import('./actual/session.js')` returns the cached module (and never re-invokes the
  // mock factory above) after the first test that reaches it, making sessionLoads assertions
  // depend on test order. ActualError/PlaidRequestError are re-imported here too (rather than
  // statically at the top of the file) so `instanceof` checks inside the freshly-loaded cli.js
  // see the same class identity as the errors these tests construct.
  vi.resetModules();
  ({ main } = await import('../src/cli.js'));
  ({ ActualError } = await import('../src/actual/errors.js'));
  ({ PlaidRequestError } = await import('../src/plaid/client.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('main', () => {
  it('does not load the Actual session module for --help, link --help, or config errors', async () => {
    await main(['--help'], {});
    await main(['link', '--help'], {});
    await main(['sync'], {});
    expect(mocks.sessionLoads).toBe(0);
  });

  it('exits 2 and lists missing variables when sync has no config', async () => {
    await expect(main(['sync'], {})).resolves.toBe(2);
    const err = stderr.join('');
    expect(err).toContain('Configuration error:');
    expect(err).toContain('PLAID_CLIENT_ID');
    expect(mocks.withBudget).not.toHaveBeenCalled();
  });

  it('exits 2 and names the accounts file when it cannot be read', async () => {
    const missing = join(accountsDir, 'missing.yaml');
    await expect(main(['sync'], { ...SYNC_ENV, ACCOUNTS_FILE: missing })).resolves.toBe(2);
    expect(stderr.join('')).toContain(`  - ${missing}: cannot read file (ENOENT)\n`);
    expect(mocks.withBudget).not.toHaveBeenCalled();
  });

  it('exits 0 for --help and lists the commands', async () => {
    await expect(main(['--help'], {})).resolves.toBe(0);
    const out = stdout.join('');
    expect(out).toContain('actual-plaid-sync');
    expect(out).toContain('sync');
    expect(out).toContain('accounts');
    expect(out).toContain('link');
  });

  it('exits 0 for --version', async () => {
    await expect(main(['--version'], {})).resolves.toBe(0);
    expect(stdout.join('')).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 2 for an unknown command', async () => {
    await expect(main(['bogus'], {})).resolves.toBe(2);
    expect(stderr.join('')).toContain("unknown command 'bogus'");
  });

  it('shows link options in link --help', async () => {
    await expect(main(['link', '--help'], {})).resolves.toBe(0);
    const out = stdout.join('');
    expect(out).toContain('--update');
    expect(out).toContain('--access-token <token>');
  });

  it('exits 2 for link --update without an access token', async () => {
    const env = { PLAID_CLIENT_ID: 'client-id', PLAID_SECRET: 'secret', PLAID_ENV: 'sandbox' };
    await expect(main(['link', '--update'], env)).resolves.toBe(2);
    expect(stderr.join('')).toContain('LINK_ACCESS_TOKEN');
  });

  // Fix round 1 (Critical finding): resolveLinkConfig resolves an update-mode access token, but
  // it was being dropped before the startLinkServer call, so link --update always threw
  // "accessToken is required in update mode" even with a valid token. These three tests pin that
  // the resolved token actually reaches startLinkServer for all three ways it can be supplied.
  it('runs link --update through to success with a token from --access-token', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.startLinkServer.mockResolvedValue({
      url: 'http://localhost:18585',
      result: Promise.resolve({
        accessToken: 'access-sandbox-abcd',
        itemId: null,
        accounts: [],
      }),
      close,
    });
    const env = { PLAID_CLIENT_ID: 'client-id', PLAID_SECRET: 'secret', PLAID_ENV: 'sandbox' };

    await expect(
      main(['link', '--update', '--access-token', 'access-sandbox-abcd'], env),
    ).resolves.toBe(0);

    expect(mocks.startLinkServer).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'update', accessToken: 'access-sandbox-abcd' }),
    );
    expect(close).toHaveBeenCalledTimes(1);
    // Never assert on the raw token beyond what formatLinkResult legitimately prints.
    expect(stdout.join('')).not.toContain('access-sandbox-abcd');
  });

  it('runs link --update through to success with a token from LINK_ACCESS_TOKEN', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.startLinkServer.mockResolvedValue({
      url: 'http://localhost:18585',
      result: Promise.resolve({
        accessToken: 'access-sandbox-efgh',
        itemId: null,
        accounts: [],
      }),
      close,
    });
    const env = {
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'sandbox',
      LINK_ACCESS_TOKEN: 'access-sandbox-efgh',
    };

    await expect(main(['link', '--update'], env)).resolves.toBe(0);

    expect(mocks.startLinkServer).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'update', accessToken: 'access-sandbox-efgh' }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('automatically uses the only token in PLAID_ACCESS_TOKENS for link --update', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.startLinkServer.mockResolvedValue({
      url: 'http://localhost:18585',
      result: Promise.resolve({
        accessToken: 'access-sandbox-only',
        itemId: null,
        accounts: [],
      }),
      close,
    });
    const env = {
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'sandbox',
      PLAID_ACCESS_TOKENS: 'access-sandbox-only',
    };

    await expect(main(['link', '--update'], env)).resolves.toBe(0);

    expect(mocks.startLinkServer).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'update', accessToken: 'access-sandbox-only' }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit token when multiple tokens are used without a terminal', async () => {
    const env = {
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'sandbox',
      PLAID_ACCESS_TOKENS: 'access-sandbox-one,access-sandbox-two',
    };

    await expect(main(['link', '--update'], env)).resolves.toBe(2);

    expect(stderr.join('')).toContain('multiple tokens');
    expect(mocks.startLinkServer).not.toHaveBeenCalled();
  });

  it('prefers --access-token over LINK_ACCESS_TOKEN when both are given', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.startLinkServer.mockResolvedValue({
      url: 'http://localhost:18585',
      result: Promise.resolve({
        accessToken: 'access-sandbox-flag',
        itemId: null,
        accounts: [],
      }),
      close,
    });
    const env = {
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'sandbox',
      LINK_ACCESS_TOKEN: 'access-sandbox-env',
    };

    await expect(
      main(['link', '--update', '--access-token', 'access-sandbox-flag'], env),
    ).resolves.toBe(0);

    expect(mocks.startLinkServer).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'update', accessToken: 'access-sandbox-flag' }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Controller decision 5: pins that a successful link closes the server (not just the SIGINT
  // path, which is covered by the brief's Step 8 manual smoke test).
  it('prints the link result and closes the server after a successful link', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.startLinkServer.mockResolvedValue({
      url: 'http://localhost:18585',
      result: Promise.resolve({
        accessToken: 'access-sandbox-abc123',
        itemId: 'item-1',
        accounts: [],
      }),
      close,
    });
    const env = { PLAID_CLIENT_ID: 'client-id', PLAID_SECRET: 'secret', PLAID_ENV: 'sandbox' };

    await expect(main(['link'], env)).resolves.toBe(0);

    expect(close).toHaveBeenCalledTimes(1);
    expect(stdout.join('')).toContain('Bank linked.');
  });

  it('runs sync inside withBudget and returns its exit code', async () => {
    const gateway = { name: 'fake-gateway' };
    mocks.withBudget.mockImplementation(
      async (_cfg: unknown, _log: unknown, fn: (gw: unknown) => Promise<number>) => fn(gateway),
    );
    mocks.runSync.mockResolvedValue(1);

    await expect(main(['sync'], SYNC_ENV)).resolves.toBe(1);

    expect(mocks.sessionLoads).toBe(1);
    expect(mocks.withBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'http://actual.example.test',
        syncId: SYNC_ENV.ACTUAL_SYNC_ID,
      }),
      expect.anything(),
      expect.any(Function),
    );
    const [cfg, deps] = mocks.runSync.mock.calls[0] as [
      { accessTokens: string[]; accounts: unknown[] },
      Record<string, unknown>,
    ];
    expect(cfg.accessTokens).toEqual(['access-sandbox-1']);
    expect(cfg.accounts).toEqual([{ plaid: { mask: '1234' }, actual: 'Checking' }]);
    expect(deps.gateway).toBe(gateway);
    expect(deps.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof deps.fetchTransactions).toBe('function');
    expect(typeof deps.refreshTransactions).toBe('function');
    await (deps.refreshTransactions as (token: string) => Promise<void>)('access-test');
    expect(mocks.plaidRefreshTransactions).toHaveBeenCalledWith(expect.anything(), 'access-test');
  });

  it('exits 1 and logs the hint when Actual fails', async () => {
    mocks.withBudget.mockRejectedValue(
      new ActualError('Actual rejected the password', 'invalid-password', 'check ACTUAL_PASSWORD'),
    );

    await expect(main(['sync'], SYNC_ENV)).resolves.toBe(1);

    const out = stdout.join('');
    expect(out).toContain('ERROR Actual rejected the password');
    expect(out).toContain('check ACTUAL_PASSWORD');
  });

  it('exits 1 and logs the Plaid code and request id when Plaid fails', async () => {
    mocks.withBudget.mockRejectedValue(
      new PlaidRequestError('invalid credentials', 'fatal', 'INVALID_API_KEYS', 'req-123'),
    );

    await expect(main(['sync'], SYNC_ENV)).resolves.toBe(1);

    const out = stdout.join('');
    expect(out).toContain('ERROR Plaid error INVALID_API_KEYS: invalid credentials');
    expect(out).toContain('request id req-123');
  });

  // Also covers controller decision 4 (any exception escaping withBudget/runSync maps to exit 1
  // for a plain Error, not just ActualError/PlaidRequestError): withBudget itself rejects here
  // with a plain Error, not runSync.
  it('exits 1 and logs unexpected errors', async () => {
    mocks.withBudget.mockRejectedValue(new Error('disk full'));
    await expect(main(['sync'], SYNC_ENV)).resolves.toBe(1);
    expect(stdout.join('')).toContain('ERROR disk full');
  });
});
