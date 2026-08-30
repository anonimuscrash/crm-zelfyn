'use client';

// ============================================================
// Sales trend chart.
//
// Not decoration (§8): the operator picks which series to read, the
// x-axis granularity follows the selected window, and the optional
// comparison overlays the equivalent previous period.
//
// Recharts is already a project dependency — no new package.
//
// Styling notes: a single accent stroke, no area gradient fill, thin
// grid lines on the y-axis only. A filled gradient under a revenue
// line reads as volume, which is a different quantity from the one
// being plotted, and that misreading is expensive on a money chart.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { cn } from '@/lib/utils';
import { formatCents, formatCentsCompact } from '@/lib/commerce/money';
import type { SeriesBucket } from '@/lib/commerce/periods';
import type { SalesSeriesPoint } from '@/lib/commerce/types';

type MetricKey = 'revenue' | 'profit' | 'orders' | 'avgTicket' | 'costs';

const METRICS: { key: MetricKey; labelKey: string; money: boolean }[] = [
  { key: 'revenue', labelKey: 'chartRevenue', money: true },
  { key: 'profit', labelKey: 'chartProfit', money: true },
  { key: 'orders', labelKey: 'chartOrders', money: false },
  { key: 'avgTicket', labelKey: 'chartAvgTicket', money: true },
  { key: 'costs', labelKey: 'chartCosts', money: true },
];

function pick(point: SalesSeriesPoint, metric: MetricKey): number {
  switch (metric) {
    case 'revenue':
      return point.net_revenue_cents;
    case 'profit':
      return point.gross_profit_cents;
    case 'orders':
      return point.order_count;
    case 'avgTicket':
      return point.avg_ticket_cents;
    case 'costs':
      return point.direct_costs_cents;
  }
}

/** Axis label appropriate to the bucket the server actually used. */
function labelFor(iso: string, bucket: SeriesBucket): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  switch (bucket) {
    case 'hour':
      return new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(d);
    case 'month':
      return new Intl.DateTimeFormat('pt-BR', {
        month: 'short',
        year: '2-digit',
      }).format(d);
    case 'week':
    case 'day':
    default:
      return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: '2-digit',
      }).format(d);
  }
}

interface ChartRow {
  label: string;
  current: number;
  previous?: number;
}

export function SalesChart({
  series,
  previousSeries,
  bucket,
  loading,
}: {
  series: SalesSeriesPoint[];
  previousSeries?: SalesSeriesPoint[];
  bucket: SeriesBucket;
  loading?: boolean;
}) {
  const t = useTranslations('Dash');
  const [metric, setMetric] = useState<MetricKey>('revenue');
  const [compare, setCompare] = useState(false);

  const isMoney = METRICS.find((m) => m.key === metric)?.money ?? true;

  const rows = useMemo<ChartRow[]>(() => {
    return series.map((point, i) => ({
      label: labelFor(point.bucket_start, bucket),
      current: pick(point, metric),
      // Align by INDEX, not by date: the previous window has its own
      // calendar dates, and the comparison the operator wants is
      // "day 3 of this period vs day 3 of the last one".
      previous:
        compare && previousSeries?.[i]
          ? pick(previousSeries[i], metric)
          : undefined,
    }));
  }, [series, previousSeries, metric, compare, bucket]);

  const hasData = rows.some((r) => r.current !== 0 || (r.previous ?? 0) !== 0);

  const formatValue = (value: number) =>
    isMoney ? formatCents(value) : String(value);

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          {t('chartTitle')}
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMetric(m.key)}
                aria-pressed={metric === m.key}
                className={cn(
                  'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                  metric === m.key
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {t(m.labelKey)}
              </button>
            ))}
          </div>

          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={compare}
              onChange={(e) => setCompare(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border accent-[var(--primary)]"
            />
            {t('compare')}
          </label>
        </div>
      </header>

      <div className="h-[280px] px-2 py-4">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="h-full w-full animate-pulse rounded bg-muted/50" />
          </div>
        ) : !hasData ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">{t('emptyTitle')}</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={rows}
              margin={{ top: 4, right: 12, bottom: 0, left: 4 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--border)"
              />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                // Let Recharts thin the ticks rather than rotating
                // labels — rotated axis text is the fastest way to
                // make a business chart look unfinished.
                minTickGap={24}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={64}
                tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                tickFormatter={(v: number) =>
                  isMoney ? formatCentsCompact(v) : String(v)
                }
              />
              <Tooltip
                cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
                contentStyle={{
                  background: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 12,
                  boxShadow: 'none',
                }}
                labelStyle={{ color: 'var(--muted-foreground)' }}
                formatter={(value, name) => [
                  formatValue(typeof value === 'number' ? value : 0),
                  name === 'previous' ? t('compare') : t('chartTitle'),
                ]}
              />
              {compare ? (
                <Line
                  type="monotone"
                  dataKey="previous"
                  stroke="var(--muted-foreground)"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  dot={false}
                  isAnimationActive={false}
                />
              ) : null}
              <Line
                type="monotone"
                dataKey="current"
                stroke="var(--primary)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3.5 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
