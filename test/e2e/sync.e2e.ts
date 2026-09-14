import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
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

    syncEnv = {
      PLAID_CLIENT_ID: clientId,
      PLAID_SECRET: secret,
      PLAID_ENV: 'sandbox',
      PLAID_ACCESS_TOKENS: accessToken,
      ACCOUNT_MAP: `${sandbox.plaidAccountId}:${accountId}`,
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
