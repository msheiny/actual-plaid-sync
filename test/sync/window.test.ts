import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, computeWindow, todayUtc } from '../../src/sync/window.js';

describe('addDays', () => {
  it.each([
    ['2026-09-13', 0, '2026-09-13'],
    ['2026-09-13', 1, '2026-09-14'],
    ['2026-09-13', -30, '2026-08-14'],
    ['2026-09-30', 1, '2026-10-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2028-03-01', -1, '2028-02-29'],
  ])('addDays(%s, %i) = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it.each(['2026-9-13', '2026-02-30', '2026-13-01', 'not-a-date', ''])(
    'throws on invalid date %j',
    (date) => {
      expect(() => addDays(date, 1)).toThrow(/Invalid date/);
    },
  );
});

describe('computeWindow', () => {
  it('computes a normal 30-day window', () => {
    expect(computeWindow('2026-09-13', 30)).toEqual({
      start: '2026-08-14',
      end: '2026-09-13',
      trustedStart: '2026-08-17',
      lookbackStart: '2026-07-15',
    });
  });

  it('crosses a month boundary (short February)', () => {
    expect(computeWindow('2026-03-02', 1)).toEqual({
      start: '2026-03-01',
      end: '2026-03-02',
      trustedStart: '2026-03-04',
      lookbackStart: '2026-01-30',
    });
  });

  it('crosses a year boundary', () => {
    expect(computeWindow('2027-01-10', 30)).toEqual({
      start: '2026-12-11',
      end: '2027-01-10',
      trustedStart: '2026-12-14',
      lookbackStart: '2026-11-11',
    });
  });

  it('lands on a leap day', () => {
    expect(computeWindow('2028-03-30', 30)).toEqual({
      start: '2028-02-29',
      end: '2028-03-30',
      trustedStart: '2028-03-03',
      lookbackStart: '2028-01-30',
    });
  });
});

describe('todayUtc', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats the UTC calendar date of the given instant', () => {
    expect(todayUtc(new Date('2026-09-13T23:59:59Z'))).toBe('2026-09-13');
  });

  it('uses UTC, not the local offset of the instant', () => {
    expect(todayUtc(new Date('2026-09-13T23:30:00-05:00'))).toBe('2026-09-14');
  });

  it('defaults to the current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2028-02-29T12:00:00Z'));
    expect(todayUtc()).toBe('2028-02-29');
  });
});
