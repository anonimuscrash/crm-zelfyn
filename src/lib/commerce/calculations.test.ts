import { describe, expect, it } from 'vitest';

import {
  calculateLine,
  calculateOrder,
  calculateProfitAndLoss,
  resolveDiscount,
  type OrderLineInput,
} from './calculations';

const line = (over: Partial<OrderLineInput> = {}): OrderLineInput => ({
  productName: 'Produto A',
  unitPriceCents: 30000,
  unitCostCents: 9000,
  quantity: 1,
  ...over,
});

describe('resolveDiscount', () => {
  it('passes a fixed amount through', () => {
    expect(resolveDiscount(30000, { kind: 'fixed', value: 4000 })).toBe(4000);
  });

  it('resolves a percentage from basis points', () => {
    expect(resolveDiscount(30000, { kind: 'percent', value: 1000 })).toBe(3000);
    expect(resolveDiscount(30000, { kind: 'percent', value: 1250 })).toBe(3750);
  });

  it('clamps to the base — a discount cannot create negative revenue', () => {
    expect(resolveDiscount(10000, { kind: 'fixed', value: 99999 })).toBe(10000);
    expect(resolveDiscount(10000, { kind: 'percent', value: 20000 })).toBe(
      10000
    );
  });

  it('clamps negatives to zero — a negative discount is a surcharge in disguise', () => {
    expect(resolveDiscount(10000, { kind: 'fixed', value: -500 })).toBe(0);
  });

  it('is zero when no discount is declared', () => {
    expect(resolveDiscount(10000, undefined)).toBe(0);
  });
});

describe('calculateLine', () => {
  it('multiplies price and cost by quantity', () => {
    const result = calculateLine(line({ quantity: 3 }));
    expect(result.grossCents).toBe(90000);
    expect(result.cogsCents).toBe(27000);
    expect(result.netCents).toBe(90000);
    expect(result.contributionCents).toBe(63000);
  });

  it('applies the line discount to the WHOLE line, not per unit', () => {
    const result = calculateLine(
      line({ quantity: 2, discount: { kind: 'fixed', value: 1000 } })
    );
    expect(result.grossCents).toBe(60000);
    expect(result.discountCents).toBe(1000);
    expect(result.netCents).toBe(59000);
  });

  it('resolves a percentage line discount against the line gross', () => {
    const result = calculateLine(
      line({ quantity: 2, discount: { kind: 'percent', value: 1000 } })
    );
    expect(result.discountCents).toBe(6000); // 10% of 60000
  });

  it('treats a zero or malformed quantity as zero rather than NaN', () => {
    expect(calculateLine(line({ quantity: 0 })).grossCents).toBe(0);
    expect(calculateLine(line({ quantity: -3 })).grossCents).toBe(0);
    expect(calculateLine(line({ quantity: 2.7 })).quantity).toBe(2);
  });
});

describe('calculateOrder — the worked example from the brief (§11)', () => {
  // Preço 300, desconto 40, receita 260, custo 90, frete 25, taxa 5
  // → lucro 140.
  const totals = calculateOrder({
    lines: [
      line({
        unitPriceCents: 30000,
        unitCostCents: 9000,
        quantity: 1,
        discount: { kind: 'fixed', value: 4000 },
      }),
    ],
    shippingCostCents: 2500,
    paymentFeeCents: 500,
  });

  it('reaches the stated revenue', () => {
    expect(totals.grossCents).toBe(30000);
    expect(totals.discountTotalCents).toBe(4000);
    expect(totals.netRevenueCents).toBe(26000);
  });

  it('reaches the stated profit', () => {
    expect(totals.cogsCents).toBe(9000);
    expect(totals.directCostsCents).toBe(12000); // 9000 + 2500 + 500
    expect(totals.grossProfitCents).toBe(14000); // R$ 140,00
  });

  it('reports the margin against net revenue', () => {
    expect(totals.marginBp).toBe(5385); // 53.85%
  });
});

describe('calculateOrder — multi-line', () => {
  const totals = calculateOrder({
    lines: [
      line({ unitPriceCents: 30000, unitCostCents: 9000, quantity: 2 }),
      line({
        productName: 'Produto B',
        unitPriceCents: 15000,
        unitCostCents: 6000,
        quantity: 3,
        discount: { kind: 'percent', value: 1000 },
      }),
    ],
    shippingCostCents: 3000,
  });

  it('sums every line', () => {
    expect(totals.grossCents).toBe(105000); // 60000 + 45000
    expect(totals.itemDiscountCents).toBe(4500); // 10% of 45000
    expect(totals.cogsCents).toBe(36000); // 18000 + 18000
    expect(totals.itemCount).toBe(5);
  });

  it('lands the right net and profit', () => {
    expect(totals.netRevenueCents).toBe(100500);
    expect(totals.directCostsCents).toBe(39000);
    expect(totals.grossProfitCents).toBe(61500);
  });
});

describe('calculateOrder — discount stacking (the double-discount trap)', () => {
  // A 10% ORDER discount must apply to the subtotal AFTER line
  // discounts, not to the original gross. Getting this backwards is
  // how the dashboard stops reconciling with the order list.
  const totals = calculateOrder({
    lines: [
      line({
        unitPriceCents: 100000,
        unitCostCents: 40000,
        quantity: 1,
        discount: { kind: 'fixed', value: 20000 },
      }),
    ],
    discount: { kind: 'percent', value: 1000 },
  });

  it('applies the order discount to the post-line-discount subtotal', () => {
    expect(totals.itemDiscountCents).toBe(20000);
    // 10% of 80000, NOT 10% of 100000.
    expect(totals.orderDiscountCents).toBe(8000);
    expect(totals.discountTotalCents).toBe(28000);
    expect(totals.netRevenueCents).toBe(72000);
  });

  it('reports the effective discount rate against gross', () => {
    expect(totals.discountRateBp).toBe(2800); // 28%
  });
});

describe('calculateOrder — edge cases', () => {
  it('returns an all-zero rollup for an empty order without dividing by zero', () => {
    const totals = calculateOrder({ lines: [] });
    expect(totals.grossCents).toBe(0);
    expect(totals.netRevenueCents).toBe(0);
    expect(totals.grossProfitCents).toBe(0);
    expect(totals.marginBp).toBe(0);
    expect(totals.discountRateBp).toBe(0);
  });

  it('books a negative profit when costs exceed revenue', () => {
    const totals = calculateOrder({
      lines: [line({ unitPriceCents: 10000, unitCostCents: 9000 })],
      shippingCostCents: 3000,
    });
    expect(totals.grossProfitCents).toBe(-2000);
    expect(totals.marginBp).toBe(-2000);
  });

  it('never lets a 100%+ discount push revenue below zero', () => {
    const totals = calculateOrder({
      lines: [line({ unitPriceCents: 10000, unitCostCents: 0 })],
      discount: { kind: 'fixed', value: 99999 },
    });
    expect(totals.netRevenueCents).toBe(0);
    expect(totals.orderDiscountCents).toBe(10000);
  });

  it('folds extra per-order costs into direct costs', () => {
    const totals = calculateOrder({
      lines: [line({ unitPriceCents: 30000, unitCostCents: 0 })],
      extraCosts: [
        { label: 'Embalagem', amountCents: 500 },
        { label: 'Brinde', amountCents: 1500 },
      ],
    });
    expect(totals.otherCostsCents).toBe(2000);
    expect(totals.grossProfitCents).toBe(28000);
  });
});

describe('calculateProfitAndLoss — the two-stage statement (§18)', () => {
  const pl = calculateProfitAndLoss({
    grossCents: 10_000_00,
    discountCents: 500_00,
    cogsCents: 3_000_00,
    shippingCents: 400_00,
    feesCents: 200_00,
    otherDirectCostsCents: 100_00,
    operatingExpensesCents: 2_000_00,
    orderCount: 40,
  });

  it('separates direct sale costs from operational overhead', () => {
    expect(pl.netRevenueCents).toBe(9_500_00);
    expect(pl.directCostsCents).toBe(3_700_00);
    expect(pl.grossProfitCents).toBe(5_800_00);
    // Overhead lands only in the SECOND subtraction.
    expect(pl.operatingProfitCents).toBe(3_800_00);
  });

  it('reports both margins against net revenue', () => {
    expect(pl.grossMarginBp).toBe(6105); // 61.05%
    expect(pl.operatingMarginBp).toBe(4000); // 40%
  });

  it('computes the average ticket', () => {
    expect(pl.avgTicketCents).toBe(23_750);
  });

  it('survives a period with no orders at all', () => {
    const empty = calculateProfitAndLoss({
      grossCents: 0,
      discountCents: 0,
      cogsCents: 0,
      shippingCents: 0,
      feesCents: 0,
      otherDirectCostsCents: 0,
      operatingExpensesCents: 50_00,
      orderCount: 0,
    });
    expect(empty.netRevenueCents).toBe(0);
    expect(empty.grossProfitCents).toBe(0);
    // Expenses with no sales is a real, reportable loss.
    expect(empty.operatingProfitCents).toBe(-50_00);
    expect(empty.avgTicketCents).toBe(0);
    expect(empty.grossMarginBp).toBe(0);
  });
});
