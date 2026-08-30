import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  fetchCustomerStats,
  fetchDashboardMetrics,
  fetchExpenseBreakdown,
  fetchProductRanking,
  fetchSalesSeries,
  fetchSellerPerformance,
} from '@/lib/commerce/analytics.repo';
import {
  commerceErrorResponse,
  intParam,
  periodFromSearchParams,
  timezoneParam,
} from '@/lib/commerce/http';
import { countOrdersByStatus } from '@/lib/commerce/orders.repo';
import { previousPeriod } from '@/lib/commerce/periods';

/**
 * Reports bundle. Same window semantics as /metrics, but the fuller
 * set: seller performance, top customers, and the status
 * distribution alongside the shared aggregates.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const params = new URL(request.url).searchParams;

    const period = periodFromSearchParams(params);

    // Recorte por vendedor (§14). O valor é repassado ao banco, que
    // o IGNORA e força o próprio uid quando o chamador não é master
    // — um vendedor não consegue pedir os números de um colega
    // trocando a query string.
    const sellerId = params.get('sellerId') || null;
    const previous = previousPeriod(period);
    const tz = timezoneParam(params);
    const limit = intParam(params, 'limit', 20, { max: 100 });

    const [
      metrics,
      previousMetrics,
      series,
      ranking,
      expenses,
      sellers,
      customers,
      statusCounts,
    ] = await Promise.all([
      fetchDashboardMetrics(ctx.supabase, ctx.accountId, period, sellerId),
      fetchDashboardMetrics(ctx.supabase, ctx.accountId, previous, sellerId),
      fetchSalesSeries(ctx.supabase, ctx.accountId, period, tz, undefined, sellerId),
      fetchProductRanking(ctx.supabase, ctx.accountId, period, { limit, sellerId }),
      fetchExpenseBreakdown(ctx.supabase, ctx.accountId, period),
      fetchSellerPerformance(ctx.supabase, ctx.accountId, period),
      fetchCustomerStats(ctx.supabase, ctx.accountId, { limit }),
      countOrdersByStatus(ctx.supabase, ctx.accountId, {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      }),
    ]);

    return NextResponse.json({
      period: {
        preset: period.preset,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        bucket: period.bucket,
        days: period.days,
      },
      metrics,
      previousMetrics,
      series,
      ranking,
      expenses,
      sellers,
      customers,
      statusCounts,
    });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
