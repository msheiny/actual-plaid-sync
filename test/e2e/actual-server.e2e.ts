import * as actual from '@actual-app/api';
import { describe, expect, it } from 'vitest';
import {
  bootstrapServer,
  createBudget,
  readTransactions,
  withApi,
} from './helpers/actual-server.js';

const serverUrl = process.env.ACTUAL_E2E_SERVER_URL ?? 'http://localhost:5006';
const password = process.env.ACTUAL_E2E_PASSWORD ?? 'e2e-password';

describe('actual-server e2e helpers', () => {
  it('bootstraps the server, creates a budget, and reads back imported transactions', async () => {
    await bootstrapServer(serverUrl, password);
    await bootstrapServer(serverUrl, password); // second call is a no-op

    const { syncId, accountId } = await createBudget(
      serverUrl,
      password,
      `e2e-helpers-${Date.now()}`,
    );
    expect(await readTransactions(serverUrl, password, syncId, accountId)).toEqual([]);

    await withApi(serverUrl, password, async () => {
      await actual.downloadBudget(syncId);
      await actual.importTransactions(
        accountId,
        [
          {
            account: accountId,
            date: '2026-01-15',
            amount: -500,
            payee_name: 'Probe',
            imported_payee: 'PROBE',
            imported_id: 'probe-1',
            cleared: false,
          },
        ],
        { reimportDeleted: false },
      );
    });

    const rows = await readTransactions(serverUrl, password, syncId, accountId);
    expect(rows.map((r) => [r.importedId, r.amount, r.cleared])).toEqual([
      ['probe-1', -500, false],
    ]);
  });
});
