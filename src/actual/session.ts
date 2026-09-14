import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as actual from '@actual-app/api';
import type { ActualConfig } from '../config.js';
import type { Logger } from '../log.js';
import type { ActualTxn, ImportTxn, UpdateFields } from '../sync/types.js';
import { ActualError } from './errors.js';

export { ActualError };

export interface ActualAccountInfo {
  id: string;
  name: string;
  closed: boolean;
  offbudget: boolean;
}
export interface ImportResult {
  added: string[];
  updated: string[];
  errors: string[];
}
export interface ActualGateway {
  getAccounts(): Promise<ActualAccountInfo[]>;
  getTransactions(accountId: string, start: string, end: string): Promise<ActualTxn[]>;
  importTransactions(accountId: string, txns: ImportTxn[]): Promise<ImportResult>;
  updateTransaction(id: string, fields: UpdateFields): Promise<void>;
  deleteTransaction(id: string): Promise<void>;
}

type ActualRow = Awaited<ReturnType<typeof actual.getTransactions>>[number];

// @actual-app/api does not export ./package.json, so resolve its entry point and walk up.
export function bundledApiVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = join(dirname(require.resolve('@actual-app/api')), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toActualError(err: unknown, serverVersion: string | null = null): ActualError {
  if (err instanceof ActualError) return err;
  const message = errorMessage(err);
  const rawCode =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  const code = typeof rawCode === 'string' ? rawCode : null;
  let hint: string;
  switch (code) {
    case 'invalid-password':
      hint = 'check ACTUAL_PASSWORD';
      break;
    case 'network-failure':
    case 'network':
      hint = 'check ACTUAL_SERVER_URL is reachable';
      break;
    case 'budget-not-found':
    case 'missing':
      hint = 'check ACTUAL_SYNC_ID';
      break;
    case 'decrypt-failure':
    case 'missing-key':
      hint = 'check ACTUAL_ENCRYPTION_PASSWORD';
      break;
    case 'out-of-sync-migrations':
    case 'out-of-sync-data': {
      const server = serverVersion ? ` (server ${serverVersion})` : '';
      hint = `@actual-app/api ${bundledApiVersion()} does not match your server${server}; use the image matching your server version`;
      break;
    }
    default:
      hint = message;
  }
  return new ActualError(message, code, hint, err);
}

async function serverVersionFor(err: unknown): Promise<string | null> {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code !== 'out-of-sync-migrations' && code !== 'out-of-sync-data') return null;
  try {
    const result = await actual.getServerVersion();
    return 'version' in result ? result.version : null;
  } catch {
    return null;
  }
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toActualError(err);
  }
}

function toActualTxn(row: ActualRow): ActualTxn {
  return {
    id: row.id,
    account: row.account,
    date: row.date,
    amount: row.amount,
    importedId: row.imported_id ?? null,
    cleared: Boolean(row.cleared),
    reconciled: Boolean(row.reconciled),
    isParent: Boolean(row.is_parent),
  };
}

function createGateway(): ActualGateway {
  return {
    getAccounts: () =>
      wrap(async () =>
        (await actual.getAccounts()).map((a) => ({
          id: a.id,
          name: a.name,
          closed: Boolean(a.closed),
          offbudget: Boolean(a.offbudget),
        })),
      ),
    getTransactions: (accountId, start, end) =>
      wrap(async () => (await actual.getTransactions(accountId, start, end)).map(toActualTxn)),
    importTransactions: (accountId, txns) =>
      wrap(async () => {
        const rows = txns.map((t) => ({ ...t, account: accountId }));
        const result = await actual.importTransactions(accountId, rows, {
          reimportDeleted: false,
        });
        return {
          added: result.added ?? [],
          updated: result.updated ?? [],
          errors: (result.errors ?? []).map((e) => e.message),
        };
      }),
    updateTransaction: (id, fields) =>
      wrap(async () => {
        await actual.updateTransaction(id, fields);
      }),
    deleteTransaction: (id) =>
      wrap(async () => {
        await actual.deleteTransaction(id);
      }),
  };
}

export async function withBudget<T>(
  cfg: ActualConfig,
  log: Logger,
  fn: (gw: ActualGateway) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'actual-plaid-sync-'));
  try {
    let result: T;
    try {
      try {
        log.debug(`Connecting to Actual server ${cfg.serverUrl}`);
        await actual.init({
          dataDir,
          serverURL: cfg.serverUrl,
          password: cfg.password,
          verbose: false,
        });
        log.debug('Downloading budget');
        await actual.downloadBudget(cfg.syncId, { password: cfg.encryptionPassword });
      } catch (err) {
        throw toActualError(err, await serverVersionFor(err));
      }
      result = await fn(createGateway());
    } catch (err) {
      // Something before or during fn already failed. shutdown() is still
      // attempted so the sync process ends cleanly, but its failure must not
      // hide the original error -- only the original error is rethrown.
      try {
        await actual.shutdown();
      } catch (shutdownErr) {
        log.error(`Actual shutdown failed after error: ${errorMessage(shutdownErr)}`);
      }
      throw err;
    }

    // fn succeeded: shutdown() is the step that pushes the budget back to the
    // server, so a failure here means nothing was actually saved and must be
    // reported as a failure, not swallowed as a warning.
    try {
      await actual.shutdown();
    } catch (shutdownErr) {
      throw toActualError(shutdownErr);
    }
    return result;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
