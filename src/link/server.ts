import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { formatTable, plaidAccountRow } from '../commands/accounts.js';
import type { PlaidEnvName } from '../config.js';
import { type Logger, maskToken } from '../log.js';
import type { PlaidAccountInfo } from '../plaid/accounts.js';
import { renderLinkPage } from './page.js';
import type { LinkDeps } from './plaid-link.js';

export interface LinkResult {
  accessToken: string;
  itemId: string | null;
  accounts: PlaidAccountInfo[];
}

export interface LinkServerOptions {
  mode: 'create' | 'update';
  plaidEnv: PlaidEnvName;
  accessToken?: string;
  host: string;
  port: number;
  deps: LinkDeps;
  log: Logger;
}

export interface LinkServer {
  url: string;
  result: Promise<LinkResult>;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
const LOCALHOST_ALIASES = new Set(['127.0.0.1', '0.0.0.0', 'localhost', '::', '::1']);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function linkServerUrl(host: string, port: number): string {
  if (LOCALHOST_ALIASES.has(host)) return `http://localhost:${port}`;
  return host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

// Reuses the same column layout as `accounts` (formatTable + plaidAccountRow from
// commands/accounts.js) so the two commands print accounts identically; only the headers and
// the two-space left margin differ here.
function formatAccountTable(accounts: PlaidAccountInfo[]): string[] {
  if (accounts.length === 0) return ['  (Plaid returned no accounts for this item)'];
  const lines = formatTable(['ACCOUNT ID', 'NAME', 'MASK', 'TYPE'], accounts.map(plaidAccountRow));
  return lines.map((line) => `  ${line}`.trimEnd());
}

export function formatLinkResult(result: LinkResult): string {
  const lines: string[] = [];
  if (result.itemId === null) {
    lines.push(
      'Bank login updated.',
      `The existing access token (${maskToken(result.accessToken)}) remains valid; PLAID_ACCESS_TOKENS does not need to change.`,
    );
  } else {
    lines.push(
      'Bank linked.',
      '',
      'Add this access token to PLAID_ACCESS_TOKENS (comma-separate it from any tokens you already have):',
      `PLAID_ACCESS_TOKENS=${result.accessToken}`,
      'WARNING: this access token is a secret. Store it in a Kubernetes Secret or password manager; never commit or share it.',
      '',
      `Item ID: ${result.itemId}`,
    );
  }
  lines.push(
    '',
    'Accounts:',
    ...formatAccountTable(result.accounts),
    '',
    'Next: run `actual-plaid-sync accounts` to match these accounts to Actual and build ACCOUNT_MAP.',
  );
  return lines.join('\n');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: 'Method not allowed' });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export async function startLinkServer(opts: LinkServerOptions): Promise<LinkServer> {
  const { mode, deps, log } = opts;
  if (mode === 'update' && !opts.accessToken) {
    throw new Error('startLinkServer: accessToken is required in update mode');
  }
  const updateAccessToken = opts.accessToken ?? '';
  const page = renderLinkPage(mode, opts.plaidEnv);

  let resolveResult: (result: LinkResult) => void = () => {};
  const result = new Promise<LinkResult>((resolve) => {
    resolveResult = resolve;
  });
  let state: 'waiting' | 'completing' | 'done' = 'waiting';
  // Public tokens are single-use: remember a successful exchange so a retry after a later failure skips it.
  let exchanged: { accessToken: string; itemId: string } | null = null;

  async function complete(body: Record<string, unknown>): Promise<LinkResult> {
    if (mode === 'update') {
      const accounts = await deps.fetchAccounts(updateAccessToken);
      return { accessToken: updateAccessToken, itemId: null, accounts };
    }
    let item = exchanged;
    if (item === null) {
      const publicToken = body.publicToken;
      if (typeof publicToken !== 'string' || publicToken === '') {
        throw new HttpError(400, 'publicToken is required');
      }
      item = await deps.exchangePublicToken(publicToken);
      exchanged = item;
      log.info(`Exchanged public token for item ${item.itemId}`);
    }
    const accounts = await deps.fetchAccounts(item.accessToken);
    return { accessToken: item.accessToken, itemId: item.itemId, accounts };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/') {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(page),
        'Cache-Control': 'no-store',
      });
      res.end(page);
      return;
    }
    if (path === '/api/link-token') {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
      const linkToken = await deps.createLinkToken();
      sendJson(res, 200, { linkToken });
      return;
    }
    if (path === '/api/complete') {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
      if (state !== 'waiting') {
        const error =
          state === 'done'
            ? 'Link already completed; return to your terminal'
            : 'Link completion already in progress';
        sendJson(res, 409, { error });
        return;
      }
      state = 'completing';
      let linkResult: LinkResult;
      try {
        linkResult = await complete(await readJsonBody(req));
      } catch (err) {
        state = 'waiting';
        throw err;
      }
      state = 'done';
      // Resolve only once the response has gone out, so the caller can close the server safely.
      res.once('close', () => resolveResult(linkResult));
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    log.debug(`Link server: ${req.method ?? '?'} ${path}`);
    handle(req, res, path).catch((err: unknown) => {
      if (err instanceof HttpError) {
        log.warn(`Link server: ${req.method ?? '?'} ${path} -> ${err.status}: ${err.message}`);
        if (!res.headersSent) sendJson(res, err.status, { error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Link server: ${req.method ?? '?'} ${path} failed: ${message}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { error: message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: linkServerUrl(opts.host, port),
    result,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
