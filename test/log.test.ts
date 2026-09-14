import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, maskToken } from '../src/log.js';

describe('createLogger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:34:56.789Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('formats lines as "<ISO timestamp> <LEVEL> <msg>"', () => {
    const lines: string[] = [];
    const log = createLogger('debug', (line) => lines.push(line));

    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(lines).toEqual([
      '2026-09-13T12:34:56.789Z DEBUG d',
      '2026-09-13T12:34:56.789Z INFO i',
      '2026-09-13T12:34:56.789Z WARN w',
      '2026-09-13T12:34:56.789Z ERROR e',
    ]);
  });

  it.each([
    ['debug', ['DEBUG', 'INFO', 'WARN', 'ERROR']],
    ['info', ['INFO', 'WARN', 'ERROR']],
    ['warn', ['WARN', 'ERROR']],
    ['error', ['ERROR']],
  ] as const)('at level %s emits only %j', (level, expected) => {
    const lines: string[] = [];
    const log = createLogger(level, (line) => lines.push(line));

    log.debug('x');
    log.info('x');
    log.warn('x');
    log.error('x');

    expect(lines.map((line) => line.split(' ')[1])).toEqual(expected);
  });

  it('writes to console.log by default', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('info');

    log.info('hello');

    expect(spy).toHaveBeenCalledWith('2026-09-13T12:34:56.789Z INFO hello');
  });
});

describe('maskToken', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskToken('access-sandbox-1234-abcd-a1b2')).toBe('…a1b2');
  });

  it('masks a token of exactly 4 characters', () => {
    expect(maskToken('wxyz')).toBe('…wxyz');
  });

  it.each(['', 'a', 'abc'])('returns only the ellipsis for short token %j', (token) => {
    expect(maskToken(token)).toBe('…');
  });
});
