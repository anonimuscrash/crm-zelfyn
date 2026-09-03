// ============================================================
// Row and DTO types for the commerce layer.
//
// Column names mirror the database exactly (snake_case, `_cents`
// suffix on every money field). Repositories return these shapes
// unchanged rather than camel-casing at the boundary — one naming
// convention end to end means a field in a Supabase error message
// is greppable in the React tree.
// ============================================================

import type { DiscountKind } from './calculations';
import type { OrderStatus } from './order-status';

export type { DiscountKind };
export type { OrderStatus };

// ------------------------------------------------------------
// Products
// ------------------------------------------------------------

export interface ProductRow {
  id: string;
  account_id: string;
  name: string;
  sku: string | null;
  description: string | null;
  category: string | null;
  unit_cost_cents: number;
  unit_price_cents: number;
  is_active: boolean;
  image_url: string | null;
  /** `null` means stock is not tracked for this product. */
  stock_quantity: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductInput {
  name: string;
  sku?: string | null;
  description?: string | null;
  category?: string | null;
  unit_cost_cents: number;
  unit_price_cents: number;
  is_active?: boolean;
  image_url?: string | null;
  stock_quantity?: number | null;
  notes?: string | null;
}

export interface ProductListFilters {
  search?: string;
  category?: string;
  /** `undefined` = both. */
  isActive?: boolean;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'created_at' | 'unit_price_cents' | 'stock_quantity';
  direction?: 'asc' | 'desc';
}

// ------------------------------------------------------------
// Orders
// ------------------------------------------------------------

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string;
  product_sku: string | null;
  unit_price_cents: number;
  unit_cost_cents: number;
  quantity: number;
  discount_kind: DiscountKind;
  discount_value: number;
  discount_cents: number;
  position: number;
}

export interface OrderCostRow {
  id: string;
  order_id: string;
  label: string;
  amount_cents: number;
}

export interface OrderRow {
  id: string;
  account_id: string;
  order_number: number;
  contact_id: string | null;
  customer_name_snapshot: string | null;
  customer_phone_snapshot: string | null;
  seller_user_id: string | null;
  status: OrderStatus;

  discount_kind: DiscountKind;
  discount_value: number;
  order_discount_cents: number;

  shipping_cost_cents: number;
  payment_fee_cents: number;
  shipping_carrier: string | null;
  tracking_code: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  notes: string | null;

  // Derived — trigger-maintained, read-only from the app's side.
  gross_cents: number;
  item_discount_cents: number;
  discount_total_cents: number;
  net_revenue_cents: number;
  cogs_cents: number;
  other_costs_cents: number;
  direct_costs_cents: number;
  gross_profit_cents: number;
  item_count: number;

  ordered_at: string;
  created_at: string;
  updated_at: string;
}

/** An order with its lines, for the detail drawer. */
export interface OrderWithItems extends OrderRow {
  order_items: OrderItemRow[];
  order_costs: OrderCostRow[];
}

/** Shape accepted by `commerce_create_order`. */
export interface CreateOrderItemInput {
  product_id?: string | null;
  product_name?: string;
  product_sku?: string | null;
  /** Omit to snapshot the product's current price. */
  unit_price_cents?: number;
  unit_cost_cents?: number;
  quantity: number;
  discount_kind?: DiscountKind;
  discount_value?: number;
}

export interface CreateOrderInput {
  contact_id?: string | null;
  seller_user_id?: string | null;
  status?: OrderStatus;
  discount_kind?: DiscountKind;
  discount_value?: number;
  shipping_cost_cents?: number;
  payment_fee_cents?: number;
  shipping_carrier?: string | null;
  tracking_code?: string | null;
  notes?: string | null;
  ordered_at?: string;
  items: CreateOrderItemInput[];
  extra_costs?: { label: string; amount_cents: number }[];
}

export interface OrderListFilters {
  search?: string;
  status?: OrderStatus | OrderStatus[];
  contactId?: string;
  productId?: string;
  sellerUserId?: string;
  from?: string;
  to?: string;
  minCents?: number;
  maxCents?: number;
  page?: number;
  pageSize?: number;
  sort?: 'ordered_at' | 'order_number' | 'net_revenue_cents' | 'gross_profit_cents';
  direction?: 'asc' | 'desc';
}

// ------------------------------------------------------------
// Expenses
// ------------------------------------------------------------

export interface ExpenseCategoryRow {
  id: string;
  account_id: string;
  name: string;
  slug: string;
  color: string;
  is_system: boolean;
}

export interface ExpenseRow {
  id: string;
  account_id: string;
  description: string;
  amount_cents: number;
  category_id: string | null;
  category_name_snapshot: string | null;
  incurred_on: string;
  supplier: string | null;
  payment_method: string | null;
  notes: string | null;
  is_recurring: boolean;
  recurrence: 'monthly' | 'weekly' | 'yearly' | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseInput {
  description: string;
  amount_cents: number;
  category_id?: string | null;
  incurred_on: string;
  supplier?: string | null;
  payment_method?: string | null;
  notes?: string | null;
  is_recurring?: boolean;
  recurrence?: 'monthly' | 'weekly' | 'yearly' | null;
}

export interface ExpenseListFilters {
  search?: string;
  categoryId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

// ------------------------------------------------------------
// Analytics — the RPC return shapes from 041.
// ------------------------------------------------------------

export interface DashboardMetricsRow {
  gross_cents: number;
  discount_cents: number;
  net_revenue_cents: number;
  cogs_cents: number;
  shipping_cents: number;
  fees_cents: number;
  other_costs_cents: number;
  direct_costs_cents: number;
  gross_profit_cents: number;
  operating_expenses_cents: number;
  operating_profit_cents: number;
  order_count: number;
  units_sold: number;
  avg_ticket_cents: number;
  customer_count: number;
  status_awaiting_shipment: number;
  status_shipped: number;
  status_completed: number;
  status_cancelled: number;
}

export interface SalesSeriesPoint {
  bucket_start: string;
  net_revenue_cents: number;
  gross_profit_cents: number;
  direct_costs_cents: number;
  order_count: number;
  units_sold: number;
  avg_ticket_cents: number;
}

export interface ProductRankingRow {
  product_id: string | null;
  product_name: string;
  product_sku: string | null;
  units_sold: number;
  order_count: number;
  gross_cents: number;
  discount_cents: number;
  net_revenue_cents: number;
  cogs_cents: number;
  gross_profit_cents: number;
  avg_ticket_cents: number;
}

export interface ExpenseBreakdownRow {
  category_id: string | null;
  category_name: string;
  color: string;
  amount_cents: number;
  entry_count: number;
}

export interface SellerPerformanceRow {
  seller_user_id: string | null;
  seller_name: string;
  order_count: number;
  net_revenue_cents: number;
  gross_profit_cents: number;
  avg_ticket_cents: number;
}

export interface CustomerStatsRow {
  contact_id: string;
  order_count: number;
  net_revenue_cents: number;
  gross_profit_cents: number;
  avg_ticket_cents: number;
  first_order_at: string;
  last_order_at: string;
}

/** Empty metrics — used for the zero-state so the UI never renders NaN. */
export const EMPTY_METRICS: DashboardMetricsRow = {
  gross_cents: 0,
  discount_cents: 0,
  net_revenue_cents: 0,
  cogs_cents: 0,
  shipping_cents: 0,
  fees_cents: 0,
  other_costs_cents: 0,
  direct_costs_cents: 0,
  gross_profit_cents: 0,
  operating_expenses_cents: 0,
  operating_profit_cents: 0,
  order_count: 0,
  units_sold: 0,
  avg_ticket_cents: 0,
  customer_count: 0,
  status_awaiting_shipment: 0,
  status_shipped: 0,
  status_completed: 0,
  status_cancelled: 0,
};

/** Paginated envelope shared by every list endpoint. */
export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ------------------------------------------------------------
// Equipe
// ------------------------------------------------------------

export interface TeamMemberRow {
  user_id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  /** owner | admin | agent | viewer — o papel cru do banco. */
  account_role: string;
  joined_at: string;
  /** Última venda registrada. `null` = nunca vendeu. */
  last_seen_at: string | null;
  order_count: number;
  net_revenue_cents: number;
  gross_profit_cents: number;
  avg_ticket_cents: number;
  units_sold: number;
  discount_cents: number;
  today_order_count: number;
  today_net_revenue_cents: number;
}

export interface SellerOption {
  user_id: string;
  full_name: string;
  account_role: string;
}

/** Chaves de ordenação do ranking de vendedores (§15). */
export type TeamSort =
  | 'revenue'
  | 'profit'
  | 'orders'
  | 'ticket'
  | 'margin';
