import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as actual from '@actual-app/api';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a fresh actual-server to answer /health, then set its password (idempotent). */
export async function bootstrapServer(
  serverUrl: string,
  password: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${serverUrl}/health`);
      if (res.ok) break;
    } catch {
      // server not listening yet
    }
    if (Date.now() > deadline)
      throw new Error(`actual-server at ${serverUrl} not healthy after ${timeoutMs}ms`);
    await sleep(1000);
  }

  const needs = (await (await fetch(`${serverUrl}/account/needs-bootstrap`)).json()) as {
    data: { bootstrapped: boolean };
  };
  if (needs.data.bootstrapped) return;

  const res = await fetch(`${serverUrl}/account/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const body = (await res.json()) as { status: string; reason?: string };
  if (body.status !== 'ok') throw new Error(`bootstrap failed: ${body.reason ?? res.status}`);
}

async function withApi<T>(serverUrl: string, password: string, fn: () => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'actual-plaid-sync-e2e-'));
  await actual.init({ dataDir, serverURL: serverUrl, password, verbose: false });
  try {
    return await fn();
  } finally {
    await actual.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export interface CreatedBudget {
  syncId: string;
  accountId: string;
}

/**
 * Creates a new budget on the server with one on-budget account.
 * `runImport` = create-budget locally + your callback + upload to the server (loot-core api/finish-import).
 */
export async function createBudget(
  serverUrl: string,
  password: string,
  budgetName: string,
): Promise<CreatedBudget> {
  return withApi(serverUrl, password, async () => {
    let accountId = '';
    await actual.runImport(budgetName, async () => {
      accountId = await actual.createAccount(
        { name: 'E2E Checking', offbudget: false, closed: false },
        0,
      );
    });
    const budgets = await actual.getBudgets();
    const syncId = budgets.find((b) => b.name === budgetName && b.groupId)?.groupId;
    if (!syncId || !accountId)
      throw new Error(`budget ${budgetName} was not uploaded: ${JSON.stringify(budgets)}`);
    return { syncId, accountId };
  });
}

export interface StoredTxn {
  id: string;
  importedId: string | null;
  amount: number;
  cleared: boolean;
}

/** Downloads the budget into a fresh data dir (like the CLI does) and returns all transactions of one account. */
export async function readTransactions(
  serverUrl: string,
  password: string,
  syncId: string,
  accountId: string,
): Promise<StoredTxn[]> {
  return withApi(serverUrl, password, async () => {
    await actual.downloadBudget(syncId);
    const rows = await actual.getTransactions(accountId, '2000-01-01', '2100-01-01');
    return rows.map((t) => ({
      id: t.id,
      importedId: t.imported_id ?? null,
      amount: t.amount,
      cleared: Boolean(t.cleared),
    }));
  });
}
