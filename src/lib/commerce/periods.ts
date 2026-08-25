// ============================================================
// Period resolution.
//
// Every filter in the app funnels through here, so "últimos 7 dias"
// means the same window on the dashboard, in the product ranking,
// and in a report. The output is a half-open interval [from, to) —
// half-open so consecutive periods tile without double-counting an
// order that lands exactly on midnight.
//
// Boundaries are computed in LOCAL time, because "hoje" to an
// operator in São Paulo means their calendar day, not UTC's.
// `resolvePeriod` accepts an injectable `now` so tests are not
// wall-clock dependent.
// ============================================================

export const PERIOD_PRESETS = [
  'today',
  'last7',
  'last15',
  'last30',
  'thisMonth',
  'lastMonth',
  'custom',
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export function isPeriodPreset(value: unknown): value is PeriodPreset {
  return (
    typeof value === 'string' &&
    (PERIOD_PRESETS as readonly string[]).includes(value)
  );
}

/** Chart bucket granularity. Mirrors the allowlist in commerce_sales_series. */
export type SeriesBucket = 'hour' | 'day' | 'week' | 'month';

export interface PeriodSelection {
  preset: PeriodPreset;
  /** Only meaningful when preset === 'custom'. ISO date, `YYYY-MM-DD`. */
  fromDate?: string;
  toDate?: string;
}

export interface ResolvedPeriod {
  preset: PeriodPreset;
  /** Inclusive start. */
  from: Date;
  /** EXCLUSIVE end. */
  to: Date;
  /** Suggested chart granularity for this span. */
  bucket: SeriesBucket;
  /** Whole days covered, ≥ 1. */
  days: number;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function startOfMonth(d: Date): Date {
  const out = new Date(d);
  out.setDate(1);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  // Pin to the 1st before shifting: `new Date(2026, 0, 31)` plus one
  // month is 3 March, not 28 February. Every caller here is already
  // at a month start, but the guard keeps that from being a hidden
  // precondition.
  out.setDate(1);
  out.setMonth(out.getMonth() + months);
  return out;
}

/**
 * Pick a sensible bucket for a span. A single day is read hour by
 * hour; up to ~10 weeks day by day; a quarter or so by week; beyond
 * that, monthly. Prevents both a 1-point line and a 400-point one.
 */
export function bucketForDays(days: number): SeriesBucket {
  if (days <= 1) return 'hour';
  if (days <= 70) return 'day';
  if (days <= 365) return 'week';
  return 'month';
}

/** Parse `YYYY-MM-DD` as a LOCAL midnight, not a UTC one. */
export function parseISODateLocal(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  // Reject impossible dates that Date silently rolls over (2026-02-31).
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/** Format a Date as a local `YYYY-MM-DD` (no UTC shift). */
export function toISODateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Turn a UI selection into a concrete window.
 *
 * An invalid or incomplete custom range falls back to `last30`
 * rather than throwing — a malformed query string should degrade to
 * a sane dashboard, not a crashed page.
 */
export function resolvePeriod(
  selection: PeriodSelection,
  now: Date = new Date()
): ResolvedPeriod {
  const today = startOfDay(now);

  const build = (
    preset: PeriodPreset,
    from: Date,
    to: Date
  ): ResolvedPeriod => {
    const days = Math.max(
      1,
      Math.round((to.getTime() - from.getTime()) / 86_400_000)
    );
    return { preset, from, to, bucket: bucketForDays(days), days };
  };

  switch (selection.preset) {
    case 'today':
      return build('today', today, addDays(today, 1));

    case 'last7':
      return build('last7', addDays(today, -6), addDays(today, 1));

    case 'last15':
      return build('last15', addDays(today, -14), addDays(today, 1));

    case 'last30':
      return build('last30', addDays(today, -29), addDays(today, 1));

    case 'thisMonth': {
      const from = startOfMonth(today);
      return build('thisMonth', from, addDays(today, 1));
    }

    case 'lastMonth': {
      const thisMonth = startOfMonth(today);
      const from = addMonths(thisMonth, -1);
      return build('lastMonth', from, thisMonth);
    }

    case 'custom': {
      const from = selection.fromDate
        ? parseISODateLocal(selection.fromDate)
        : null;
      const to = selection.toDate ? parseISODateLocal(selection.toDate) : null;
      if (!from || !to || to < from) {
        return resolvePeriod({ preset: 'last30' }, now);
      }
      // `toDate` is inclusive in the UI, exclusive in the interval.
      return build('custom', from, addDays(to, 1));
    }

    default:
      return resolvePeriod({ preset: 'last30' }, now);
  }
}

/**
 * The equally-long window immediately before `period`, for the
 * "vs. período anterior" comparison.
 *
 * Calendar-month presets compare against the previous CALENDAR
 * month, not against "the same number of days earlier" — comparing
 * a 31-day March against 31 days ending 28 February would be an
 * unusable number for anyone reading a monthly P&L.
 */
export function previousPeriod(period: ResolvedPeriod): ResolvedPeriod {
  if (period.preset === 'thisMonth' || period.preset === 'lastMonth') {
    const from = addMonths(startOfMonth(period.from), -1);
    const to = startOfMonth(period.from);
    const days = Math.max(
      1,
      Math.round((to.getTime() - from.getTime()) / 86_400_000)
    );
    return { preset: period.preset, from, to, bucket: period.bucket, days };
  }

  const span = period.to.getTime() - period.from.getTime();
  const from = new Date(period.from.getTime() - span);
  const to = new Date(period.from.getTime());
  return {
    preset: period.preset,
    from,
    to,
    bucket: period.bucket,
    days: period.days,
  };
}

/**
 * The browser's IANA timezone, passed to commerce_sales_series so
 * bucket boundaries match the operator's calendar. Falls back to UTC
 * on the server or in an environment without Intl.
 */
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
