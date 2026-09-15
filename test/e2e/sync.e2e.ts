import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlaidClient } from '../../src/plaid/client.js';
import { addDays, todayUtc } from '../../src/sync/window.js';
import { bootstrapServer, createBudget, readTransactions } from './helpers/actual-server.js';
import {
  createSandboxAccessToken,
  waitForDepositoryTransactions,
} from './helpers/plaid-sandbox.js';

const clientId = process.env.PLAID_SANDBOX_CLIENT_ID ?? '';
const secret = process.env.PLAID_SANDBOX_SECRET ?? '';
const serverUrl = process.env.ACTUAL_E2E_SERVER_URL ?? 'http://localhost:5006';
const password = process.env.ACTUAL_E2E_PASSWORD ?? 'e2e-password';
const SYNC_DAYS = 30;
const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

function runCli(env: Record<string, string>): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [CLI, 'sync'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 240_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function duplicates(values: string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) !== i);
}

describe.skipIf(!clientId || !secret)('sync end-to-end (Plaid Sandbox -> actual-server)', () => {
  let syncEnv: Record<string, string>;
  let syncId: string;
  let accountId: string;
  let plaidTxnIds: string[];
  let configDir: string | undefined;

  afterAll(() => {
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  beforeAll(async () => {
    expect(existsSync(CLI), `${CLI} missing: run \`mise run build\` first`).toBe(true);

    await bootstrapServer(serverUrl, password);
    ({ syncId, accountId } = await createBudget(serverUrl, password, `e2e-${Date.now()}`));

    const plaid = createPlaidClient({ clientId, secret, env: 'sandbox' });
    const accessToken = await createSandboxAccessToken(plaid);
    const today = todayUtc();
    const sandbox = await waitForDepositoryTransactions(
      plaid,
      accessToken,
      addDays(today, -SYNC_DAYS),
      today,
    );
    plaidTxnIds = sandbox.transactionIds;

    // spawnSync runs the CLI without a cwd, so the accounts file is passed by absolute path. The
    // helper only reports the Plaid account id, so the entry pins it; createBudget names the
    // Actual account "E2E Checking".
    configDir = mkdtempSync(join(tmpdir(), 'actual-plaid-sync-e2e-'));
    const accountsFile = join(configDir, 'accounts.yaml');
    writeFileSync(
      accountsFile,
      `accounts:\n  - plaid: ${sandbox.plaidAccountId}\n    actual: E2E Checking\n`,
    );

    syncEnv = {
      PLAID_CLIENT_ID: clientId,
      PLAID_SECRET: secret,
      PLAID_ENV: 'sandbox',
      PLAID_ACCESS_TOKENS: accessToken,
      ACCOUNTS_FILE: accountsFile,
      ACTUAL_SERVER_URL: serverUrl,
      ACTUAL_PASSWORD: password,
      ACTUAL_SYNC_ID: syncId,
      SYNC_DAYS: String(SYNC_DAYS),
      DRY_RUN: 'false',
      LOG_LEVEL: 'debug',
    };
  });

  it('first sync imports every Plaid transaction of the mapped account', async () => {
    const run = runCli(syncEnv);
    expect(run.status, run.output).toBe(0);

    const rows = await readTransactions(serverUrl, password, syncId, accountId);
    const importedIds = rows.map((r) => r.importedId).filter((id): id is string => id !== null);
    expect(rows.length).toBeGreaterThan(0);
    expect(duplicates(importedIds)).toEqual([]);
    for (const id of plaidTxnIds) expect(importedIds).toContain(id);
  });

  it('second sync is a no-op (no duplicates, same rows)', async () => {
    const before = await readTransactions(serverUrl, password, syncId, accountId);

    const run = runCli(syncEnv);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/\b0 added\b/);

    const after = await readTransactions(serverUrl, password, syncId, accountId);
    const importedIds = after.map((r) => r.importedId).filter((id): id is string => id !== null);
    expect(after.length).toBe(before.length);
    expect(duplicates(importedIds)).toEqual([]);
    expect([...after].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...before].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
