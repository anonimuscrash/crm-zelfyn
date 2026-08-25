'use client';

// ============================================================
// Commercial dashboard.
//
// Everything on this screen comes from ONE request against ONE
// explicitly resolved window (/api/commerce/metrics). Changing the
// period refetches; nothing is sliced client-side, so the KPI tiles,
// the chart and the ranking can never disagree about which days they
// are describing.
//
// Nothing renders a number that did not come from the database (§33).
// An account with no sales gets the setup guidance below, not a
// plausible-looking R$ 145.000.
//
// Replaces the previous WhatsApp-activity dashboard (conversations /
// response time / pipeline donut). Those queries still exist in
// src/lib/dashboard/queries.ts and their tables are untouched — the
// screen changed, the data did not.
// ============================================================

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, Package, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { periodQuery, useCommerceFetch } from '@/hooks/use-commerce';
import {
  EmptyState,
  ErrorState,
  MetricSkeletonGrid,
  MetricTile,
  Money,
  PageHeader,
  PeriodFilter,
  Skeleton,
  StatementRow,
} from '@/components/commerce/primitives';
import { SalesChart } from '@/components/commerce/sales-chart';
import { NewSaleDrawer } from '@/components/commerce/new-sale-drawer';
import { formatBp, formatCents } from '@/lib/commerce/money';
import { calculateProfitAndLoss } from '@/lib/commerce/calculations';
import type { PeriodSelection, SeriesBucket } from '@/lib/commerce/periods';
import type {
  DashboardMetricsRow,
  ExpenseBreakdownRow,
  ProductRankingRow,
  SalesSeriesPoint,
} from '@/lib/commerce/types';

interface MetricsPayload {
  period: { preset: string; from: string; to: string; bucket: SeriesBucket };
  metrics: DashboardMetricsRow;
  previousMetrics: DashboardMetricsRow;
  series: SalesSeriesPoint[];
  ranking: ProductRankingRow[];
  expenses: ExpenseBreakdownRow[];
}

export default function DashboardPage() {
  const t = useTranslations('Dash');
  const tc = useTranslations('Commerce');

  const [period, setPeriod] = useState<PeriodSelection>({ preset: 'last30' });
  const [saleOpen, setSaleOpen] = useState(false);

  const query = periodQuery(period);
  const { data, error, loading, reload } = useCommerceFetch<MetricsPayload>(
    `/api/commerce/metrics?${query}&rankingLimit=5`
  );

  const m = data?.metrics;
  const prev = data?.previousMetrics;

  // Recomputed client-side from the server's own figures purely to
  // reuse the tested P&L shape — every input is a database value, so
  // this adds no independent arithmetic that could disagree.
  const pl = useMemo(() => {
    if (!m) return null;
    return calculateProfitAndLoss({
      grossCents: m.gross_cents,
      discountCents: m.discount_cents,
      cogsCents: m.cogs_cents,
      shippingCents: m.shipping_cents,
      feesCents: m.fees_cents,
      otherDirectCostsCents: m.other_costs_cents,
      operatingExpensesCents: m.operating_expenses_cents,
      orderCount: m.order_count,
    });
  }, [m]);

  const hasAnyActivity =
    !!m && (m.order_count > 0 || m.operating_expenses_cents > 0);

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <PageHeader
        title={t('title')}
        actions={
          <Button size="sm" onClick={() => setSaleOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {tc('newSale')}
          </Button>
        }
      />

      <PeriodFilter value={period} onChange={setPeriod} className="mb-5" />

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="space-y-4">
          <MetricSkeletonGrid />
          <Skeleton className="h-[280px] w-full rounded-lg" />
        </div>
      ) : !hasAnyActivity ? (
        <SetupGuidance onNewSale={() => setSaleOpen(true)} />
      ) : (
        <div className="space-y-5">
          {/* ---- Headline KPIs ---- */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricTile
              label={t('netRevenue')}
              valueCents={m!.net_revenue_cents}
              previous={prev?.net_revenue_cents}
            />
            <MetricTile
              label={t('operatingProfit')}
              valueCents={m!.operating_profit_cents}
              previous={prev?.operating_profit_cents}
              tone="positive"
            />
            <MetricTile
              label={t('orderCount')}
              rawValue={String(m!.order_count)}
            />
            <MetricTile
              label={t('avgTicket')}
              valueCents={m!.avg_ticket_cents}
              previous={prev?.avg_ticket_cents}
            />
            <MetricTile
              label={t('margin')}
              rawValue={pl ? formatBp(pl.operatingMarginBp) : '—'}
            />
          </div>

          {/* ---- Chart ---- */}
          <SalesChart
            series={data?.series ?? []}
            bucket={data?.period.bucket ?? 'day'}
            loading={loading}
          />

          <div className="grid gap-5 lg:grid-cols-3">
            {/* ---- P&L statement ----
                The two-stage subtraction from §18, laid out as an
                actual statement so the operator can see WHERE the
                money went, not just what survived. */}
            <section className="rounded-lg border border-border bg-card p-4 lg:col-span-1">
              <h2 className="mb-2 text-sm font-semibold text-foreground">
                {t('statement')}
              </h2>
              <StatementRow
                label={t('grossRevenue')}
                valueCents={m!.gross_cents}
              />
              <StatementRow
                label={t('discounts')}
                valueCents={m!.discount_cents}
                negative
                indent
              />
              <StatementRow
                label={t('netRevenue')}
                valueCents={m!.net_revenue_cents}
                emphasis
              />

              <div className="mt-2">
                <StatementRow
                  label={t('cogs')}
                  valueCents={m!.cogs_cents}
                  negative
                  indent
                />
                <StatementRow
                  label={t('shipping')}
                  valueCents={m!.shipping_cents}
                  negative
                  indent
                />
                <StatementRow
                  label={t('fees')}
                  valueCents={m!.fees_cents}
                  negative
                  indent
                />
                {m!.other_costs_cents > 0 ? (
                  <StatementRow
                    label={t('otherCosts')}
                    valueCents={m!.other_costs_cents}
                    negative
                    indent
                  />
                ) : null}
                <StatementRow
                  label={t('grossProfit')}
                  valueCents={m!.gross_profit_cents}
                  emphasis
                />
              </div>

              <div className="mt-2">
                <StatementRow
                  label={t('opex')}
                  valueCents={m!.operating_expenses_cents}
                  negative
                  indent
                />
                <StatementRow
                  label={t('operatingProfit')}
                  valueCents={m!.operating_profit_cents}
                  emphasis
                />
              </div>
            </section>

            {/* ---- Product ranking ---- */}
            <section className="rounded-lg border border-border bg-card lg:col-span-2">
              <header className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">
                  {t('topProducts')}
                </h2>
                <Link
                  href="/reports?tab=products"
                  className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  {t('seeAll')}
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </header>

              {(data?.ranking ?? []).length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('emptyTitle')}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="px-4 py-2 text-left font-medium">
                          {t('topProducts')}
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          {t('unitsSold')}
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          {t('chartRevenue')}
                        </th>
                        <th className="px-4 py-2 text-right font-medium">
                          {t('chartProfit')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.ranking ?? []).map((row) => (
                        <tr
                          key={row.product_id ?? row.product_name}
                          className="border-b border-border/60 last:border-0"
                        >
                          <td className="max-w-[220px] truncate px-4 py-2.5 text-foreground">
                            {row.product_name}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                            {row.units_sold}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
                            {formatCents(row.net_revenue_cents)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <Money cents={row.gross_profit_cents} signed />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            {/* ---- Fulfilment ---- */}
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold text-foreground">
                {t('fulfilment')}
              </h2>
              <div className="grid grid-cols-2 gap-2">
                <FulfilTile
                  label={t('awaiting')}
                  count={m!.status_awaiting_shipment}
                  href="/kanban"
                  tone="amber"
                />
                <FulfilTile
                  label={t('shipped')}
                  count={m!.status_shipped}
                  href="/kanban"
                />
                <FulfilTile
                  label={t('completed')}
                  count={m!.status_completed}
                  href="/orders"
                />
                <FulfilTile
                  label={t('cancelled')}
                  count={m!.status_cancelled}
                  href="/orders"
                  tone="red"
                />
              </div>
            </section>

            {/* ---- Expenses by category ---- */}
            <section className="rounded-lg border border-border bg-card p-4 lg:col-span-2">
              <header className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">
                  {t('expenseBreakdown')}
                </h2>
                <Link
                  href="/expenses"
                  className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  {t('seeAll')}
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </header>

              {(data?.expenses ?? []).length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {tc('none')}
                </p>
              ) : (
                <ExpenseBars rows={data!.expenses} />
              )}
            </section>
          </div>
        </div>
      )}

      <NewSaleDrawer
        open={saleOpen}
        onClose={() => setSaleOpen(false)}
        onCreated={reload}
      />
    </div>
  );
}

function FulfilTile({
  label,
  count,
  href,
  tone,
}: {
  label: string;
  count: number;
  href: string;
  tone?: 'amber' | 'red';
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted"
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 text-xl font-semibold tabular-nums',
          tone === 'amber'
            ? 'text-amber-700 dark:text-amber-400'
            : tone === 'red' && count > 0
              ? 'text-red-700 dark:text-red-400'
              : 'text-foreground'
        )}
      >
        {count}
      </p>
    </Link>
  );
}

/**
 * Horizontal bars rather than a pie. A pie makes it hard to compare
 * two similar slices and impossible to read exact values; bars sorted
 * by size answer "what is eating the money" in one glance.
 */
function ExpenseBars({ rows }: { rows: ExpenseBreakdownRow[] }) {
  const max = Math.max(...rows.map((r) => r.amount_cents), 1);

  return (
    <ul className="space-y-2.5">
      {rows.slice(0, 6).map((row) => (
        <li key={row.category_id ?? row.category_name}>
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="truncate text-foreground">
              {row.category_name}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatCents(row.amount_cents)}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/60"
              style={{ width: `${(row.amount_cents / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * First-run guidance. Four steps, plain sentences, no illustrations
 * and no progress ring — onboarding that respects the reader (§34).
 */
function SetupGuidance({ onNewSale }: { onNewSale: () => void }) {
  const t = useTranslations('Dash');
  const tc = useTranslations('Commerce');

  const steps = [
    { text: t('setupProducts'), href: '/products' },
    { text: t('setupSale'), href: null },
    { text: t('setupTrack'), href: '/kanban' },
    { text: t('setupExpenses'), href: '/expenses' },
  ];

  return (
    <div className="space-y-4">
      <EmptyState
        icon={<Package className="h-6 w-6" />}
        title={t('emptyTitle')}
        description={t('emptyBody')}
        action={
          <Button size="sm" onClick={onNewSale}>
            <Plus className="mr-1.5 h-4 w-4" />
            {tc('newSale')}
          </Button>
        }
      />

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">
          {t('setupTitle')}
        </h2>
        <ol className="mt-3 space-y-2">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] font-medium tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              {step.href ? (
                <Link
                  href={step.href}
                  className="text-foreground hover:text-primary hover:underline"
                >
                  {step.text}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={onNewSale}
                  className="text-left text-foreground hover:text-primary hover:underline"
                >
                  {step.text}
                </button>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
