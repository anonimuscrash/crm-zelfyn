// ============================================================
// Analytics repository — typed wrappers over the aggregation RPCs
// from 041_commerce_analytics.sql.
//
// Nothing in here loads rows and sums them in JavaScript. Every
// figure the dashboard shows is computed by Postgres over the exact
// requested window, which is what makes the period filter real (§7)
// rather than a client-side slice of a fixed payload.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { RepositoryError } from './products.repo';
import type { ResolvedPeriod, SeriesBucket } from './periods';
import {
  EMPTY_METRICS,
  type CustomerStatsRow,
  type DashboardMetricsRow,
  type ExpenseBreakdownRow,
  type ProductRankingRow,
  type SalesSeriesPoint,
  type SellerPerformanceRow,
} from './types';

/**
 * The RPCs raise `insufficient_privilege` when the caller isn't a
 * member of the account they asked about. That is a 403, and it must
 * not be swallowed into an empty dashboard — a silently blank screen
 * is how a broken tenancy check goes unnoticed.
 */
function mapRpcError(error: { code?: string; message: string }): never {
  if (error.code === '42501') {
    throw new RepositoryError('Sem acesso a esta conta', 403);
  }
  if (error.code === '22023') {
    throw new RepositoryError(error.message, 400);
  }
  throw new RepositoryError(error.message);
}

export async function fetchDashboardMetrics(
  db: SupabaseClient,
  accountId: string,
  period: Pick<ResolvedPeriod, 'from' | 'to'>
): Promise<DashboardMetricsRow> {
  const { data, error } = await db.rpc('commerce_dashboard_metrics', {
    p_account_id: accountId,
    p_from: period.from.toISOString(),
    p_to: period.to.toISOString(),
  });

  if (error) mapRpcError(error);

  const row = Array.isArray(data) ? data[0] : data;
  // A window with no orders returns a row of zeros, not no row — but
  // guard anyway so an empty account renders the zero-state rather
  // than throwing on `undefined.net_revenue_cents`.
  return (row as DashboardMetricsRow) ?? EMPTY_METRICS;
}

export async function fetchSalesSeries(
  db: SupabaseClient,
  accountId: string,
  period: Pick<ResolvedPeriod, 'from' | 'to' | 'bucket'>,
  timezone: string,
  bucketOverride?: SeriesBucket
): Promise<SalesSeriesPoint[]> {
  const { data, error } = await db.rpc('commerce_sales_series', {
    p_account_id: accountId,
    p_from: period.from.toISOString(),
    p_to: period.to.toISOString(),
    p_bucket: bucketOverride ?? period.bucket,
    p_timezone: timezone,
  });

  if (error) mapRpcError(error);
  return (data ?? []) as SalesSeriesPoint[];
}

export async function fetchProductRanking(
  db: SupabaseClient,
  accountId: string,
  period: Pick<ResolvedPeriod, 'from' | 'to'>,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}
): Promise<ProductRankingRow[]> {
  const { data, error } = await db.rpc('commerce_product_ranking', {
    p_account_id: accountId,
    p_from: period.from.toISOString(),
    p_to: period.to.toISOString(),
    p_limit: limit,
    p_offset: offset,
  });

  if (error) mapRpcError(error);
  return (data ?? []) as ProductRankingRow[];
}

export async function fetchExpenseBreakdown(
  db: SupabaseClient,
  accountId: string,
  period: Pick<ResolvedPeriod, 'from' | 'to'>
): Promise<ExpenseBreakdownRow[]> {
  const { data, error } = await db.rpc('commerce_expense_breakdown', {
    p_account_id: accountId,
    p_from: period.from.toISOString(),
    p_to: period.to.toISOString(),
  });

  if (error) mapRpcError(error);
  return (data ?? []) as ExpenseBreakdownRow[];
}

export async function fetchSellerPerformance(
  db: SupabaseClient,
  accountId: string,
  period: Pick<ResolvedPeriod, 'from' | 'to'>
): Promise<SellerPerformanceRow[]> {
  const { data, error } = await db.rpc('commerce_seller_performance', {
    p_account_id: accountId,
    p_from: period.from.toISOString(),
    p_to: period.to.toISOString(),
  });

  if (error) mapRpcError(error);
  return (data ?? []) as SellerPerformanceRow[];
}

export async function fetchCustomerStats(
  db: SupabaseClient,
  accountId: string,
  { contactId = null, limit = 50 }: { contactId?: string | null; limit?: number } = {}
): Promise<CustomerStatsRow[]> {
  const { data, error } = await db.rpc('commerce_customer_stats', {
    p_account_id: accountId,
    p_contact_id: contactId,
    p_limit: limit,
  });

  if (error) mapRpcError(error);
  return (data ?? []) as CustomerStatsRow[];
}

/**
 * Ranking sort keys. Sorting happens client-side over the already-
 * fetched page because the ranking is capped at a screenful — a
 * server round trip per column click would be slower and would give
 * the operator a worse experience for no correctness gain.
 */
export type RankingSort =
  | 'units'
  | 'revenue'
  | 'profit'
  | 'margin'
  | 'marginAsc'
  | 'discount';

export function sortProductRanking(
  rows: ProductRankingRow[],
  sort: RankingSort
): ProductRankingRow[] {
  const margin = (r: ProductRankingRow) =>
    r.net_revenue_cents === 0
      ? 0
      : r.gross_profit_cents / r.net_revenue_cents;

  const copy = [...rows];
  switch (sort) {
    case 'units':
      return copy.sort((a, b) => b.units_sold - a.units_sold);
    case 'revenue':
      return copy.sort((a, b) => b.net_revenue_cents - a.net_revenue_cents);
    case 'profit':
      return copy.sort((a, b) => b.gross_profit_cents - a.gross_profit_cents);
    case 'margin':
      return copy.sort((a, b) => margin(b) - margin(a));
    case 'marginAsc':
      return copy.sort((a, b) => margin(a) - margin(b));
    case 'discount':
      return copy.sort((a, b) => b.discount_cents - a.discount_cents);
    default:
      return copy;
  }
}
