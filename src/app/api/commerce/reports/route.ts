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
      fetchDashboardMetrics(ctx.supabase, ctx.accountId, period),
      fetchDashboardMetrics(ctx.supabase, ctx.accountId, previous),
      fetchSalesSeries(ctx.supabase, ctx.accountId, period, tz),
      fetchProductRanking(ctx.supabase, ctx.accountId, period, { limit }),
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
