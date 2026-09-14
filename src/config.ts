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

export interface AccountMapping {
  plaidAccountId: string;
  actualAccountId: string;
}

export interface SyncConfig {
  plaid: PlaidConfig;
  actual: ActualConfig;
  accessTokens: string[];
  accountMap: AccountMapping[];
  syncDays: number;
  dryRun: boolean;
  logLevel: LogLevel;
}

export interface AccountsConfig {
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

const accountMap = requiredString.transform((value, ctx) => {
  const entries = value.split(',').map((entry) => entry.trim());
  const nonEmpty = entries.filter((entry) => entry.length > 0);
  if (nonEmpty.length === 0) {
    ctx.issues.push({ code: 'custom', message: 'must contain at least one entry', input: value });
    return z.NEVER;
  }
  const mappings: AccountMapping[] = [];
  const seenPlaid = new Set<string>();
  const seenActual = new Set<string>();
  nonEmpty.forEach((entry, index) => {
    const parts = entry.split(':').map((part) => part.trim());
    const [plaidAccountId, actualAccountId] = parts;
    if (parts.length !== 2 || !plaidAccountId || !actualAccountId) {
      ctx.issues.push({
        code: 'custom',
        message: `entry ${index + 1} "${entry}" must be plaidAccountId:actualAccountId`,
        input: value,
      });
      return;
    }
    if (seenPlaid.has(plaidAccountId)) {
      ctx.issues.push({
        code: 'custom',
        message: `plaid account "${plaidAccountId}" is mapped more than once`,
        input: value,
      });
      return;
    }
    if (seenActual.has(actualAccountId)) {
      ctx.issues.push({
        code: 'custom',
        message: `Actual account "${actualAccountId}" is mapped more than once`,
        input: value,
      });
      return;
    }
    seenPlaid.add(plaidAccountId);
    seenActual.add(actualAccountId);
    mappings.push({ plaidAccountId, actualAccountId });
  });
  return mappings;
});

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
  ACCOUNT_MAP: accountMap,
  ...actualShape,
  SYNC_DAYS: intInRange(1, 730).default(30),
  DRY_RUN: booleanFlag.default(false),
  ...logLevelShape,
});

const accountsSchema = z.object({
  ...plaidShape,
  PLAID_ACCESS_TOKENS: requiredList,
  ...actualShape,
  ...logLevelShape,
});

const linkSchema = z.object({
  ...plaidShape,
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

function parseEnv<T extends z.ZodObject>(schema: T, env: NodeJS.ProcessEnv): z.output<T> {
  const result = schema.safeParse(pickEnv(env, Object.keys(schema.shape)));
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`),
    );
  }
  return result.data;
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

export function loadSyncConfig(env: NodeJS.ProcessEnv): SyncConfig {
  const parsed = parseEnv(syncSchema, env);
  return {
    plaid: toPlaidConfig(parsed),
    actual: toActualConfig(parsed),
    accessTokens: parsed.PLAID_ACCESS_TOKENS,
    accountMap: parsed.ACCOUNT_MAP,
    syncDays: parsed.SYNC_DAYS,
    dryRun: parsed.DRY_RUN,
    logLevel: parsed.LOG_LEVEL,
  };
}

export function loadAccountsConfig(env: NodeJS.ProcessEnv): AccountsConfig {
  const parsed = parseEnv(accountsSchema, env);
  return {
    plaid: toPlaidConfig(parsed),
    actual: toActualConfig(parsed),
    accessTokens: parsed.PLAID_ACCESS_TOKENS,
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
    ...(parsed.LINK_ACCESS_TOKEN === undefined ? {} : { accessToken: parsed.LINK_ACCESS_TOKEN }),
    logLevel: parsed.LOG_LEVEL,
  };
}
