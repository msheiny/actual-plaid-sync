import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as actual from '@actual-app/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActualError, toActualError, withBudget } from '../../src/actual/session.js';
import type { ActualConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';

vi.mock('@actual-app/api', () => ({
  init: vi.fn(),
  downloadBudget: vi.fn(),
  sync: vi.fn(),
  shutdown: vi.fn(),
  getAccounts: vi.fn(),
  getTransactions: vi.fn(),
  importTransactions: vi.fn(),
  updateTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
  getServerVersion: vi.fn(),
}));

const api = vi.mocked(actual);

const cfg: ActualConfig = {
  serverUrl: 'http://actual.local:5006',
  password: 'server-pass',
  syncId: 'sync-123',
  encryptionPassword: 'enc-pass',
};

const logLines: string[] = [];
const log = createLogger('error', (line) => logLines.push(line));

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function initDataDir(): string {
  const arg = api.init.mock.calls[0]?.[0] as { dataDir: string };
  return arg.dataDir;
}

describe('withBudget', () => {
  let calls: string[];

  beforeEach(() => {
    vi.resetAllMocks();
    logLines.length = 0;
    calls = [];
    api.init.mockImplementation(async () => {
      calls.push('init');
      return {} as Awaited<ReturnType<typeof actual.init>>;
    });
    api.downloadBudget.mockImplementation(async () => {
      calls.push('downloadBudget');
    });
    api.sync.mockImplementation(async () => {
      calls.push('sync');
    });
    api.shutdown.mockImplementation(async () => {
      calls.push('shutdown');
    });
  });

  it('inits, downloads, runs fn, syncs, shuts down, and removes the temp dir', async () => {
    let dirDuringFn = '';
    const result = await withBudget(cfg, log, async () => {
      calls.push('fn');
      dirDuringFn = initDataDir();
      expect(existsSync(dirDuringFn)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    // F-I1: sync() (the SDK call that actually pushes to the server) must run
    // after fn succeeds and before shutdown(), since shutdown() swallows sync errors.
    expect(calls).toEqual(['init', 'downloadBudget', 'fn', 'sync', 'shutdown']);
    expect(api.init).toHaveBeenCalledWith({
      dataDir: dirDuringFn,
      serverURL: 'http://actual.local:5006',
      password: 'server-pass',
      verbose: false,
    });
    expect(dirDuringFn.startsWith(`${tmpdir()}/actual-plaid-sync-`)).toBe(true);
    expect(api.downloadBudget).toHaveBeenCalledWith('sync-123', { password: 'enc-pass' });
    expect(existsSync(dirDuringFn)).toBe(false);
  });

  it('shuts down and removes the temp dir when fn throws, rethrowing the original error, without calling sync', async () => {
    const boom = new Error('boom');
    await expect(
      withBudget(cfg, log, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    // F-I1: sync() is only attempted after fn succeeds, so a fn failure must
    // never call it (an exact array match proves 'sync' is absent).
    expect(calls).toEqual(['init', 'downloadBudget', 'shutdown']);
    expect(existsSync(initDataDir())).toBe(false);
  });

  // F-I1: shutdown() swallows sync errors internally, so a failed push must be
  // detected by calling sync() explicitly on the success path.
  it('rejects with an ActualError when sync() fails after fn succeeds, still shuts down, and removes the temp dir', async () => {
    api.sync.mockReset();
    api.sync.mockImplementation(async () => {
      calls.push('sync');
      throw codedError('Could not push changes', 'network-failure');
    });

    const error = await withBudget(cfg, log, async () => 'ok').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ActualError);
    expect(error).toMatchObject({ hint: 'check ACTUAL_SERVER_URL is reachable' });
    expect(calls).toEqual(['init', 'downloadBudget', 'sync', 'shutdown']);
    expect(existsSync(initDataDir())).toBe(false);
  });

  it('wraps init failures in ActualError with a hint and still cleans up', async () => {
    api.init.mockRejectedValueOnce(
      codedError('Authentication failed: invalid-password', 'invalid-password'),
    );
    const fn = vi.fn();
    const error = await withBudget(cfg, log, fn).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ActualError);
    expect(error).toMatchObject({ code: 'invalid-password', hint: 'check ACTUAL_PASSWORD' });
    expect(fn).not.toHaveBeenCalled();
    expect(api.shutdown).toHaveBeenCalledTimes(1);
    expect(existsSync(initDataDir())).toBe(false);
  });

  it('includes bundled and server versions in the out-of-sync-migrations hint', async () => {
    api.downloadBudget.mockRejectedValueOnce(
      codedError(
        'This budget cannot be loaded with this version of the app.',
        'out-of-sync-migrations',
      ),
    );
    api.getServerVersion.mockResolvedValueOnce({ version: '26.10.0' });
    const error = (await withBudget(cfg, log, vi.fn()).catch((e: unknown) => e)) as ActualError;

    expect(error).toBeInstanceOf(ActualError);
    expect(error.code).toBe('out-of-sync-migrations');
    expect(error.hint).toMatch(
      /^@actual-app\/api \d+\.\d+\.\d+ does not match your server \(server 26\.10\.0\); use the image matching your server version$/,
    );
  });

  // F-I2(b): loadBudget can return {error: 'out-of-sync-migrations'} instead of throwing, and
  // downloadBudget ignores that. The mismatch only surfaces later as a plain APIError-shaped
  // object ({type, message}, not an Error instance) from a gateway call like checkFileOpen.
  // A cheap read right after downloadBudget succeeds must catch this and map it to the same
  // out-of-sync-migrations code and hint used elsewhere.
  it('maps a failed post-download verification read to out-of-sync-migrations', async () => {
    api.getAccounts.mockRejectedValueOnce({ type: 'APIError', message: 'No budget file is open' });
    const fn = vi.fn();
    const error = (await withBudget(cfg, log, fn).catch((e: unknown) => e)) as ActualError;

    expect(error).toBeInstanceOf(ActualError);
    expect(error.code).toBe('out-of-sync-migrations');
    expect(error.hint).toMatch(/^@actual-app\/api \d+\.\d+\.\d+ does not match your server/);
    expect(fn).not.toHaveBeenCalled();
    expect(api.shutdown).toHaveBeenCalledTimes(1);
    expect(existsSync(initDataDir())).toBe(false);
  });

  // M1: the debug connecting log must never leak userinfo embedded in ACTUAL_SERVER_URL.
  it('never logs the server URL userinfo', async () => {
    const secretCfg: ActualConfig = { ...cfg, serverUrl: 'https://u:secret@actual.example' };
    const debugLines: string[] = [];
    const debugLog = createLogger('debug', (line) => debugLines.push(line));

    await withBudget(secretCfg, debugLog, async () => 'ok');

    expect(debugLines.some((l) => l.includes('actual.example'))).toBe(true);
    expect(debugLines.join('\n')).not.toContain('secret');
  });

  it('exposes a gateway that maps Actual rows and results', async () => {
    api.getAccounts.mockResolvedValueOnce([]); // verification read (F-I2)
    api.getAccounts.mockResolvedValueOnce([
      { id: 'a1', name: 'Checking', closed: false, offbudget: false },
      { id: 'a2', name: 'Old Card', closed: true, offbudget: true },
    ]);
    api.getTransactions.mockResolvedValueOnce([
      {
        id: 't1',
        account: 'a1',
        date: '2026-09-01',
        amount: -1234,
        imported_id: 'plaid-1',
        cleared: true,
        reconciled: false,
        is_parent: false,
      },
      { id: 't2', account: 'a1', date: '2026-09-02', amount: 500 },
    ]);
    api.importTransactions.mockResolvedValueOnce({
      added: ['n1'],
      updated: [],
      updatedPreview: [],
      errors: [{ message: 'bad txn' }],
    });
    api.updateTransaction.mockResolvedValueOnce([]);
    api.deleteTransaction.mockResolvedValueOnce([]);

    await withBudget(cfg, log, async (gw) => {
      expect(await gw.getAccounts()).toEqual([
        { id: 'a1', name: 'Checking', closed: false, offbudget: false },
        { id: 'a2', name: 'Old Card', closed: true, offbudget: true },
      ]);
      // Pins the date-format contract: Actual's TransactionEntity.date is already
      // YYYY-MM-DD, and the gateway must pass it through unchanged (no numeric
      // or Date-object conversion), since sync/plan.ts compares dates as strings.
      expect(await gw.getTransactions('a1', '2026-07-15', '2026-09-13')).toEqual([
        {
          id: 't1',
          account: 'a1',
          date: '2026-09-01',
          amount: -1234,
          importedId: 'plaid-1',
          cleared: true,
          reconciled: false,
          isParent: false,
        },
        {
          id: 't2',
          account: 'a1',
          date: '2026-09-02',
          amount: 500,
          importedId: null,
          cleared: false,
          reconciled: false,
          isParent: false,
        },
      ]);
      const txn = {
        date: '2026-09-03',
        amount: -100,
        payee_name: 'Shop',
        imported_payee: 'SHOP',
        imported_id: 'plaid-2',
        cleared: true,
      };
      expect(await gw.importTransactions('a1', [txn])).toEqual({
        added: ['n1'],
        updated: [],
        errors: ['bad txn'],
      });
      await gw.updateTransaction('t1', { amount: -1300 });
      await gw.deleteTransaction('t2');
    });

    expect(api.getTransactions).toHaveBeenCalledWith('a1', '2026-07-15', '2026-09-13');
    expect(api.importTransactions).toHaveBeenCalledWith(
      'a1',
      [
        {
          account: 'a1',
          date: '2026-09-03',
          amount: -100,
          payee_name: 'Shop',
          imported_payee: 'SHOP',
          imported_id: 'plaid-2',
          cleared: true,
        },
      ],
      { reimportDeleted: false },
    );
    expect(api.updateTransaction).toHaveBeenCalledWith('t1', { amount: -1300 });
    expect(api.deleteTransaction).toHaveBeenCalledWith('t2');
  });

  it('wraps gateway failures in ActualError', async () => {
    api.getAccounts.mockResolvedValueOnce([]); // verification read (F-I2)
    api.getAccounts.mockRejectedValueOnce(
      codedError('Could not get remote files', 'network-failure'),
    );
    const error = await withBudget(cfg, log, (gw) => gw.getAccounts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActualError);
    expect(error).toMatchObject({ hint: 'check ACTUAL_SERVER_URL is reachable' });
  });

  // Controller decision 1: shutdown() pushes the budget to the server, so a
  // shutdown failure must never be swallowed as a mere warning.
  it('rethrows a shutdown failure as ActualError when fn succeeded, and still removes the temp dir', async () => {
    api.shutdown.mockReset();
    api.shutdown.mockImplementation(async () => {
      calls.push('shutdown');
      throw codedError('Could not push changes', 'network-failure');
    });

    const error = await withBudget(cfg, log, async () => 'ok').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ActualError);
    expect(error).toMatchObject({ hint: 'check ACTUAL_SERVER_URL is reachable' });
    expect(calls).toEqual(['init', 'downloadBudget', 'sync', 'shutdown']);
    expect(existsSync(initDataDir())).toBe(false);
  });

  it('propagates the original error (not the shutdown error) when both fn and shutdown fail, logging the shutdown failure', async () => {
    const boom = new Error('boom');
    api.shutdown.mockReset();
    api.shutdown.mockImplementation(async () => {
      calls.push('shutdown');
      throw new Error('shutdown exploded');
    });

    await expect(
      withBudget(cfg, log, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(calls).toEqual(['init', 'downloadBudget', 'shutdown']);
    expect(existsSync(initDataDir())).toBe(false);
    expect(
      logLines.some((line) => line.includes('ERROR') && line.includes('shutdown exploded')),
    ).toBe(true);
    // No secrets (password, encryptionPassword) end up in the log line.
    expect(logLines.join('\n')).not.toContain('server-pass');
    expect(logLines.join('\n')).not.toContain('enc-pass');
  });
});

describe('toActualError', () => {
  it.each([
    ['invalid-password', 'check ACTUAL_PASSWORD'],
    ['network-failure', 'check ACTUAL_SERVER_URL is reachable'],
    ['budget-not-found', 'check ACTUAL_SYNC_ID'],
    ['missing-key', 'check ACTUAL_ENCRYPTION_PASSWORD'],
    ['decrypt-failure', 'check ACTUAL_ENCRYPTION_PASSWORD'],
  ])('maps code %s to hint "%s"', (code, hint) => {
    const error = toActualError(codedError('failed', code));
    expect(error.code).toBe(code);
    expect(error.hint).toBe(hint);
    expect(error.message).toBe('failed');
  });

  it('falls back to the error message as the hint', () => {
    const error = toActualError(new Error('something odd'));
    expect(error.code).toBeNull();
    expect(error.hint).toBe('something odd');
  });

  it('omits the server version when unknown', () => {
    expect(toActualError(codedError('x', 'out-of-sync-migrations')).hint).toMatch(
      /does not match your server; use the image matching your server version$/,
    );
  });

  // F-I2(a): APIError from the SDK is a plain {type, message} object, not an Error instance
  // (see index.js's APIError() factory). errorMessage/toActualError must read .message from it
  // instead of falling through to String(err), which would produce "[object Object]".
  it('reads .message from a plain (non-Error) object and never produces [object Object]', () => {
    const error = toActualError({ type: 'APIError', message: 'No budget file is open' });
    expect(error.message).toBe('No budget file is open');
    expect(error.message).not.toContain('[object Object]');
    expect(error.hint).not.toContain('[object Object]');
  });

  // F-I2: the SDK reports a mismatched-migrations budget as a plain "No budget file is open"
  // APIError with no `code` at all; that must still map to the out-of-sync-migrations hint.
  it('maps a "no budget file is open" message with no code to out-of-sync-migrations', () => {
    const error = toActualError({ type: 'APIError', message: 'No budget file is open' });
    expect(error.code).toBe('out-of-sync-migrations');
    expect(error.hint).toMatch(/^@actual-app\/api \d+\.\d+\.\d+ does not match your server/);
  });
});
