export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(level: LogLevel, write: (line: string) => void = console.log): Logger {
  const threshold = LEVEL_RANK[level];
  const emit = (msgLevel: LogLevel, msg: string): void => {
    if (LEVEL_RANK[msgLevel] < threshold) return;
    write(`${new Date().toISOString()} ${msgLevel.toUpperCase()} ${msg}`);
  };
  return {
    debug: (msg) => emit('debug', msg),
    info: (msg) => emit('info', msg),
    warn: (msg) => emit('warn', msg),
    error: (msg) => emit('error', msg),
  };
}

export function maskToken(token: string): string {
  if (token.length < 4) return '…';
  return `…${token.slice(-4)}`;
}
