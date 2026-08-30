import { NextResponse } from 'next/server';

import { commerceErrorResponse, periodFromSearchParams, timezoneParam } from '@/lib/commerce/http';
import { previousPeriod } from '@/lib/commerce/periods';
import { requirePlatformAdmin } from '@/lib/platform/guard';
import {
  fetchGrowthSeries,
  fetchPlatformMetrics,
  fetchRecentActivity,
} from '@/lib/platform/repo';

/**
 * Visão geral da plataforma. Uma requisição, uma janela.
 *
 * Métricas do período anterior vêm juntas para as variações — duas
 * chamadas separadas poderiam resolver janelas diferentes se o
 * filtro mudasse no meio do voo.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requirePlatformAdmin();
    const params = new URL(request.url).searchParams;

    const period = periodFromSearchParams(params);
    const tz = timezoneParam(params);

    const [metrics, previous, growth, activity] = await Promise.all([
      fetchPlatformMetrics(ctx.supabase, period),
      fetchPlatformMetrics(ctx.supabase, previousPeriod(period)),
      fetchGrowthSeries(ctx.supabase, period, tz),
      fetchRecentActivity(ctx.supabase, 15),
    ]);

    return NextResponse.json({
      period: {
        preset: period.preset,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        bucket: period.bucket,
      },
      metrics,
      previous,
      growth,
      activity,
    });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
