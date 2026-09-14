import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as actual from '@actual-app/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withApi } from './actual-server.js';

vi.mock('@actual-app/api', () => ({
  init: vi.fn(),
  shutdown: vi.fn(),
  runImport: vi.fn(),
  createAccount: vi.fn(),
  getBudgets: vi.fn(),
  downloadBudget: vi.fn(),
  getTransactions: vi.fn(),
  importTransactions: vi.fn(),
}));

const TEMP_PREFIX = 'actual-plaid-sync-e2e-';

async function leakedTempDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((e) => e.startsWith(TEMP_PREFIX));
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('withApi', () => {
  it('inits, runs fn, shuts down, and removes the temp dir on success', async () => {
    vi.mocked(actual.init).mockResolvedValue(undefined as never);
    vi.mocked(actual.shutdown).mockResolvedValue(undefined);

    const before = await leakedTempDirs();
    const result = await withApi('http://localhost:5006', 'pw', async () => 'ok');
    const after = await leakedTempDirs();

    expect(result).toBe('ok');
    expect(actual.shutdown).toHaveBeenCalledTimes(1);
    expect(after).toEqual(before);
  });

  it('removes the temp dir and does not mask the original error when init fails', async () => {
    const initError = new Error('boom: init failed');
    vi.mocked(actual.init).mockRejectedValueOnce(initError);
    // A shutdown attempted after a failed init may itself fail; it must not hide initError
    // and must not stop the temp dir from being removed.
    vi.mocked(actual.shutdown).mockRejectedValueOnce(new Error('shutdown also fails'));

    const before = await leakedTempDirs();
    await expect(withApi('http://localhost:5006', 'pw', async () => 'unused')).rejects.toBe(
      initError,
    );
    const after = await leakedTempDirs();

    expect(after).toEqual(before);
  });

  it('removes the temp dir and propagates the error when fn fails after a successful init', async () => {
    vi.mocked(actual.init).mockResolvedValue(undefined as never);
    vi.mocked(actual.shutdown).mockResolvedValue(undefined);
    const fnError = new Error('fn failed');

    const before = await leakedTempDirs();
    await expect(
      withApi('http://localhost:5006', 'pw', async () => {
        throw fnError;
      }),
    ).rejects.toBe(fnError);
    const after = await leakedTempDirs();

    expect(actual.shutdown).toHaveBeenCalledTimes(1);
    expect(after).toEqual(before);
  });

  it('removes the temp dir and rejects with the shutdown error when init and fn both succeed but shutdown fails', async () => {
    vi.mocked(actual.init).mockResolvedValue(undefined as never);
    const shutdownError = new Error('shutdown failed');
    vi.mocked(actual.shutdown).mockRejectedValueOnce(shutdownError);

    const before = await leakedTempDirs();
    await expect(withApi('http://localhost:5006', 'pw', async () => 'ok')).rejects.toBe(
      shutdownError,
    );
    const after = await leakedTempDirs();

    expect(after).toEqual(before);
  });
});
