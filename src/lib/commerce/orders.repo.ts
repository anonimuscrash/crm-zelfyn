// ============================================================
// Orders repository.
//
// Writes that touch money go through the `commerce_create_order`
// RPC rather than a client-side sequence of inserts. Two reasons,
// both of which have teeth:
//
//   1. ATOMICITY. Header + N items + M costs is one transaction in
//      the RPC. As three PostgREST calls it is three, and a browser
//      that dies between them leaves an order with no items — which
//      reads as a R$ 0,00 sale in every report forever.
//   2. AUTHORITY. The order number and the price/cost snapshots are
//      chosen server-side. A caller cannot pick their own sequence
//      number or claim a cost of zero on a product that costs R$ 90.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { RepositoryError } from './products.repo';
import { REVENUE_STATUSES } from './order-status';
import type { OrderPatch } from './validation';
import type {
  CreateOrderInput,
  OrderListFilters,
  OrderRow,
  OrderStatus,
  OrderWithItems,
  Paginated,
} from './types';

const ORDER_COLUMNS = `
  id, account_id, order_number, contact_id,
  customer_name_snapshot, customer_phone_snapshot,
  seller_user_id, status,
  discount_kind, discount_value, order_discount_cents,
  shipping_cost_cents, payment_fee_cents,
  shipping_carrier, tracking_code, shipped_at, delivered_at, notes,
  gross_cents, item_discount_cents, discount_total_cents,
  net_revenue_cents, cogs_cents, other_costs_cents,
  direct_costs_cents, gross_profit_cents, item_count,
  ordered_at, created_at, updated_at
`;

const ORDER_WITH_ITEMS_COLUMNS = `
  ${ORDER_COLUMNS},
  order_items (
    id, order_id, product_id, product_name, product_sku,
    unit_price_cents, unit_cost_cents, quantity,
    discount_kind, discount_value, discount_cents, position
  ),
  order_costs ( id, order_id, label, amount_cents )
`;

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function escapeSearchTerm(term: string): string {
  return term
    .replace(/[%_]/g, (m) => `\\${m}`)
    .replace(/[(),]/g, ' ')
    .trim();
}

export async function createOrder(
  db: SupabaseClient,
  accountId: string,
  input: CreateOrderInput
): Promise<OrderWithItems> {
  const { data, error } = await db.rpc('commerce_create_order', {
    p_account_id: accountId,
    p_payload: input,
  });

  if (error) {
    // The RPC raises insufficient_privilege for a cross-tenant
    // contact_id or product_id. Surface that as 403, not 500 — it's
    // a caller mistake (or an attack), not a server fault.
    if (error.code === '42501') {
      throw new RepositoryError(
        'Contato ou produto não pertence a esta conta',
        403
      );
    }
    if (error.code === '22023') {
      throw new RepositoryError(error.message, 400);
    }
    throw new RepositoryError(error.message);
  }

  const orderId = data as string;
  const order = await getOrder(db, accountId, orderId);
  if (!order) {
    throw new RepositoryError('Pedido criado mas não pôde ser lido', 500);
  }
  return order;
}

export async function getOrder(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<OrderWithItems | null> {
  const { data, error } = await db
    .from('orders')
    .select(ORDER_WITH_ITEMS_COLUMNS)
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();

  if (error) throw new RepositoryError(error.message);
  if (!data) return null;

  const order = data as unknown as OrderWithItems;
  // PostgREST does not guarantee embedded-row ordering; the sale
  // form wrote `position` precisely so the drawer can restore the
  // operator's original line order.
  order.order_items = [...(order.order_items ?? [])].sort(
    (a, b) => a.position - b.position
  );
  order.order_costs = order.order_costs ?? [];
  return order;
}

export async function listOrders(
  db: SupabaseClient,
  accountId: string,
  filters: OrderListFilters = {}
): Promise<Paginated<OrderRow>> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE))
  );
  const from = (page - 1) * pageSize;

  // Filtering by product needs the join table. Resolve the matching
  // order ids first rather than embedding order_items in the main
  // select — an inner-join embed would multiply the row count by the
  // number of matching lines and corrupt both the page and `count`.
  let orderIdsForProduct: string[] | null = null;
  if (filters.productId) {
    const { data, error } = await db
      .from('order_items')
      .select('order_id')
      .eq('account_id', accountId)
      .eq('product_id', filters.productId)
      .limit(5000);

    if (error) throw new RepositoryError(error.message);
    orderIdsForProduct = [
      ...new Set((data ?? []).map((r: { order_id: string }) => r.order_id)),
    ];
    if (orderIdsForProduct.length === 0) {
      return { rows: [], total: 0, page, pageSize };
    }
  }

  let query = db
    .from('orders')
    .select(ORDER_COLUMNS, { count: 'exact' })
    .eq('account_id', accountId);

  if (orderIdsForProduct) query = query.in('id', orderIdsForProduct);

  if (filters.status) {
    const statuses = Array.isArray(filters.status)
      ? filters.status
      : [filters.status];
    query = query.in('status', statuses);
  }
  if (filters.contactId) query = query.eq('contact_id', filters.contactId);
  if (filters.sellerUserId) {
    query = query.eq('seller_user_id', filters.sellerUserId);
  }
  if (filters.from) query = query.gte('ordered_at', filters.from);
  if (filters.to) query = query.lt('ordered_at', filters.to);
  if (filters.minCents !== undefined) {
    query = query.gte('net_revenue_cents', filters.minCents);
  }
  if (filters.maxCents !== undefined) {
    query = query.lte('net_revenue_cents', filters.maxCents);
  }

  if (filters.search?.trim()) {
    const term = escapeSearchTerm(filters.search);
    const branches = [
      `customer_name_snapshot.ilike.%${term}%`,
      `customer_phone_snapshot.ilike.%${term}%`,
      `tracking_code.ilike.%${term}%`,
    ];
    // A bare number is almost certainly an order number.
    if (/^\d+$/.test(term)) branches.push(`order_number.eq.${term}`);
    if (term) query = query.or(branches.join(','));
  }

  const sort = filters.sort ?? 'ordered_at';
  const ascending = (filters.direction ?? 'desc') === 'asc';
  query = query.order(sort, { ascending });

  const { data, error, count } = await query.range(from, from + pageSize - 1);
  if (error) throw new RepositoryError(error.message);

  return {
    rows: (data ?? []) as OrderRow[],
    total: count ?? 0,
    page,
    pageSize,
  };
}

/**
 * Board payload. Capped per column: a Kanban is a work surface, not
 * an archive, and rendering 4,000 draggable cards helps nobody. The
 * table view is the place to go long.
 */
export async function listOrdersForBoard(
  db: SupabaseClient,
  accountId: string,
  { limitPerColumn = 50, from, to }: {
    limitPerColumn?: number;
    from?: string;
    to?: string;
  } = {}
): Promise<OrderRow[]> {
  let query = db
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('account_id', accountId)
    .order('ordered_at', { ascending: false })
    .limit(limitPerColumn * 10);

  if (from) query = query.gte('ordered_at', from);
  if (to) query = query.lt('ordered_at', to);

  const { data, error } = await query;
  if (error) throw new RepositoryError(error.message);
  return (data ?? []) as OrderRow[];
}

export async function updateOrder(
  db: SupabaseClient,
  accountId: string,
  id: string,
  patch: OrderPatch
): Promise<OrderRow> {
  const { data, error } = await db
    .from('orders')
    .update(patch)
    .eq('account_id', accountId)
    .eq('id', id)
    .select(ORDER_COLUMNS)
    .maybeSingle();

  if (error) throw new RepositoryError(error.message);
  if (!data) throw new RepositoryError('Pedido não encontrado', 404);
  return data as OrderRow;
}

/** The Kanban drag handler. Status-only, so it stays a cheap write. */
export async function updateOrderStatus(
  db: SupabaseClient,
  accountId: string,
  id: string,
  status: OrderStatus
): Promise<OrderRow> {
  return updateOrder(db, accountId, id, { status });
}

export async function deleteOrder(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<void> {
  const { error } = await db
    .from('orders')
    .delete()
    .eq('account_id', accountId)
    .eq('id', id);

  if (error) throw new RepositoryError(error.message);
}

/**
 * Per-status counts for the board headers and the dashboard's
 * fulfilment tiles. Uses head-only count queries — we need the
 * numbers, not the rows.
 */
export async function countOrdersByStatus(
  db: SupabaseClient,
  accountId: string,
  { from, to }: { from?: string; to?: string } = {}
): Promise<Record<OrderStatus, number>> {
  const { data, error } = await db
    .from('orders')
    .select('status')
    .eq('account_id', accountId)
    .gte('ordered_at', from ?? '1970-01-01T00:00:00Z')
    .lt('ordered_at', to ?? '2999-01-01T00:00:00Z')
    .limit(10_000);

  if (error) throw new RepositoryError(error.message);

  const counts = {} as Record<OrderStatus, number>;
  for (const row of (data ?? []) as { status: OrderStatus }[]) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}

/** Orders belonging to one customer, for the contact panel. */
export async function listOrdersForContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  limit = 20
): Promise<OrderRow[]> {
  const { data, error } = await db
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('ordered_at', { ascending: false })
    .limit(limit);

  if (error) throw new RepositoryError(error.message);
  return (data ?? []) as OrderRow[];
}

/** Distinct product names a customer has bought. */
export async function listProductsBoughtByContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<{ product_name: string; quantity: number }[]> {
  const { data: orderRows, error: orderErr } = await db
    .from('orders')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .in('status', REVENUE_STATUSES as unknown as string[])
    .limit(1000);

  if (orderErr) throw new RepositoryError(orderErr.message);
  const ids = (orderRows ?? []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return [];

  const { data, error } = await db
    .from('order_items')
    .select('product_name, quantity')
    .eq('account_id', accountId)
    .in('order_id', ids)
    .limit(5000);

  if (error) throw new RepositoryError(error.message);

  const totals = new Map<string, number>();
  for (const row of (data ?? []) as {
    product_name: string;
    quantity: number;
  }[]) {
    totals.set(row.product_name, (totals.get(row.product_name) ?? 0) + row.quantity);
  }

  return [...totals.entries()]
    .map(([product_name, quantity]) => ({ product_name, quantity }))
    .sort((a, b) => b.quantity - a.quantity);
}
