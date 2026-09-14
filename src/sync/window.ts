import type { SyncWindow } from './types.js';

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(date: string): number {
  const ms = DATE_RE.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  // The round-trip check rejects dates JS would silently roll over (e.g. 2026-02-30).
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid date (expected YYYY-MM-DD): ${JSON.stringify(date)}`);
  }
  return ms;
}

export function addDays(date: string, days: number): string {
  return new Date(parseDate(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function computeWindow(today: string, syncDays: number): SyncWindow {
  const start = addDays(today, -syncDays);
  return {
    start,
    end: today,
    trustedStart: addDays(start, 3),
    lookbackStart: addDays(start, -30),
  };
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
