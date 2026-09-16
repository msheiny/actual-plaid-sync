import { readFileSync } from 'node:fs';
import { type Document, isScalar, parseDocument } from 'yaml';
import { z } from 'zod';
import type { LogLevel } from './log.js';

export type PlaidEnvName = 'sandbox' | 'production';

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: PlaidEnvName;
}

export interface ActualConfig {
  serverUrl: string;
  password: string;
  syncId: string;
  encryptionPassword?: string;
}

/** Selects a Plaid account by its mask (last 4 digits) or by its pinned account_id. */
export type PlaidSelector = { mask: string } | { id: string };

/** One entry of the accounts file; resolved against live accounts at sync time. */
export interface AccountEntry {
  plaid: PlaidSelector;
  /** Actual account name, matched trimmed and case-insensitively. */
  actual: string;
}

export interface SyncConfig {
  plaid: PlaidConfig;
  actual: ActualConfig;
  accessTokens: string[];
  accountsFile: string;
  accounts: AccountEntry[];
  syncDays: number;
  dryRun: boolean;
  refreshTransactions: boolean;
  logLevel: LogLevel;
}

export interface AccountsConfig {
  accountsFile: string;
  plaid: PlaidConfig;
  actual: ActualConfig;
  accessTokens: string[];
  logLevel: LogLevel;
}

export interface LinkConfig {
  plaid: PlaidConfig;
  countryCodes: string[];
  port: number;
  host: string;
  /** Tokens available for the interactive update-mode picker. */
  accessTokens: string[];
  accessToken?: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(['Invalid configuration:', ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const PLAID_ENVS = ['sandbox', 'production'] as const satisfies readonly PlaidEnvName[];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[];

export const DEFAULT_ACCOUNTS_FILE = 'accounts.yaml';

const REQUIRED = 'is required';

const requiredString = z.string({ error: REQUIRED });

function oneOf<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, {
    error: (issue) =>
      issue.input === undefined
        ? REQUIRED
        : `must be one of: ${values.join(', ')} (got "${String(issue.input)}")`,
  });
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const requiredList = requiredString.transform((value, ctx) => {
  const entries = splitList(value);
  if (entries.length === 0) {
    ctx.issues.push({ code: 'custom', message: 'must contain at least one entry', input: value });
    return z.NEVER;
  }
  return entries;
});

function intInRange(min: number, max: number) {
  return z.string().transform((value, ctx) => {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || parsed < min || parsed > max) {
      ctx.issues.push({
        code: 'custom',
        message: `must be an integer between ${min} and ${max} (got "${value}")`,
        input: value,
      });
      return z.NEVER;
    }
    return parsed;
  });
}

const booleanFlag = z.string().transform((value, ctx) => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  ctx.issues.push({
    code: 'custom',
    message: `must be one of: true, false, 1, 0 (got "${value}")`,
    input: value,
  });
  return z.NEVER;
});

const httpUrl = requiredString.refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  },
  { error: 'must be an http(s) URL' },
);

const countryCodes = z.string().transform((value, ctx) => {
  const codes = splitList(value).map((code) => code.toUpperCase());
  for (const code of codes) {
    if (!/^[A-Z]{2}$/.test(code)) {
      ctx.issues.push({
        code: 'custom',
        message: `"${code}" is not a 2-letter country code`,
        input: value,
      });
    }
  }
  if (codes.length === 0) {
    ctx.issues.push({ code: 'custom', message: 'must contain at least one entry', input: value });
  }
  return codes;
});

const plaidShape = {
  PLAID_CLIENT_ID: requiredString,
  PLAID_SECRET: requiredString,
  PLAID_ENV: oneOf(PLAID_ENVS),
};

const actualShape = {
  ACTUAL_SERVER_URL: httpUrl,
  ACTUAL_PASSWORD: requiredString,
  ACTUAL_SYNC_ID: requiredString,
  ACTUAL_ENCRYPTION_PASSWORD: z.string().optional(),
};

const logLevelShape = {
  LOG_LEVEL: oneOf(LOG_LEVELS).default('info'),
};

const syncSchema = z.object({
  ...plaidShape,
  PLAID_ACCESS_TOKENS: requiredList,
  ...actualShape,
  SYNC_DAYS: intInRange(1, 730).default(30),
  DRY_RUN: booleanFlag.default(false),
  PLAID_REFRESH_TRANSACTIONS: booleanFlag.default(false),
  ...logLevelShape,
});

const accountsSchema = z.object({
  ACCOUNTS_FILE: z.string().default(DEFAULT_ACCOUNTS_FILE),
  ...plaidShape,
  PLAID_ACCESS_TOKENS: requiredList,
  ...actualShape,
  ...logLevelShape,
});

const linkSchema = z.object({
  ...plaidShape,
  PLAID_ACCESS_TOKENS: z.string().default('').transform(splitList),
  PLAID_COUNTRY_CODES: countryCodes.default(['US']),
  LINK_PORT: intInRange(1, 65535).default(8484),
  LINK_HOST: z.string().default('127.0.0.1'),
  LINK_ACCESS_TOKEN: z.string().optional(),
  ...logLevelShape,
});

/** Copies the schema's keys out of env, treating empty or whitespace-only values as unset. */
function pickEnv(env: NodeJS.ProcessEnv, keys: string[]): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = env[key];
    picked[key] = value === undefined || value.trim() === '' ? undefined : value;
  }
  return picked;
}

function safeParseEnv<T extends z.ZodObject>(
  schema: T,
  env: NodeJS.ProcessEnv,
): { data: z.output<T>; problems: [] } | { data: undefined; problems: string[] } {
  const result = schema.safeParse(pickEnv(env, Object.keys(schema.shape)));
  if (result.success) return { data: result.data, problems: [] };
  return {
    data: undefined,
    problems: result.error.issues.map(
      (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
    ),
  };
}

function parseEnv<T extends z.ZodObject>(schema: T, env: NodeJS.ProcessEnv): z.output<T> {
  const result = safeParseEnv(schema, env);
  if (result.data === undefined) throw new ConfigError(result.problems);
  return result.data;
}

export interface AccountsFileResult {
  accounts: AccountEntry[];
  problems: string[];
}

const EMPTY_ACCOUNTS = 'accounts must contain at least one entry';
const ENTRY_KEYS = new Set(['plaid', 'actual']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The yaml library's messages span several lines (with a source excerpt); each problem must be
// one line, and the first line already carries "at line N, column M".
function firstLine(message: string): string {
  return (message.split('\n')[0] ?? '').replace(/:$/, '');
}

// YAML 1.2 reads an unquoted 0123 as the number 123, so errors quote the text as written.
function sourceText(doc: Document, path: Array<string | number>, value: unknown): string {
  const node = doc.getIn(path, true);
  return isScalar(node) && typeof node.source === 'string' ? node.source : String(value);
}

function parseEntry(
  doc: Document,
  index: number,
  raw: unknown,
): { entry?: AccountEntry; problems: string[] } {
  if (!isPlainObject(raw)) return { problems: ['must be a mapping with plaid and actual'] };
  const problems = Object.keys(raw)
    .filter((key) => !ENTRY_KEYS.has(key))
    .map((key) => `unknown key "${key}"`);

  let plaid: PlaidSelector | undefined;
  const rawPlaid = raw.plaid;
  if (rawPlaid === undefined || rawPlaid === null) {
    problems.push('plaid is required');
  } else if (typeof rawPlaid === 'number') {
    const text = sourceText(doc, ['accounts', index, 'plaid'], rawPlaid);
    problems.push(`plaid mask ${text} must be quoted ("${text}")`);
  } else if (typeof rawPlaid === 'string') {
    const value = rawPlaid.trim();
    if (value === '') problems.push('plaid must not be empty');
    else plaid = /^\d+$/.test(value) ? { mask: value } : { id: value };
  } else if (isPlainObject(rawPlaid)) {
    for (const key of Object.keys(rawPlaid)) {
      if (key !== 'id') problems.push(`plaid: unknown key "${key}"`);
    }
    const id = rawPlaid.id;
    if (id === undefined || id === null) problems.push('plaid.id is required');
    else if (typeof id !== 'string') problems.push('plaid.id must be a string');
    else if (id.trim() === '') problems.push('plaid.id must not be empty');
    else plaid = { id: id.trim() };
  } else {
    problems.push('plaid must be an account ID string or a quoted mask like "1234"');
  }

  let actual: string | undefined;
  const rawActual = raw.actual;
  if (rawActual === undefined || rawActual === null) {
    problems.push('actual is required');
  } else if (typeof rawActual === 'number' || typeof rawActual === 'boolean') {
    const text = sourceText(doc, ['accounts', index, 'actual'], rawActual);
    problems.push(`actual ${text} must be quoted ("${text}")`);
  } else if (typeof rawActual !== 'string') {
    problems.push('actual must be an Actual account name');
  } else if (rawActual.trim() === '') {
    problems.push('actual must not be empty');
  } else {
    actual = rawActual.trim();
  }

  if (problems.length > 0 || plaid === undefined || actual === undefined) return { problems };
  return { entry: { plaid, actual }, problems };
}

/**
 * Parses and validates the accounts file text. Every problem is one line prefixed with `path`;
 * `accounts` holds only the valid entries, so callers must check `problems` first.
 */
export function parseAccountsFile(text: string, path: string): AccountsFileResult {
  const fail = (problems: string[]): AccountsFileResult => ({
    accounts: [],
    problems: problems.map((problem) => `${path}: ${problem}`),
  });

  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return fail(doc.errors.map((err) => `invalid YAML: ${firstLine(err.message)}`));
  }
  let root: unknown;
  try {
    root = doc.toJS();
  } catch (err) {
    return fail([`invalid YAML: ${firstLine(err instanceof Error ? err.message : String(err))}`]);
  }
  if (root === null || root === undefined) return fail([EMPTY_ACCOUNTS]);
  if (!isPlainObject(root)) return fail(['must be a mapping with an "accounts" list']);

  const problems = Object.keys(root)
    .filter((key) => key !== 'accounts')
    .map((key) => `unknown key "${key}"`);
  const list = root.accounts;
  if (list === undefined || list === null || (Array.isArray(list) && list.length === 0)) {
    return fail([...problems, EMPTY_ACCOUNTS]);
  }
  if (!Array.isArray(list)) return fail([...problems, 'accounts must be a list']);

  const accounts: AccountEntry[] = [];
  const seenMasks = new Map<string, number>();
  const seenIds = new Map<string, number>();
  const seenActual = new Map<string, number>();
  const claim = (seen: Map<string, number>, key: string, n: number): number | undefined => {
    const first = seen.get(key);
    if (first === undefined) seen.set(key, n);
    return first;
  };

  list.forEach((raw, index) => {
    const n = index + 1;
    const parsed = parseEntry(doc, index, raw);
    for (const problem of parsed.problems) problems.push(`entry ${n}: ${problem}`);
    const entry = parsed.entry;
    if (!entry) return;

    const duplicates: string[] = [];
    const plaidFirst =
      'mask' in entry.plaid
        ? claim(seenMasks, entry.plaid.mask, n)
        : claim(seenIds, entry.plaid.id, n);
    if (plaidFirst !== undefined) {
      const what = 'mask' in entry.plaid ? `mask ${entry.plaid.mask}` : `id ${entry.plaid.id}`;
      duplicates.push(`plaid ${what} is already used by entry ${plaidFirst}`);
    }
    const actualFirst = claim(seenActual, entry.actual.toLowerCase(), n);
    if (actualFirst !== undefined) {
      duplicates.push(`actual "${entry.actual}" is already used by entry ${actualFirst}`);
    }
    for (const problem of duplicates) problems.push(`entry ${n}: ${problem}`);
    if (duplicates.length === 0) accounts.push(entry);
  });

  return problems.length > 0 ? fail(problems) : { accounts, problems: [] };
}

function readAccountsFile(path: string, readFile: (path: string) => string): AccountsFileResult {
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const reason =
      typeof code === 'string' ? code : firstLine(err instanceof Error ? err.message : String(err));
    return { accounts: [], problems: [`${path}: cannot read file (${reason})`] };
  }
  return parseAccountsFile(text, path);
}

function toPlaidConfig(parsed: z.output<z.ZodObject<typeof plaidShape>>): PlaidConfig {
  return { clientId: parsed.PLAID_CLIENT_ID, secret: parsed.PLAID_SECRET, env: parsed.PLAID_ENV };
}

function toActualConfig(parsed: z.output<z.ZodObject<typeof actualShape>>): ActualConfig {
  return {
    serverUrl: parsed.ACTUAL_SERVER_URL,
    password: parsed.ACTUAL_PASSWORD,
    syncId: parsed.ACTUAL_SYNC_ID,
    ...(parsed.ACTUAL_ENCRYPTION_PASSWORD === undefined
      ? {}
      : { encryptionPassword: parsed.ACTUAL_ENCRYPTION_PASSWORD }),
  };
}

/**
 * Loads sync settings from env plus the accounts file named by ACCOUNTS_FILE (relative paths
 * resolve against the working directory). Env and file problems are reported together.
 */
export function loadSyncConfig(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): SyncConfig {
  const parsed = safeParseEnv(syncSchema, env);
  const accountsFile = pickEnv(env, ['ACCOUNTS_FILE']).ACCOUNTS_FILE ?? DEFAULT_ACCOUNTS_FILE;
  const file = readAccountsFile(accountsFile, readFile);
  if (parsed.data === undefined || file.problems.length > 0) {
    throw new ConfigError([...parsed.problems, ...file.problems]);
  }
  const data = parsed.data;
  return {
    plaid: toPlaidConfig(data),
    actual: toActualConfig(data),
    accessTokens: data.PLAID_ACCESS_TOKENS,
    accountsFile,
    accounts: file.accounts,
    syncDays: data.SYNC_DAYS,
    dryRun: data.DRY_RUN,
    refreshTransactions: data.PLAID_REFRESH_TRANSACTIONS,
    logLevel: data.LOG_LEVEL,
  };
}

export function loadAccountsConfig(env: NodeJS.ProcessEnv): AccountsConfig {
  const parsed = parseEnv(accountsSchema, env);
  return {
    plaid: toPlaidConfig(parsed),
    actual: toActualConfig(parsed),
    accessTokens: parsed.PLAID_ACCESS_TOKENS,
    accountsFile: parsed.ACCOUNTS_FILE,
    logLevel: parsed.LOG_LEVEL,
  };
}

export function loadLinkConfig(env: NodeJS.ProcessEnv): LinkConfig {
  const parsed = parseEnv(linkSchema, env);
  return {
    plaid: toPlaidConfig(parsed),
    countryCodes: parsed.PLAID_COUNTRY_CODES,
    port: parsed.LINK_PORT,
    host: parsed.LINK_HOST,
    accessTokens: parsed.PLAID_ACCESS_TOKENS,
    ...(parsed.LINK_ACCESS_TOKEN === undefined ? {} : { accessToken: parsed.LINK_ACCESS_TOKEN }),
    logLevel: parsed.LOG_LEVEL,
  };
}
