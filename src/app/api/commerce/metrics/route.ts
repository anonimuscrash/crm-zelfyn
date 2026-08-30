import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  fetchDashboardMetrics,
  fetchExpenseBreakdown,
  fetchProductRanking,
  fetchSalesSeries,
} from '@/lib/commerce/analytics.repo';
import {
  commerceErrorResponse,
  intParam,
  periodFromSearchParams,
  timezoneParam,
} from '@/lib/commerce/http';
import { previousPeriod } from '@/lib/commerce/periods';

/**
 * The dashboard's single fetch.
 *
 * Everything the page renders comes from here, for one explicit
 * window, in one round trip. Fetching the five pieces separately
 * from the client would let them resolve against slightly different
 * windows if the operator changed the filter mid-flight — the
 * classic "the chart and the KPI disagree" bug.
 *
 * The previous-period comparison is a second metrics call rather
 * than arithmetic on the series, so a month-vs-month comparison uses
 * real calendar months (see previousPeriod).
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

    const [metrics, previousMetrics, series, ranking, expenses] =
      await Promise.all([
        fetchDashboardMetrics(ctx.supabase, ctx.accountId, period, sellerId),
        fetchDashboardMetrics(ctx.supabase, ctx.accountId, previous, sellerId),
        fetchSalesSeries(ctx.supabase, ctx.accountId, period, tz, undefined, sellerId),
        fetchProductRanking(ctx.supabase, ctx.accountId, period, {
          limit: intParam(params, 'rankingLimit', 5, { max: 50 }),
          sellerId,
        }),
        fetchExpenseBreakdown(ctx.supabase, ctx.accountId, period),
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
    });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
