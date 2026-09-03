// ============================================================
// Money — the only place in the app that knows how currency is
// represented. Everything downstream (calculations, repositories,
// UI) speaks integer minor units and calls in here to render.
//
// INVARIANT: a monetary amount is a JS integer number of CENTS.
// Never a float of currency units. `19.99` does not exist in this
// codebase; `1999` does.
//
// Why not a Decimal library: the ledger here is bounded by
// Number.MAX_SAFE_INTEGER cents (~90 trillion BRL). Integer
// arithmetic below that bound is exact in IEEE-754, so a decimal
// dependency would buy nothing but bundle weight. The one place
// exactness is at risk is percentage maths, which is funnelled
// through `applyPercent` with an explicit, tested rounding rule.
// ============================================================

/** Basis points: 1 bp = 0.01%. 1250 bp = 12.50%. */
export type BasisPoints = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Coerce an untrusted value into a safe integer cent amount.
 *
 * Rejects NaN, Infinity, non-integers, and anything past the safe
 * integer bound instead of silently truncating — a corrupted money
 * value must fail loudly at the boundary, not surface three screens
 * later as a wrong margin.
 */
export function toCents(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new MoneyError(`Not a finite monetary value: ${String(value)}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new MoneyError(`Monetary values must be integer cents: ${n}`);
  }
  return n;
}

/** Same as `toCents` but returns `fallback` instead of throwing. */
export function toCentsOr(value: unknown, fallback = 0): number {
  try {
    return toCents(value);
  } catch {
    return fallback;
  }
}

/** Clamp to a non-negative amount. Costs and discounts are never negative. */
export function nonNegative(cents: number): number {
  return cents < 0 ? 0 : cents;
}

/**
 * Round half-up, away from zero, to the nearest cent.
 *
 * `Math.round` rounds -0.5 to -0 (half-up toward +∞), which makes
 * a negative amount round differently from its positive twin. Money
 * reporting must be sign-symmetric, so this mirrors the magnitude.
 */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * `cents` × `bp` basis points, rounded half-up to the cent.
 *
 * Mirrors the SQL `(amount * bp + 5000) / 10000` in
 * 040_commerce_core.sql. The two are pinned together by
 * calculations.test.ts so a change in one without the other is a
 * failing test rather than a silent penny drift between the
 * optimistic UI preview and the stored total.
 */
export function applyPercent(cents: number, bp: BasisPoints): number {
  if (!Number.isFinite(bp)) {
    throw new MoneyError(`Not a finite basis-point value: ${bp}`);
  }
  return roundHalfUp((cents * bp) / 10_000);
}

/**
 * Margin as basis points of net revenue. Returns 0 when there is no
 * revenue — an undefined margin renders as "—" in the UI, and 0 keeps
 * the return type a plain number so callers don't juggle null.
 */
export function marginBp(profitCents: number, netRevenueCents: number): number {
  if (netRevenueCents === 0) return 0;
  return roundHalfUp((profitCents / netRevenueCents) * 10_000);
}

/** Integer mean, rounded half-up. Guards division by zero. */
export function averageCents(totalCents: number, count: number): number {
  if (count <= 0) return 0;
  return roundHalfUp(totalCents / count);
}

// ------------------------------------------------------------
// Parsing operator input
// ------------------------------------------------------------

/**
 * Parse a human-typed amount into cents.
 *
 * Handles the pt-BR convention (`1.234,56`), the en-US one
 * (`1,234.56`), bare integers, and a leading currency symbol. The
 * separator rule: whichever of `.` or `,` appears LAST and leaves
 * exactly 1–2 trailing digits is the decimal mark; everything else
 * is a thousands separator. That resolves `1.234` (thousands) vs
 * `1,23` (decimal) without needing a locale flag at the call site.
 *
 * Returns `null` for anything unparseable so the caller decides
 * between a validation message and a default.
 */
export function parseAmountToCents(input: string): number | null {
  if (typeof input !== 'string') return null;

  const cleaned = input.trim().replace(/[^\d.,-]/g, '');
  if (!cleaned || cleaned === '-') return null;

  const negative = cleaned.startsWith('-');
  const body = cleaned.replace(/-/g, '');
  if (!body) return null;

  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  const sepIndex = Math.max(lastDot, lastComma);

  let whole: string;
  let fraction: string;

  if (sepIndex === -1) {
    whole = body;
    fraction = '';
  } else {
    const tail = body.slice(sepIndex + 1);
    if (/^\d{1,2}$/.test(tail)) {
      whole = body.slice(0, sepIndex);
      fraction = tail;
    } else {
      // Trailing group is 3+ digits (or empty) — a thousands group.
      whole = body;
      fraction = '';
    }
  }

  whole = whole.replace(/[.,]/g, '');
  if (whole === '') whole = '0';
  if (!/^\d+$/.test(whole)) return null;
  if (fraction && !/^\d{1,2}$/.test(fraction)) return null;

  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(cents)) return null;

  return negative ? -cents : cents;
}

/**
 * Parse a human-typed percentage into basis points. `12,5` → 1250.
 */
export function parsePercentToBp(input: string): number | null {
  const asCents = parseAmountToCents(input);
  if (asCents === null) return null;
  // A percentage typed with two decimals is exactly basis points
  // once scaled by 100 — `12.50` parses to 1250 cents = 1250 bp.
  return asCents;
}

// ------------------------------------------------------------
// Formatting
// ------------------------------------------------------------

/**
 * Currency + locale defaults. Brazil-first per the brief, but read
 * from here (and overridable per call) rather than hardcoded at
 * ~40 render sites, so switching an account to another currency is
 * a props change and not a find-and-replace.
 */
export const DEFAULT_LOCALE = 'pt-BR';
export const DEFAULT_CURRENCY = 'BRL';

export interface FormatOptions {
  locale?: string;
  currency?: string;
  /** Drop the decimal part. For dense table cells and chart axes. */
  compactDecimals?: boolean;
}

export function formatCents(
  cents: number,
  { locale = DEFAULT_LOCALE, currency = DEFAULT_CURRENCY, compactDecimals = false }: FormatOptions = {}
): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: compactDecimals ? 0 : 2,
    maximumFractionDigits: compactDecimals ? 0 : 2,
  }).format(safe / 100);
}

/**
 * Axis / chip formatting: `R$ 48,9 mil`. Keeps large figures from
 * blowing out a chart gutter or a KPI tile.
 */
export function formatCentsCompact(
  cents: number,
  { locale = DEFAULT_LOCALE, currency = DEFAULT_CURRENCY }: FormatOptions = {}
): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(safe / 100);
}

/** `1250` → `12,5%`. */
export function formatBp(
  bp: number,
  { locale = DEFAULT_LOCALE }: { locale?: string } = {}
): string {
  const safe = Number.isFinite(bp) ? bp : 0;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(safe / 10_000);
}

/** Signed delta for period-over-period chips: `+12,4%`. */
export function formatDeltaBp(
  bp: number,
  { locale = DEFAULT_LOCALE }: { locale?: string } = {}
): string {
  const formatted = formatBp(Math.abs(bp), { locale });
  if (bp === 0) return formatted;
  return `${bp > 0 ? '+' : '−'}${formatted}`;
}

/**
 * Relative change from `previous` to `current`, in basis points.
 *
 * When the baseline is zero there is no meaningful percentage — any
 * growth from nothing is infinite. Returns `null` so the UI can show
 * "novo" rather than a fake +100%.
 */
export function deltaBp(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return roundHalfUp(((current - previous) / Math.abs(previous)) * 10_000);
}

/** `formatCents` for an editable input — no symbol, no grouping. */
export function centsToInputValue(cents: number): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const body = `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}
