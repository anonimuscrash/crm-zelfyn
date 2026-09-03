// ============================================================
// Order arithmetic.
//
// This module is a FAITHFUL MIRROR of recalculate_order_totals()
// in 040_commerce_core.sql. The database remains the authority —
// what it stores is what the reports read. This exists so the sale
// form can show a live total as the operator types, without a round
// trip per keystroke.
//
// Because there are two implementations of one rule, they must not
// drift. calculations.test.ts encodes the shared cases (including
// the rounding edges) and order-status.test.ts pins the status
// vocabulary to the SQL file. If the SQL formula changes, the tests
// here should fail first.
//
// Pure functions only: no I/O, no dates, no Supabase.
// ============================================================

import {
  applyPercent,
  averageCents,
  marginBp,
  nonNegative,
  type BasisPoints,
} from './money';

export type DiscountKind = 'fixed' | 'percent';

export interface DiscountInput {
  kind: DiscountKind;
  /** Cents when kind === 'fixed'; basis points when kind === 'percent'. */
  value: number;
}

export interface OrderLineInput {
  productId?: string | null;
  productName: string;
  productSku?: string | null;
  unitPriceCents: number;
  unitCostCents: number;
  quantity: number;
  discount?: DiscountInput;
}

export interface ExtraCostInput {
  label: string;
  amountCents: number;
}

export interface OrderInput {
  lines: OrderLineInput[];
  /** Discount applied to the post-line-discount subtotal. */
  discount?: DiscountInput;
  shippingCostCents?: number;
  paymentFeeCents?: number;
  extraCosts?: ExtraCostInput[];
}

export interface OrderLineTotals {
  productName: string;
  quantity: number;
  /** unitPrice × quantity, before any discount. */
  grossCents: number;
  discountCents: number;
  /** grossCents − discountCents. */
  netCents: number;
  cogsCents: number;
  /** netCents − cogsCents. Excludes order-level shipping/fees. */
  contributionCents: number;
}

export interface OrderTotals {
  lines: OrderLineTotals[];
  grossCents: number;
  itemDiscountCents: number;
  orderDiscountCents: number;
  discountTotalCents: number;
  netRevenueCents: number;
  cogsCents: number;
  shippingCostCents: number;
  paymentFeeCents: number;
  otherCostsCents: number;
  directCostsCents: number;
  /** netRevenue − directCosts. The profit of THIS sale. */
  grossProfitCents: number;
  /** grossProfit ÷ netRevenue, in basis points. */
  marginBp: BasisPoints;
  itemCount: number;
  /** Effective discount rate against gross, in basis points. */
  discountRateBp: BasisPoints;
}

/**
 * Resolve a discount declaration into a cash amount, clamped to
 * [0, base]. A discount can never exceed what is being discounted
 * (that would book negative revenue) and can never be negative
 * (that would be a surcharge wearing a discount's clothes).
 *
 * Same clamp as the SQL: `LEAST(GREATEST(v, 0), subtotal)`.
 */
export function resolveDiscount(
  baseCents: number,
  discount: DiscountInput | undefined
): number {
  if (!discount) return 0;
  const raw =
    discount.kind === 'percent'
      ? applyPercent(baseCents, discount.value)
      : discount.value;
  return Math.min(nonNegative(raw), nonNegative(baseCents));
}

/** One line's numbers. Line discount applies to the whole line, not per unit. */
export function calculateLine(line: OrderLineInput): OrderLineTotals {
  const quantity = Math.max(Math.trunc(line.quantity) || 0, 0);
  const grossCents = nonNegative(line.unitPriceCents) * quantity;
  const discountCents = resolveDiscount(grossCents, line.discount);
  const netCents = grossCents - discountCents;
  const cogsCents = nonNegative(line.unitCostCents) * quantity;

  return {
    productName: line.productName,
    quantity,
    grossCents,
    discountCents,
    netCents,
    cogsCents,
    contributionCents: netCents - cogsCents,
  };
}

/**
 * Full order rollup. Order of operations is load-bearing and matches
 * the SQL exactly:
 *
 *   1. sum lines → gross, line discounts, COGS
 *   2. subtotal = gross − lineDiscounts
 *   3. order discount resolved AGAINST THAT SUBTOTAL (so a 10% order
 *      discount does not also discount the part already given away
 *      at line level — double-discounting is the classic way these
 *      numbers stop reconciling)
 *   4. net = subtotal − orderDiscount
 *   5. direct costs = COGS + shipping + fee + extras
 *   6. profit = net − directCosts
 */
export function calculateOrder(input: OrderInput): OrderTotals {
  const lines = input.lines.map(calculateLine);

  const grossCents = lines.reduce((sum, l) => sum + l.grossCents, 0);
  const itemDiscountCents = lines.reduce((sum, l) => sum + l.discountCents, 0);
  const cogsCents = lines.reduce((sum, l) => sum + l.cogsCents, 0);
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);

  const subtotalCents = nonNegative(grossCents - itemDiscountCents);
  const orderDiscountCents = resolveDiscount(subtotalCents, input.discount);
  const netRevenueCents = subtotalCents - orderDiscountCents;

  const shippingCostCents = nonNegative(input.shippingCostCents ?? 0);
  const paymentFeeCents = nonNegative(input.paymentFeeCents ?? 0);
  const otherCostsCents = (input.extraCosts ?? []).reduce(
    (sum, c) => sum + nonNegative(c.amountCents),
    0
  );

  const directCostsCents =
    cogsCents + shippingCostCents + paymentFeeCents + otherCostsCents;
  const grossProfitCents = netRevenueCents - directCostsCents;
  const discountTotalCents = itemDiscountCents + orderDiscountCents;

  return {
    lines,
    grossCents,
    itemDiscountCents,
    orderDiscountCents,
    discountTotalCents,
    netRevenueCents,
    cogsCents,
    shippingCostCents,
    paymentFeeCents,
    otherCostsCents,
    directCostsCents,
    grossProfitCents,
    marginBp: marginBp(grossProfitCents, netRevenueCents),
    itemCount,
    discountRateBp:
      grossCents === 0 ? 0 : marginBp(discountTotalCents, grossCents),
  };
}

// ============================================================
// Period-level P&L
//
// The two-stage statement from §18. Kept separate from
// calculateOrder because the distinction it encodes — direct sale
// costs vs. operational overhead — is the thing the operator most
// needs to not get wrong, and it deserves its own named function
// rather than being an inline subtraction in a component.
// ============================================================

export interface ProfitAndLossInput {
  grossCents: number;
  discountCents: number;
  cogsCents: number;
  shippingCents: number;
  feesCents: number;
  otherDirectCostsCents: number;
  operatingExpensesCents: number;
  orderCount: number;
}

export interface ProfitAndLoss {
  grossCents: number;
  discountCents: number;
  netRevenueCents: number;
  cogsCents: number;
  shippingCents: number;
  feesCents: number;
  otherDirectCostsCents: number;
  directCostsCents: number;
  /** Net revenue − direct costs. */
  grossProfitCents: number;
  operatingExpensesCents: number;
  /** Gross profit − operating expenses. The bottom line. */
  operatingProfitCents: number;
  grossMarginBp: BasisPoints;
  operatingMarginBp: BasisPoints;
  avgTicketCents: number;
}

export function calculateProfitAndLoss(
  input: ProfitAndLossInput
): ProfitAndLoss {
  const netRevenueCents = input.grossCents - input.discountCents;
  const directCostsCents =
    input.cogsCents +
    input.shippingCents +
    input.feesCents +
    input.otherDirectCostsCents;
  const grossProfitCents = netRevenueCents - directCostsCents;
  const operatingProfitCents = grossProfitCents - input.operatingExpensesCents;

  return {
    grossCents: input.grossCents,
    discountCents: input.discountCents,
    netRevenueCents,
    cogsCents: input.cogsCents,
    shippingCents: input.shippingCents,
    feesCents: input.feesCents,
    otherDirectCostsCents: input.otherDirectCostsCents,
    directCostsCents,
    grossProfitCents,
    operatingExpensesCents: input.operatingExpensesCents,
    operatingProfitCents,
    grossMarginBp: marginBp(grossProfitCents, netRevenueCents),
    operatingMarginBp: marginBp(operatingProfitCents, netRevenueCents),
    avgTicketCents: averageCents(netRevenueCents, input.orderCount),
  };
}
