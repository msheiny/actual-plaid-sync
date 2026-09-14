#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { ActualError } from './actual/errors.js';
import {
  ConfigError,
  type LinkConfig,
  loadAccountsConfig,
  loadLinkConfig,
  loadSyncConfig,
} from './config.js';
import { createLinkDeps } from './link/plaid-link.js';
import { formatLinkResult, startLinkServer } from './link/server.js';
import { createLogger, type LogLevel } from './log.js';
import { createPlaidClient, PlaidRequestError } from './plaid/client.js';
import { todayUtc } from './sync/window.js';

// src/cli.ts and dist/cli.js both sit one directory below package.json.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];

function print(line: string): void {
  console.log(line);
}

function fallbackLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const level = env.LOG_LEVEL ?? '';
  return LOG_LEVELS.includes(level) ? (level as LogLevel) : 'info';
}

interface LinkOptions {
  update?: boolean;
  accessToken?: string;
}

// The "LINK_ACCESS_TOKEN (or --access-token) is required for link --update" check itself lives in
// createLinkDeps (src/link/plaid-link.ts), which is called below before the server starts. This
// only merges the --access-token override (which takes priority over LINK_ACCESS_TOKEN) into the
// config so that check sees it; it never duplicates the check or its message.
function resolveLinkConfig(
  env: NodeJS.ProcessEnv,
  opts: LinkOptions,
): { cfg: LinkConfig; mode: 'create' | 'update' } {
  const mode = opts.update ? 'update' : 'create';
  const cfg = loadLinkConfig(env);
  const accessToken = opts.accessToken ?? cfg.accessToken;
  return { cfg: accessToken === undefined ? cfg : { ...cfg, accessToken }, mode };
}

async function runLink(env: NodeJS.ProcessEnv, opts: LinkOptions): Promise<number> {
  const { cfg, mode } = resolveLinkConfig(env, opts);
  const log = createLogger(cfg.logLevel);
  if (mode === 'create' && opts.accessToken) {
    log.warn('--access-token is ignored without --update');
  }
  const client = createPlaidClient(cfg.plaid);
  // Throws ConfigError in update mode without an access token; see resolveLinkConfig above.
  const deps = createLinkDeps(client, cfg, mode);
  const server = await startLinkServer({
    mode,
    host: cfg.host,
    port: cfg.port,
    deps,
    log,
    ...(mode === 'update' && cfg.accessToken ? { accessToken: cfg.accessToken } : {}),
  });

  let onSigint: () => void = () => undefined;
  const interrupted = new Promise<'interrupted'>((resolve) => {
    onSigint = () => resolve('interrupted');
  });
  process.once('SIGINT', onSigint);
  try {
    print('');
    print(
      `  Open ${server.url} in your browser to ${mode === 'update' ? 'fix the bank login' : 'connect a bank'}.`,
    );
    print('  Press Ctrl+C to cancel.');
    print('');
    const outcome = await Promise.race([server.result, interrupted]);
    if (outcome === 'interrupted') {
      log.warn('Interrupted; link cancelled.');
      return 1;
    }
    print(formatLinkResult(outcome));
    return 0;
  } finally {
    process.off('SIGINT', onSigint);
    await server.close();
  }
}

function buildProgram(env: NodeJS.ProcessEnv, setExitCode: (code: number) => void): Command {
  const program = new Command();
  program
    .name('actual-plaid-sync')
    .description('Sync Plaid bank transactions into Actual Budget')
    .version(version)
    .exitOverride();

  program
    .command('sync')
    .description('Sync recent Plaid transactions into Actual (CronJob default)')
    .action(async () => {
      const cfg = loadSyncConfig(env);
      const log = createLogger(cfg.logLevel);
      const client = createPlaidClient(cfg.plaid);
      // Loaded lazily: @actual-app/api pulls in native sqlite, which --help and link never need.
      const { withBudget } = await import('./actual/session.js');
      const { runSync } = await import('./sync/run.js');
      const { fetchTransactions } = await import('./plaid/transactions.js');
      const code = await withBudget(cfg.actual, log, (gateway) =>
        runSync(cfg, {
          fetchTransactions: (token, start, end) => fetchTransactions(client, token, start, end),
          gateway,
          log,
          today: todayUtc(),
        }),
      );
      setExitCode(code);
    });

  program
    .command('accounts')
    .description('List Plaid and Actual accounts and suggest an ACCOUNT_MAP')
    .action(async () => {
      const cfg = loadAccountsConfig(env);
      const log = createLogger(cfg.logLevel);
      const client = createPlaidClient(cfg.plaid);
      const { withBudget } = await import('./actual/session.js');
      const { runAccounts } = await import('./commands/accounts.js');
      const { fetchAccounts } = await import('./plaid/accounts.js');
      const code = await withBudget(cfg.actual, log, (gateway) =>
        runAccounts(cfg, {
          fetchAccounts: (token) => fetchAccounts(client, token),
          gateway,
          log,
          print,
        }),
      );
      setExitCode(code);
    });

  program
    .command('link')
    .description('Start a local web page to connect a bank with Plaid Link')
    .option('--update', 'repair an existing bank login (Plaid update mode)')
    .option(
      '--access-token <token>',
      'access token to repair with --update (overrides LINK_ACCESS_TOKEN)',
    )
    .action(async (opts: LinkOptions) => {
      setExitCode(await runLink(env, opts));
    });

  return program;
}

function exitCodeForError(err: unknown, env: NodeJS.ProcessEnv): number {
  if (err instanceof CommanderError) {
    // Commander already printed help, the version, or the usage error.
    return err.exitCode === 0 ? 0 : 2;
  }
  if (err instanceof ConfigError) {
    process.stderr.write('Configuration error:\n');
    for (const problem of err.problems) process.stderr.write(`  - ${problem}\n`);
    return 2;
  }
  const log = createLogger(fallbackLogLevel(env));
  if (err instanceof ActualError) {
    log.error(`${err.message} (${err.hint})`);
  } else if (err instanceof PlaidRequestError) {
    const code = err.code ? ` ${err.code}` : '';
    const requestId = err.requestId ? ` (request id ${err.requestId})` : '';
    log.error(`Plaid error${code}: ${err.message}${requestId}`);
  } else if (err instanceof Error) {
    log.error(err.message);
  } else {
    log.error(String(err));
  }
  return 1;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let exitCode = 0;
  const program = buildProgram(env, (code) => {
    exitCode = code;
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (err) {
    return exitCodeForError(err, env);
  }
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // realpath so a symlinked bin (npm i -g, node_modules/.bin) still matches import.meta.url.
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
