import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkDeps } from '../../src/link/plaid-link.js';
import {
  formatLinkResult,
  type LinkResult,
  type LinkServer,
  linkServerUrl,
  startLinkServer,
} from '../../src/link/server.js';
import type { Logger } from '../../src/log.js';
import type { PlaidAccountInfo } from '../../src/plaid/accounts.js';

const ACCOUNTS: PlaidAccountInfo[] = [
  {
    accountId: 'acc-checking-1',
    name: 'Plaid Checking',
    officialName: null,
    mask: '0000',
    type: 'depository',
    subtype: 'checking',
  },
  {
    accountId: 'acc-cc',
    name: 'Plaid Credit Card',
    officialName: null,
    mask: null,
    type: 'credit',
    subtype: null,
  },
];

function fakeDeps() {
  return {
    createLinkToken: vi.fn<LinkDeps['createLinkToken']>().mockResolvedValue('link-sandbox-123'),
    exchangePublicToken: vi
      .fn<LinkDeps['exchangePublicToken']>()
      .mockResolvedValue({ accessToken: 'access-sandbox-new', itemId: 'item-1' }),
    fetchAccounts: vi.fn<LinkDeps['fetchAccounts']>().mockResolvedValue(ACCOUNTS),
  };
}

function fakeLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

let server: LinkServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(
  mode: 'create' | 'update',
  deps: LinkDeps,
  log: Logger = fakeLog(),
  accessToken?: string,
): Promise<LinkServer> {
  server = await startLinkServer({
    mode,
    plaidEnv: 'sandbox',
    host: '127.0.0.1',
    port: 0,
    deps,
    log,
    ...(accessToken ? { accessToken } : {}),
  });
  return server;
}

function post(s: LinkServer, path: string, body?: unknown, rawBody?: string): Promise<Response> {
  return fetch(`${s.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody ?? JSON.stringify(body ?? {}),
  });
}

describe('startLinkServer', () => {
  it('listens on an ephemeral port and reports a localhost url', async () => {
    const s = await start('create', fakeDeps());
    expect(s.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(s.url).not.toBe('http://localhost:0');
  });

  it('serves the Link page on GET /', async () => {
    const s = await start('create', fakeDeps());
    const res = await fetch(`${s.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('https://cdn.plaid.com/link/v2/stable/link-initialize.js');
    expect(html).toContain('Connect bank');
  });

  it('returns a link token from POST /api/link-token', async () => {
    const deps = fakeDeps();
    const s = await start('create', deps);
    const res = await post(s, '/api/link-token');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ linkToken: 'link-sandbox-123' });
    expect(deps.createLinkToken).toHaveBeenCalledTimes(1);
  });

  it('exchanges the public token in create mode and resolves the result', async () => {
    const deps = fakeDeps();
    const s = await start('create', deps);
    const res = await post(s, '/api/complete', { publicToken: 'public-sandbox-abc' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    await expect(s.result).resolves.toEqual({
      accessToken: 'access-sandbox-new',
      itemId: 'item-1',
      accounts: ACCOUNTS,
    } satisfies LinkResult);
    expect(deps.exchangePublicToken).toHaveBeenCalledWith('public-sandbox-abc');
    expect(deps.fetchAccounts).toHaveBeenCalledWith('access-sandbox-new');
  });

  it('reuses the existing access token in update mode without exchanging', async () => {
    const deps = fakeDeps();
    const s = await start('update', deps, fakeLog(), 'access-existing');
    const res = await post(s, '/api/complete', { publicToken: 'public-sandbox-ignored' });
    expect(res.status).toBe(200);

    await expect(s.result).resolves.toEqual({
      accessToken: 'access-existing',
      itemId: null,
      accounts: ACCOUNTS,
    });
    expect(deps.exchangePublicToken).not.toHaveBeenCalled();
    expect(deps.fetchAccounts).toHaveBeenCalledWith('access-existing');
  });

  it('serves the update page in update mode', async () => {
    const s = await start('update', fakeDeps(), fakeLog(), 'access-existing');
    const html = await (await fetch(`${s.url}/`)).text();
    expect(html).toContain('Fix bank login');
  });

  it('rejects update mode without an access token', async () => {
    await expect(
      startLinkServer({
        mode: 'update',
        plaidEnv: 'sandbox',
        host: '127.0.0.1',
        port: 0,
        deps: fakeDeps(),
        log: fakeLog(),
      }),
    ).rejects.toThrow('accessToken is required in update mode');
  });

  it('returns 400 when publicToken is missing in create mode', async () => {
    const deps = fakeDeps();
    const s = await start('create', deps);
    const res = await post(s, '/api/complete', {});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'publicToken is required' });
    expect(deps.exchangePublicToken).not.toHaveBeenCalled();
  });

  it('returns 400 for a body that is not JSON', async () => {
    const s = await start('create', fakeDeps());
    const res = await post(s, '/api/complete', undefined, 'not json');
    expect(res.status).toBe(400);
  });

  it('allows /api/complete to succeed only once', async () => {
    const s = await start('create', fakeDeps());
    expect((await post(s, '/api/complete', { publicToken: 'public-sandbox-abc' })).status).toBe(
      200,
    );
    const second = await post(s, '/api/complete', { publicToken: 'public-sandbox-abc' });
    expect(second.status).toBe(409);
  });

  it('returns 500 on a dependency error, logs it, and lets the user retry', async () => {
    const deps = fakeDeps();
    deps.exchangePublicToken.mockRejectedValueOnce(new Error('Plaid is down'));
    const log = fakeLog();
    const s = await start('create', deps, log);

    const failed = await post(s, '/api/complete', { publicToken: 'public-sandbox-abc' });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: 'Plaid is down' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Plaid is down'));

    const retried = await post(s, '/api/complete', { publicToken: 'public-sandbox-abc' });
    expect(retried.status).toBe(200);
    await expect(s.result).resolves.toMatchObject({ accessToken: 'access-sandbox-new' });
  });

  it('does not exchange twice when fetching accounts fails after a successful exchange', async () => {
    const deps = fakeDeps();
    deps.fetchAccounts.mockRejectedValueOnce(new Error('accounts timeout'));
    const s = await start('create', deps);

    expect((await post(s, '/api/complete', { publicToken: 'public-sandbox-abc' })).status).toBe(
      500,
    );
    expect((await post(s, '/api/complete', { publicToken: 'public-sandbox-abc' })).status).toBe(
      200,
    );
    expect(deps.exchangePublicToken).toHaveBeenCalledTimes(1);
    await expect(s.result).resolves.toMatchObject({ itemId: 'item-1' });
  });

  it('returns 500 when creating a link token fails', async () => {
    const deps = fakeDeps();
    deps.createLinkToken.mockRejectedValueOnce(new Error('INVALID_API_KEYS'));
    const s = await start('create', deps);
    const res = await post(s, '/api/link-token');
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'INVALID_API_KEYS' });
  });

  it('returns 404 for unknown routes', async () => {
    const s = await start('create', fakeDeps());
    expect((await fetch(`${s.url}/nope`)).status).toBe(404);
    expect((await post(s, '/api/exchange')).status).toBe(404);
  });

  it('returns 405 for wrong methods', async () => {
    const s = await start('create', fakeDeps());
    const getComplete = await fetch(`${s.url}/api/complete`);
    expect(getComplete.status).toBe(405);
    expect(getComplete.headers.get('allow')).toBe('POST');
    expect((await fetch(`${s.url}/api/link-token`)).status).toBe(405);
    expect((await post(s, '/')).status).toBe(405);
  });

  it('stops accepting connections after close()', async () => {
    const s = await start('create', fakeDeps());
    expect((await fetch(`${s.url}/`)).status).toBe(200);
    await s.close();
    await expect(fetch(`${s.url}/`)).rejects.toThrow();
  });
});

describe('linkServerUrl', () => {
  it('shows localhost for loopback and wildcard hosts', () => {
    expect(linkServerUrl('127.0.0.1', 8484)).toBe('http://localhost:8484');
    expect(linkServerUrl('0.0.0.0', 8484)).toBe('http://localhost:8484');
    expect(linkServerUrl('localhost', 8484)).toBe('http://localhost:8484');
  });

  it('shows other hosts as given', () => {
    expect(linkServerUrl('192.168.1.20', 9000)).toBe('http://192.168.1.20:9000');
  });
});

describe('formatLinkResult', () => {
  it('prints the full access token, a secret warning, the item id, and an account table in create mode', () => {
    const out = formatLinkResult({
      accessToken: 'access-sandbox-new',
      itemId: 'item-1',
      accounts: ACCOUNTS,
    });
    const lines = out.split('\n');
    expect(lines).toContain('PLAID_ACCESS_TOKENS=access-sandbox-new');
    expect(out).toMatch(/WARNING: this access token is a secret/);
    expect(lines).toContain('Item ID: item-1');
    expect(lines).toContain('  ACCOUNT ID      NAME               MASK  TYPE');
    expect(lines).toContain('  acc-checking-1  Plaid Checking     0000  depository/checking');
    expect(lines).toContain('  acc-cc          Plaid Credit Card  -     credit');
    expect(out).toContain('run `actual-plaid-sync accounts`');
    expect(out).toContain('ACCOUNT_MAP');
  });

  it('says the existing token stays valid in update mode and does not print it', () => {
    const out = formatLinkResult({
      accessToken: 'access-existing-9f3c',
      itemId: null,
      accounts: ACCOUNTS,
    });
    expect(out).toContain('The existing access token (…9f3c) remains valid');
    expect(out).not.toContain('access-existing-9f3c');
    expect(out).not.toContain('PLAID_ACCESS_TOKENS=');
    expect(out).toContain('  acc-checking-1  Plaid Checking     0000  depository/checking');
  });

  it('notes when Plaid returned no accounts', () => {
    const out = formatLinkResult({
      accessToken: 'access-sandbox-new',
      itemId: 'item-1',
      accounts: [],
    });
    expect(out).toContain('(Plaid returned no accounts for this item)');
  });
});
