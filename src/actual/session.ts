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
  if (err instanceof Error) return err.message;
  // The SDK's APIError() factory produces a plain {type, message} object, not an Error
  // instance (see index.js ~14068), so any non-null object with a string `message` must be
  // read the same way -- otherwise String(err) yields the useless "[object Object]".
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

// The SDK reports "no budget file is open" (checkFileOpen(), index.js ~112062) as a plain
// APIError with no `code` at all -- this happens after downloadBudget silently ignores a
// loadBudget failure caused by a migrations mismatch, so it must map to the same
// out-of-sync-migrations code as an explicitly coded error.
const NO_BUDGET_OPEN_RE = /no budget file is open/i;

function detectCode(err: unknown): string | null {
  const rawCode =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof rawCode === 'string') return rawCode;
  return NO_BUDGET_OPEN_RE.test(errorMessage(err)) ? 'out-of-sync-migrations' : null;
}

export function toActualError(err: unknown, serverVersion: string | null = null): ActualError {
  if (err instanceof ActualError) return err;
  const message = errorMessage(err);
  const code = detectCode(err);
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
  const code = detectCode(err);
  if (code !== 'out-of-sync-migrations' && code !== 'out-of-sync-data') return null;
  try {
    const result = await actual.getServerVersion();
    return 'version' in result ? result.version : null;
  } catch {
    return null;
  }
}

// M1: ACTUAL_SERVER_URL may embed HTTP basic-auth credentials (user:pass@host); those must
// never reach a log line.
function redactedServerUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '<unparseable ACTUAL_SERVER_URL>';
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

// Runs shutdown(), logging (never throwing) on failure. Used whenever an earlier step has
// already failed and that original error must be the one that propagates.
async function shutdownQuietly(log: Logger): Promise<void> {
  try {
    await actual.shutdown();
  } catch (shutdownErr) {
    log.error(`Actual shutdown failed after error: ${errorMessage(shutdownErr)}`);
  }
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
        log.debug(`Connecting to Actual server ${redactedServerUrl(cfg.serverUrl)}`);
        await actual.init({
          dataDir,
          serverURL: cfg.serverUrl,
          password: cfg.password,
          verbose: false,
        });
        log.debug('Downloading budget');
        await actual.downloadBudget(cfg.syncId, { password: cfg.encryptionPassword });
        // F-I2(b): downloadBudget ignores a loadBudget failure caused by a migrations
        // mismatch (it returns {error: 'out-of-sync-migrations'} instead of throwing), so a
        // mismatch can silently leave no budget open here. One cheap read surfaces that now
        // instead of failing confusingly later, deeper in fn.
        await actual.getAccounts();
      } catch (err) {
        throw toActualError(err, await serverVersionFor(err));
      }
      result = await fn(createGateway());
    } catch (err) {
      // Something before or during fn already failed. shutdown() is still
      // attempted so the sync process ends cleanly, but its failure must not
      // hide the original error -- only the original error is rethrown.
      await shutdownQuietly(log);
      throw err;
    }

    // F-I1: fn succeeded, so push local changes to the server. shutdown() alone can't be
    // trusted to surface a failed push -- the SDK's shutdown() swallows sync errors internally
    // (`try { await internal.send("sync"); } catch {}`) -- so sync() is called explicitly here,
    // before shutdown(), and its failure is reported rather than swallowed.
    try {
      await actual.sync();
    } catch (syncErr) {
      await shutdownQuietly(log);
      throw toActualError(syncErr);
    }

    // shutdown() still runs the close-budget step, which can itself fail; that must also be
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
