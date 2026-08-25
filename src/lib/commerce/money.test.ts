import { describe, expect, it } from 'vitest';

import {
  applyPercent,
  averageCents,
  centsToInputValue,
  deltaBp,
  formatBp,
  formatCents,
  formatDeltaBp,
  marginBp,
  MoneyError,
  nonNegative,
  parseAmountToCents,
  parsePercentToBp,
  roundHalfUp,
  toCents,
  toCentsOr,
} from './money';

describe('toCents', () => {
  it('accepts integer cents and numeric strings', () => {
    expect(toCents(1999)).toBe(1999);
    expect(toCents('1999')).toBe(1999);
    expect(toCents(0)).toBe(0);
    expect(toCents(-500)).toBe(-500);
  });

  it('rejects fractional cents — a half-cent is not a value we can store', () => {
    expect(() => toCents(19.99)).toThrow(MoneyError);
    expect(() => toCents(0.5)).toThrow(MoneyError);
  });

  it('rejects NaN and Infinity rather than coercing them to 0', () => {
    expect(() => toCents(NaN)).toThrow(MoneyError);
    expect(() => toCents(Infinity)).toThrow(MoneyError);
    expect(() => toCents('abc')).toThrow(MoneyError);
    expect(() => toCents(null)).toThrow(MoneyError);
    expect(() => toCents(undefined)).toThrow(MoneyError);
  });

  it('rejects amounts past the safe integer bound', () => {
    expect(() => toCents(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });

  it('toCentsOr swallows the error and returns the fallback', () => {
    expect(toCentsOr('nope', 42)).toBe(42);
    expect(toCentsOr(19.99, 0)).toBe(0);
    expect(toCentsOr(1999, 0)).toBe(1999);
  });
});

describe('roundHalfUp', () => {
  it('rounds .5 away from zero, symmetrically for both signs', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3);
    // The reason this exists: Math.round(-0.5) is -0, which breaks
    // sign symmetry for money.
    expect(roundHalfUp(-0.5)).toBe(-1);
    expect(roundHalfUp(-1.5)).toBe(-2);
    expect(roundHalfUp(-2.5)).toBe(-3);
  });

  it('leaves integers untouched', () => {
    expect(roundHalfUp(7)).toBe(7);
    expect(roundHalfUp(-7)).toBe(-7);
  });
});

describe('applyPercent', () => {
  it('applies basis points', () => {
    expect(applyPercent(10000, 1000)).toBe(1000); // 10% of R$100
    expect(applyPercent(10000, 1250)).toBe(1250); // 12.5%
    expect(applyPercent(30000, 10000)).toBe(30000); // 100%
    expect(applyPercent(30000, 0)).toBe(0);
  });

  it('rounds half-up at the cent, matching the SQL formula', () => {
    // 333 cents × 50% = 166.5 → 167, same as (333*5000+5000)/10000 in SQL.
    expect(applyPercent(333, 5000)).toBe(167);
    // 1 cent × 50% = 0.5 → 1.
    expect(applyPercent(1, 5000)).toBe(1);
    // 99 cents × 33.33% = 32.9967 → 33.
    expect(applyPercent(99, 3333)).toBe(33);
  });

  it('rejects a non-finite rate', () => {
    expect(() => applyPercent(100, NaN)).toThrow(MoneyError);
  });
});

describe('marginBp', () => {
  it('expresses profit over revenue in basis points', () => {
    expect(marginBp(14000, 26000)).toBe(5385); // 53.85%
    expect(marginBp(5000, 10000)).toBe(5000); // 50%
    expect(marginBp(10000, 10000)).toBe(10000); // 100%
  });

  it('returns 0 for zero revenue instead of dividing by zero', () => {
    expect(marginBp(0, 0)).toBe(0);
    expect(marginBp(500, 0)).toBe(0);
  });

  it('handles a loss-making order', () => {
    expect(marginBp(-2000, 10000)).toBe(-2000); // -20%
  });
});

describe('averageCents', () => {
  it('computes an integer mean, rounded half-up', () => {
    expect(averageCents(30000, 3)).toBe(10000);
    expect(averageCents(10000, 3)).toBe(3333);
    expect(averageCents(100, 8)).toBe(13); // 12.5 → 13
  });

  it('returns 0 for a zero or negative count', () => {
    expect(averageCents(5000, 0)).toBe(0);
    expect(averageCents(5000, -1)).toBe(0);
  });
});

describe('nonNegative', () => {
  it('clamps negatives to zero and leaves the rest alone', () => {
    expect(nonNegative(-1)).toBe(0);
    expect(nonNegative(0)).toBe(0);
    expect(nonNegative(250)).toBe(250);
  });
});

describe('parseAmountToCents', () => {
  it('parses pt-BR notation', () => {
    expect(parseAmountToCents('1.234,56')).toBe(123456);
    expect(parseAmountToCents('19,99')).toBe(1999);
    expect(parseAmountToCents('0,05')).toBe(5);
    expect(parseAmountToCents('1.000')).toBe(100000);
  });

  it('parses en-US notation', () => {
    expect(parseAmountToCents('1,234.56')).toBe(123456);
    expect(parseAmountToCents('19.99')).toBe(1999);
  });

  it('parses bare integers and one-decimal input', () => {
    expect(parseAmountToCents('300')).toBe(30000);
    expect(parseAmountToCents('19,9')).toBe(1990);
  });

  it('strips currency symbols and whitespace', () => {
    expect(parseAmountToCents('R$ 1.234,56')).toBe(123456);
    expect(parseAmountToCents('  300  ')).toBe(30000);
  });

  it('handles negatives', () => {
    expect(parseAmountToCents('-19,99')).toBe(-1999);
  });

  it('returns null for unparseable input rather than guessing', () => {
    expect(parseAmountToCents('')).toBeNull();
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents('-')).toBeNull();
    expect(parseAmountToCents('R$')).toBeNull();
  });

  it('treats a 3-digit trailing group as thousands, not decimals', () => {
    // The ambiguity this rule exists to settle: 1.234 is one thousand
    // two hundred thirty four, not one and 234 thousandths.
    expect(parseAmountToCents('1.234')).toBe(123400);
    expect(parseAmountToCents('1,234')).toBe(123400);
  });
});

describe('parsePercentToBp', () => {
  it('maps a typed percentage onto basis points', () => {
    expect(parsePercentToBp('10')).toBe(1000);
    expect(parsePercentToBp('12,5')).toBe(1250);
    expect(parsePercentToBp('100')).toBe(10000);
    expect(parsePercentToBp('0')).toBe(0);
  });
});

describe('deltaBp', () => {
  it('computes relative change in basis points', () => {
    expect(deltaBp(11240, 10000)).toBe(1240); // +12.4%
    expect(deltaBp(9000, 10000)).toBe(-1000); // -10%
    expect(deltaBp(10000, 10000)).toBe(0);
  });

  it('returns null when the baseline is zero — growth from nothing has no rate', () => {
    expect(deltaBp(5000, 0)).toBeNull();
    expect(deltaBp(0, 0)).toBeNull();
  });
});

describe('formatting', () => {
  // Intl output uses a non-breaking space between symbol and digits;
  // normalise so the assertions read plainly.
  const norm = (s: string) => s.replace(/\u00a0/g, ' ');

  it('formats cents as BRL by default', () => {
    expect(norm(formatCents(123456))).toBe('R$ 1.234,56');
    expect(norm(formatCents(0))).toBe('R$ 0,00');
    expect(norm(formatCents(-1999))).toBe('-R$ 19,99');
  });

  it('honours an explicit currency and locale', () => {
    expect(norm(formatCents(123456, { locale: 'en-US', currency: 'USD' }))).toBe(
      '$1,234.56'
    );
  });

  it('drops decimals when asked', () => {
    expect(norm(formatCents(123456, { compactDecimals: true }))).toBe(
      'R$ 1.235'
    );
  });

  it('falls back to zero for a non-finite amount instead of rendering NaN', () => {
    expect(norm(formatCents(NaN))).toBe('R$ 0,00');
  });

  it('formats basis points as a percentage', () => {
    expect(formatBp(1250)).toBe('12,5%');
    expect(formatBp(0)).toBe('0,0%');
    expect(formatBp(10000)).toBe('100,0%');
  });

  it('signs a delta chip', () => {
    expect(formatDeltaBp(1240)).toBe('+12,4%');
    expect(formatDeltaBp(-1000)).toBe('−10,0%');
    expect(formatDeltaBp(0)).toBe('0,0%');
  });

  it('renders an editable input value without symbol or grouping', () => {
    expect(centsToInputValue(123456)).toBe('1234,56');
    expect(centsToInputValue(5)).toBe('0,05');
    expect(centsToInputValue(0)).toBe('0,00');
    expect(centsToInputValue(-1999)).toBe('-19,99');
  });
});

describe('round-trip: parse → format', () => {
  it('survives a parse/format cycle for typical operator input', () => {
    const inputs = ['300', '19,99', '1.234,56', '0,05', '99.999,99'];
    for (const raw of inputs) {
      const cents = parseAmountToCents(raw);
      expect(cents).not.toBeNull();
      expect(parseAmountToCents(centsToInputValue(cents as number))).toBe(cents);
    }
  });
});
