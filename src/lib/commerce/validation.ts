// ============================================================
// Request-body validation for the commerce endpoints.
//
// Hand-rolled rather than adding a schema library: the project has
// no runtime validator today, and the surface here is small and
// money-shaped, which wants explicit rules more than it wants
// generic combinators.
//
// The rule this file enforces above all (§27): every monetary value
// is re-validated on the SERVER. A client that posts
// `unit_price_cents: 19.99` or a negative cost gets a 400 — the
// database's CHECK constraints are the last line, not the first.
// ============================================================

import { isOrderStatus, type OrderStatus } from './order-status';
import type {
  CreateOrderInput,
  CreateOrderItemInput,
  DiscountKind,
  ExpenseInput,
  ProductInput,
} from './types';

export class ValidationError extends Error {
  readonly status = 400 as const;
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

// ------------------------------------------------------------
// Primitives
// ------------------------------------------------------------

function asObject(value: unknown, label = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`, label);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  field: string,
  { max = 500 }: { max?: number } = {}
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} is required`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ValidationError(`${field} exceeds ${max} characters`, field);
  }
  return trimmed;
}

function optionalString(
  value: unknown,
  field: string,
  { max = 2000 }: { max?: number } = {}
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`, field);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new ValidationError(`${field} exceeds ${max} characters`, field);
  }
  return trimmed;
}

/**
 * A monetary amount, in cents. Must be a non-negative safe integer.
 *
 * The upper bound is not paranoia: an operator fat-fingering an extra
 * three zeros should be told, not have it silently poison every
 * average and margin in the account's reporting for that period.
 */
const MAX_CENTS = 1_000_000_000_00; // R$ 1 billion

export function requiredCents(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ValidationError(`${field} must be a number of cents`, field);
  }
  if (!Number.isInteger(n)) {
    throw new ValidationError(
      `${field} must be an integer number of cents (got ${n})`,
      field
    );
  }
  if (n < 0) {
    throw new ValidationError(`${field} cannot be negative`, field);
  }
  if (n > MAX_CENTS) {
    throw new ValidationError(`${field} is implausibly large`, field);
  }
  return n;
}

export function optionalCents(
  value: unknown,
  field: string,
  fallback = 0
): number {
  if (value === undefined || value === null || value === '') return fallback;
  return requiredCents(value, field);
}

function positiveInt(value: unknown, field: string, max = 1_000_000): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`${field} must be a positive integer`, field);
  }
  if (n > max) {
    throw new ValidationError(`${field} exceeds the maximum of ${max}`, field);
  }
  return n;
}

function discountKind(value: unknown, field: string): DiscountKind {
  if (value === undefined || value === null) return 'fixed';
  if (value !== 'fixed' && value !== 'percent') {
    throw new ValidationError(`${field} must be 'fixed' or 'percent'`, field);
  }
  return value;
}

/**
 * A discount's raw value: cents when fixed, basis points when
 * percent. A percentage above 100% is rejected here rather than
 * clamped, so the operator learns their input was wrong instead of
 * wondering why a 500% discount produced a free order.
 */
function discountValue(
  value: unknown,
  kind: DiscountKind,
  field: string
): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`, field);
  }
  if (kind === 'percent' && n > 10_000) {
    throw new ValidationError(`${field} cannot exceed 100%`, field);
  }
  if (kind === 'fixed' && n > MAX_CENTS) {
    throw new ValidationError(`${field} is implausibly large`, field);
  }
  return n;
}

function uuidOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw new ValidationError(`${field} must be a UUID`, field);
  }
  return value;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${field} must be a YYYY-MM-DD date`, field);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`${field} is not a valid date`, field);
  }
  return value;
}

function isoTimestampOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be an ISO timestamp`, field);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`${field} is not a valid timestamp`, field);
  }
  return d.toISOString();
}

// ------------------------------------------------------------
// Products
// ------------------------------------------------------------

export function parseProductInput(body: unknown): ProductInput {
  const b = asObject(body);

  const stockRaw = b.stock_quantity;
  let stock: number | null = null;
  if (stockRaw !== undefined && stockRaw !== null && stockRaw !== '') {
    const n = typeof stockRaw === 'string' ? Number(stockRaw) : stockRaw;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new ValidationError(
        'stock_quantity must be a non-negative integer, or null to stop tracking',
        'stock_quantity'
      );
    }
    stock = n;
  }

  return {
    name: requiredString(b.name, 'name', { max: 200 }),
    sku: optionalString(b.sku, 'sku', { max: 64 }),
    description: optionalString(b.description, 'description'),
    category: optionalString(b.category, 'category', { max: 100 }),
    unit_cost_cents: optionalCents(b.unit_cost_cents, 'unit_cost_cents'),
    unit_price_cents: optionalCents(b.unit_price_cents, 'unit_price_cents'),
    is_active: b.is_active === undefined ? true : Boolean(b.is_active),
    image_url: optionalString(b.image_url, 'image_url', { max: 2000 }),
    stock_quantity: stock,
    notes: optionalString(b.notes, 'notes'),
  };
}

// ------------------------------------------------------------
// Orders
// ------------------------------------------------------------

const MAX_ITEMS_PER_ORDER = 200;

function parseOrderItem(raw: unknown, index: number): CreateOrderItemInput {
  const b = asObject(raw, `items[${index}]`);
  const kind = discountKind(b.discount_kind, `items[${index}].discount_kind`);

  const productId = uuidOrNull(b.product_id, `items[${index}].product_id`);
  const name = optionalString(b.product_name, `items[${index}].product_name`, {
    max: 200,
  });

  // A line must identify what was sold, one way or the other. An
  // anonymous line would produce an unattributable revenue row that
  // the product ranking could never explain.
  if (!productId && !name) {
    throw new ValidationError(
      `items[${index}] needs a product_id or a product_name`,
      `items[${index}]`
    );
  }

  return {
    product_id: productId,
    product_name: name ?? undefined,
    product_sku: optionalString(b.product_sku, `items[${index}].product_sku`, {
      max: 64,
    }),
    unit_price_cents:
      b.unit_price_cents === undefined || b.unit_price_cents === null
        ? undefined
        : requiredCents(b.unit_price_cents, `items[${index}].unit_price_cents`),
    unit_cost_cents:
      b.unit_cost_cents === undefined || b.unit_cost_cents === null
        ? undefined
        : requiredCents(b.unit_cost_cents, `items[${index}].unit_cost_cents`),
    quantity: positiveInt(b.quantity ?? 1, `items[${index}].quantity`, 100_000),
    discount_kind: kind,
    discount_value: discountValue(
      b.discount_value,
      kind,
      `items[${index}].discount_value`
    ),
  };
}

export function parseCreateOrderInput(body: unknown): CreateOrderInput {
  const b = asObject(body);

  if (!Array.isArray(b.items) || b.items.length === 0) {
    throw new ValidationError('An order needs at least one item', 'items');
  }
  if (b.items.length > MAX_ITEMS_PER_ORDER) {
    throw new ValidationError(
      `An order cannot exceed ${MAX_ITEMS_PER_ORDER} items`,
      'items'
    );
  }

  let status: OrderStatus = 'new';
  if (b.status !== undefined && b.status !== null) {
    if (!isOrderStatus(b.status)) {
      throw new ValidationError(`Unknown status: ${String(b.status)}`, 'status');
    }
    status = b.status;
  }

  const kind = discountKind(b.discount_kind, 'discount_kind');

  const extraCosts: { label: string; amount_cents: number }[] = [];
  if (b.extra_costs !== undefined && b.extra_costs !== null) {
    if (!Array.isArray(b.extra_costs)) {
      throw new ValidationError('extra_costs must be an array', 'extra_costs');
    }
    b.extra_costs.forEach((raw, i) => {
      const c = asObject(raw, `extra_costs[${i}]`);
      extraCosts.push({
        label: requiredString(c.label, `extra_costs[${i}].label`, { max: 120 }),
        amount_cents: optionalCents(
          c.amount_cents,
          `extra_costs[${i}].amount_cents`
        ),
      });
    });
  }

  return {
    contact_id: uuidOrNull(b.contact_id, 'contact_id'),
    seller_user_id: uuidOrNull(b.seller_user_id, 'seller_user_id'),
    status,
    discount_kind: kind,
    discount_value: discountValue(b.discount_value, kind, 'discount_value'),
    shipping_cost_cents: optionalCents(
      b.shipping_cost_cents,
      'shipping_cost_cents'
    ),
    payment_fee_cents: optionalCents(b.payment_fee_cents, 'payment_fee_cents'),
    shipping_carrier: optionalString(b.shipping_carrier, 'shipping_carrier', {
      max: 120,
    }),
    tracking_code: optionalString(b.tracking_code, 'tracking_code', {
      max: 120,
    }),
    notes: optionalString(b.notes, 'notes'),
    ordered_at: isoTimestampOrNull(b.ordered_at, 'ordered_at') ?? undefined,
    items: b.items.map(parseOrderItem),
    extra_costs: extraCosts,
  };
}

/** Partial update for the order header. Never touches derived totals. */
export interface OrderPatch {
  status?: OrderStatus;
  contact_id?: string | null;
  seller_user_id?: string | null;
  discount_kind?: DiscountKind;
  discount_value?: number;
  shipping_cost_cents?: number;
  payment_fee_cents?: number;
  shipping_carrier?: string | null;
  tracking_code?: string | null;
  notes?: string | null;
  ordered_at?: string;
}

/** Derived columns a client must never be allowed to set directly. */
const DERIVED_COLUMNS = [
  'gross_cents',
  'item_discount_cents',
  'discount_total_cents',
  'net_revenue_cents',
  'cogs_cents',
  'other_costs_cents',
  'direct_costs_cents',
  'gross_profit_cents',
  'item_count',
  'order_number',
  'account_id',
] as const;

export function parseOrderPatch(body: unknown): OrderPatch {
  const b = asObject(body);

  for (const col of DERIVED_COLUMNS) {
    if (col in b) {
      throw new ValidationError(
        `${col} is derived and cannot be set directly`,
        col
      );
    }
  }

  const patch: OrderPatch = {};

  if (b.status !== undefined) {
    if (!isOrderStatus(b.status)) {
      throw new ValidationError(`Unknown status: ${String(b.status)}`, 'status');
    }
    patch.status = b.status;
  }
  if ('contact_id' in b) patch.contact_id = uuidOrNull(b.contact_id, 'contact_id');
  if ('seller_user_id' in b) {
    patch.seller_user_id = uuidOrNull(b.seller_user_id, 'seller_user_id');
  }
  if ('discount_kind' in b || 'discount_value' in b) {
    const kind = discountKind(b.discount_kind, 'discount_kind');
    patch.discount_kind = kind;
    patch.discount_value = discountValue(
      b.discount_value,
      kind,
      'discount_value'
    );
  }
  if ('shipping_cost_cents' in b) {
    patch.shipping_cost_cents = optionalCents(
      b.shipping_cost_cents,
      'shipping_cost_cents'
    );
  }
  if ('payment_fee_cents' in b) {
    patch.payment_fee_cents = optionalCents(
      b.payment_fee_cents,
      'payment_fee_cents'
    );
  }
  if ('shipping_carrier' in b) {
    patch.shipping_carrier = optionalString(
      b.shipping_carrier,
      'shipping_carrier',
      { max: 120 }
    );
  }
  if ('tracking_code' in b) {
    patch.tracking_code = optionalString(b.tracking_code, 'tracking_code', {
      max: 120,
    });
  }
  if ('notes' in b) patch.notes = optionalString(b.notes, 'notes');
  if ('ordered_at' in b) {
    const ts = isoTimestampOrNull(b.ordered_at, 'ordered_at');
    if (ts) patch.ordered_at = ts;
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError('Nothing to update');
  }

  return patch;
}

// ------------------------------------------------------------
// Expenses
// ------------------------------------------------------------

export function parseExpenseInput(body: unknown): ExpenseInput {
  const b = asObject(body);

  let recurrence: ExpenseInput['recurrence'] = null;
  if (b.recurrence !== undefined && b.recurrence !== null && b.recurrence !== '') {
    if (
      b.recurrence !== 'monthly' &&
      b.recurrence !== 'weekly' &&
      b.recurrence !== 'yearly'
    ) {
      throw new ValidationError(
        "recurrence must be 'monthly', 'weekly' or 'yearly'",
        'recurrence'
      );
    }
    recurrence = b.recurrence;
  }

  const isRecurring = Boolean(b.is_recurring);
  if (isRecurring && !recurrence) {
    throw new ValidationError(
      'A recurring expense needs a recurrence interval',
      'recurrence'
    );
  }

  return {
    description: requiredString(b.description, 'description', { max: 300 }),
    amount_cents: requiredCents(b.amount_cents, 'amount_cents'),
    category_id: uuidOrNull(b.category_id, 'category_id'),
    incurred_on: isoDate(
      b.incurred_on ?? new Date().toISOString().slice(0, 10),
      'incurred_on'
    ),
    supplier: optionalString(b.supplier, 'supplier', { max: 200 }),
    payment_method: optionalString(b.payment_method, 'payment_method', {
      max: 100,
    }),
    notes: optionalString(b.notes, 'notes'),
    is_recurring: isRecurring,
    recurrence,
  };
}
