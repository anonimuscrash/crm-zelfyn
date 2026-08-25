// ============================================================
// Order status — the Kanban columns, and which of them count as
// realised revenue.
//
// This list MIRRORS two database objects from 040_commerce_core.sql:
//   * the CHECK constraint on orders.status
//   * the order_status_is_revenue(TEXT) function
//
// order-status.test.ts parses that SQL file and asserts both stay in
// sync with the constants below. If someone adds a status in SQL and
// forgets the TypeScript (or vice versa), the test fails rather than
// the dashboard quietly under-counting a whole column of orders.
// ============================================================

export const ORDER_STATUSES = [
  'new',
  'paid',
  'preparing',
  'awaiting_shipment',
  'shipped',
  'delivered',
  'completed',
  'problem',
  'cancelled',
  'refunded',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Statuses whose money counts. Cancelled and refunded orders remain
 * queryable (operators need the cancellation rate) but contribute
 * nothing to revenue, COGS, or profit.
 */
export const REVENUE_STATUSES: readonly OrderStatus[] = [
  'new',
  'paid',
  'preparing',
  'awaiting_shipment',
  'shipped',
  'delivered',
  'completed',
  'problem',
] as const;

export function isRevenueStatus(status: OrderStatus): boolean {
  return (REVENUE_STATUSES as readonly string[]).includes(status);
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === 'string' &&
    (ORDER_STATUSES as readonly string[]).includes(value)
  );
}

/** Orders that still need something done to them physically. */
export const OPEN_FULFILMENT_STATUSES: readonly OrderStatus[] = [
  'new',
  'paid',
  'preparing',
  'awaiting_shipment',
] as const;

/**
 * Visual weight per column. Deliberately restrained: a neutral
 * slate for the working states, a single institutional accent for
 * money-in, muted amber for "needs attention", muted red only for
 * the two terminal-negative states. No column gets a saturated fill
 * — a board where everything shouts tells the operator nothing.
 *
 * Tokens are Tailwind classes rather than raw hex so both themes
 * (light / dark) resolve correctly from globals.css.
 */
export interface OrderStatusMeta {
  /** i18n key under the `Orders.status` namespace. */
  labelKey: string;
  /** Dot / chip colour classes. */
  chipClass: string;
  dotClass: string;
}

export const ORDER_STATUS_META: Record<OrderStatus, OrderStatusMeta> = {
  new: {
    labelKey: 'new',
    chipClass: 'border-border bg-muted text-muted-foreground',
    dotClass: 'bg-slate-400',
  },
  paid: {
    labelKey: 'paid',
    chipClass: 'border-emerald-600/25 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
    dotClass: 'bg-emerald-600',
  },
  preparing: {
    labelKey: 'preparing',
    chipClass: 'border-border bg-muted text-foreground',
    dotClass: 'bg-slate-500',
  },
  awaiting_shipment: {
    labelKey: 'awaitingShipment',
    chipClass: 'border-amber-600/25 bg-amber-600/10 text-amber-700 dark:text-amber-400',
    dotClass: 'bg-amber-500',
  },
  shipped: {
    labelKey: 'shipped',
    chipClass: 'border-primary/25 bg-primary/10 text-primary',
    dotClass: 'bg-primary',
  },
  delivered: {
    labelKey: 'delivered',
    chipClass: 'border-emerald-600/25 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
    dotClass: 'bg-emerald-500',
  },
  completed: {
    labelKey: 'completed',
    chipClass: 'border-emerald-700/30 bg-emerald-700/12 text-emerald-800 dark:text-emerald-300',
    dotClass: 'bg-emerald-700',
  },
  problem: {
    labelKey: 'problem',
    chipClass: 'border-amber-700/30 bg-amber-700/10 text-amber-800 dark:text-amber-300',
    dotClass: 'bg-amber-600',
  },
  cancelled: {
    labelKey: 'cancelled',
    chipClass: 'border-red-600/25 bg-red-600/8 text-red-700 dark:text-red-400',
    dotClass: 'bg-red-500',
  },
  refunded: {
    labelKey: 'refunded',
    chipClass: 'border-red-600/25 bg-red-600/8 text-red-700 dark:text-red-400',
    dotClass: 'bg-red-600',
  },
};

/**
 * Column order on the Kanban. Same sequence as ORDER_STATUSES —
 * kept as its own export so the board can later hide columns (e.g.
 * collapse `refunded`) without reordering the canonical list.
 */
export const KANBAN_COLUMNS: readonly OrderStatus[] = ORDER_STATUSES;
