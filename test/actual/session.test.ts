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
    api.shutdown.mockImplementation(async () => {
      calls.push('shutdown');
    });
  });

  it('inits, downloads, runs fn, shuts down, and removes the temp dir', async () => {
    let dirDuringFn = '';
    const result = await withBudget(cfg, log, async () => {
      calls.push('fn');
      dirDuringFn = initDataDir();
      expect(existsSync(dirDuringFn)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(calls).toEqual(['init', 'downloadBudget', 'fn', 'shutdown']);
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

  it('shuts down and removes the temp dir when fn throws, rethrowing the original error', async () => {
    const boom = new Error('boom');
    await expect(
      withBudget(cfg, log, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls).toEqual(['init', 'downloadBudget', 'shutdown']);
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

  it('exposes a gateway that maps Actual rows and results', async () => {
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
    expect(calls).toEqual(['init', 'downloadBudget', 'shutdown']);
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
});
