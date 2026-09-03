import { describe, expect, it } from 'vitest';

import {
  bucketForDays,
  parseISODateLocal,
  previousPeriod,
  resolvePeriod,
  toISODateLocal,
} from './periods';

// Fixed clock: Wednesday 20 May 2026, 15:42 local.
const NOW = new Date(2026, 4, 20, 15, 42, 7, 123);

const iso = (d: Date) => toISODateLocal(d);

describe('resolvePeriod', () => {
  it('today spans local midnight to the next midnight', () => {
    const p = resolvePeriod({ preset: 'today' }, NOW);
    expect(iso(p.from)).toBe('2026-05-20');
    expect(iso(p.to)).toBe('2026-05-21');
    expect(p.from.getHours()).toBe(0);
    expect(p.days).toBe(1);
    expect(p.bucket).toBe('hour');
  });

  it('last7 is inclusive of today — 7 calendar days, not 8', () => {
    const p = resolvePeriod({ preset: 'last7' }, NOW);
    expect(iso(p.from)).toBe('2026-05-14');
    expect(iso(p.to)).toBe('2026-05-21');
    expect(p.days).toBe(7);
    expect(p.bucket).toBe('day');
  });

  it('last15 and last30 follow the same inclusive rule', () => {
    expect(iso(resolvePeriod({ preset: 'last15' }, NOW).from)).toBe(
      '2026-05-06'
    );
    expect(resolvePeriod({ preset: 'last15' }, NOW).days).toBe(15);

    expect(iso(resolvePeriod({ preset: 'last30' }, NOW).from)).toBe(
      '2026-04-21'
    );
    expect(resolvePeriod({ preset: 'last30' }, NOW).days).toBe(30);
  });

  it('thisMonth runs from the 1st through end of today', () => {
    const p = resolvePeriod({ preset: 'thisMonth' }, NOW);
    expect(iso(p.from)).toBe('2026-05-01');
    expect(iso(p.to)).toBe('2026-05-21');
  });

  it('lastMonth is the whole previous calendar month', () => {
    const p = resolvePeriod({ preset: 'lastMonth' }, NOW);
    expect(iso(p.from)).toBe('2026-04-01');
    expect(iso(p.to)).toBe('2026-05-01');
    expect(p.days).toBe(30);
  });

  it('custom is inclusive of the end date the operator typed', () => {
    const p = resolvePeriod(
      { preset: 'custom', fromDate: '2026-03-01', toDate: '2026-03-31' },
      NOW
    );
    expect(iso(p.from)).toBe('2026-03-01');
    // Exclusive bound = the day after the inclusive end.
    expect(iso(p.to)).toBe('2026-04-01');
    expect(p.days).toBe(31);
  });

  it('falls back to last30 for an incomplete or reversed custom range', () => {
    const noDates = resolvePeriod({ preset: 'custom' }, NOW);
    expect(noDates.preset).toBe('last30');

    const reversed = resolvePeriod(
      { preset: 'custom', fromDate: '2026-05-20', toDate: '2026-05-01' },
      NOW
    );
    expect(reversed.preset).toBe('last30');

    const garbage = resolvePeriod(
      { preset: 'custom', fromDate: 'not-a-date', toDate: '2026-05-01' },
      NOW
    );
    expect(garbage.preset).toBe('last30');
  });

  it('produces half-open intervals so consecutive periods do not overlap', () => {
    const p = resolvePeriod({ preset: 'lastMonth' }, NOW);
    const q = resolvePeriod({ preset: 'thisMonth' }, NOW);
    // April ends exactly where May begins — no order is counted twice.
    expect(p.to.getTime()).toBe(q.from.getTime());
  });
});

describe('previousPeriod', () => {
  it('shifts a rolling window back by its own span', () => {
    const cur = resolvePeriod({ preset: 'last7' }, NOW);
    const prev = previousPeriod(cur);
    expect(iso(prev.from)).toBe('2026-05-07');
    expect(iso(prev.to)).toBe('2026-05-14');
    expect(prev.to.getTime()).toBe(cur.from.getTime());
  });

  it('compares a calendar month against the previous CALENDAR month', () => {
    // Not "31 days earlier" — a monthly P&L compared against a
    // sliding 31-day window is a number nobody can act on.
    const cur = resolvePeriod({ preset: 'thisMonth' }, NOW);
    const prev = previousPeriod(cur);
    expect(iso(prev.from)).toBe('2026-04-01');
    expect(iso(prev.to)).toBe('2026-05-01');
  });

  it('handles a month-length boundary without rolling over', () => {
    // 1 March back one month must be 1 February, not 3 March.
    const march = resolvePeriod(
      { preset: 'thisMonth' },
      new Date(2026, 2, 31, 12, 0, 0)
    );
    const prev = previousPeriod(march);
    expect(iso(prev.from)).toBe('2026-02-01');
    expect(iso(prev.to)).toBe('2026-03-01');
  });
});

describe('bucketForDays', () => {
  it('picks a granularity that keeps the chart readable', () => {
    expect(bucketForDays(1)).toBe('hour');
    expect(bucketForDays(7)).toBe('day');
    expect(bucketForDays(30)).toBe('day');
    expect(bucketForDays(70)).toBe('day');
    expect(bucketForDays(90)).toBe('week');
    expect(bucketForDays(365)).toBe('week');
    expect(bucketForDays(400)).toBe('month');
  });
});

describe('parseISODateLocal', () => {
  it('parses to LOCAL midnight, not UTC midnight', () => {
    const d = parseISODateLocal('2026-05-20');
    expect(d).not.toBeNull();
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(4);
    expect(d?.getDate()).toBe(20);
    expect(d?.getHours()).toBe(0);
  });

  it('rejects impossible dates that Date would silently roll over', () => {
    expect(parseISODateLocal('2026-02-31')).toBeNull();
    expect(parseISODateLocal('2026-13-01')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseISODateLocal('20/05/2026')).toBeNull();
    expect(parseISODateLocal('')).toBeNull();
    expect(parseISODateLocal('2026-5-20')).toBeNull();
  });

  it('round-trips with toISODateLocal', () => {
    for (const s of ['2026-01-01', '2026-05-20', '2026-12-31']) {
      expect(toISODateLocal(parseISODateLocal(s) as Date)).toBe(s);
    }
  });
});
