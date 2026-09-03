'use client';

// ============================================================
// Reports (§19).
//
// One window, six views over it. Everything is a database aggregate
// returned by /api/commerce/reports — no client-side summing, so a
// figure here always reconciles with the same figure on the
// dashboard for the same period.
//
// No PDF export yet, deliberately: the brief said correct
// information in the platform comes first, and export is the part
// that is trivial to add once the numbers are trusted.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BarChart3 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { periodQuery, useCommerceFetch } from '@/hooks/use-commerce';
import {
  EmptyState,
  ErrorState,
  formatDateBR,
  MarginBadge,
  Money,
  PageHeader,
  PeriodFilter,
  Skeleton,
  StatementRow,
} from '@/components/commerce/primitives';
import { ReportPdfButton } from '@/components/commerce/report-pdf-button';
import { sortProductRanking, type RankingSort } from '@/lib/commerce/analytics.repo';
import { formatCents } from '@/lib/commerce/money';
import { ORDER_STATUS_META, KANBAN_COLUMNS } from '@/lib/commerce/order-status';
import type { PeriodSelection, SeriesBucket } from '@/lib/commerce/periods';
import type {
  CustomerStatsRow,
  DashboardMetricsRow,
  ExpenseBreakdownRow,
  OrderStatus,
  ProductRankingRow,
  SalesSeriesPoint,
  SellerPerformanceRow,
} from '@/lib/commerce/types';

interface ReportsPayload {
  period: { bucket: SeriesBucket };
  metrics: DashboardMetricsRow;
  previousMetrics: DashboardMetricsRow;
  series: SalesSeriesPoint[];
  ranking: ProductRankingRow[];
  expenses: ExpenseBreakdownRow[];
  sellers: SellerPerformanceRow[];
  customers: CustomerStatsRow[];
  statusCounts: Partial<Record<OrderStatus, number>>;
}

type Tab = 'result' | 'products' | 'sellers' | 'customers' | 'expenses' | 'status';

const TABS: { key: Tab; labelKey: string }[] = [
  { key: 'result', labelKey: 'tabResult' },
  { key: 'products', labelKey: 'tabProducts' },
  { key: 'sellers', labelKey: 'tabSellers' },
  { key: 'customers', labelKey: 'tabCustomers' },
  { key: 'expenses', labelKey: 'tabExpenses' },
  { key: 'status', labelKey: 'tabStatus' },
];

function statusKey(status: OrderStatus): string {
  return `status${status.replace(/(^|_)(\w)/g, (_, __, c: string) =>
    c.toUpperCase()
  )}`;
}

export default function ReportsPage() {
  const t = useTranslations('Reports');
  const td = useTranslations('Dash');
  const to = useTranslations('Orders');
  const tc = useTranslations('Commerce');

  const [period, setPeriod] = useState<PeriodSelection>({ preset: 'last30' });
  const [tab, setTab] = useState<Tab>('result');
  const [rankingSort, setRankingSort] = useState<RankingSort>('revenue');

  const { data, error, loading, reload } = useCommerceFetch<ReportsPayload>(
    `/api/commerce/reports?${periodQuery(period)}&limit=50`
  );

  const ranking = useMemo(
    () => (data ? sortProductRanking(data.ranking, rankingSort) : []),
    [data, rankingSort]
  );

  const m = data?.metrics;
  const hasData = !!m && (m.order_count > 0 || m.operating_expenses_cents > 0);

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <PageHeader
        title={t('title')}
        actions={
          <ReportPdfButton
            periodQueryString={periodQuery(period)}
            sellers={data?.sellers ?? []}
            disabled={loading || !hasData}
          />
        }
      />

      <PeriodFilter value={period} onChange={setPeriod} className="mb-4" />

      <div className="mb-4 flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            aria-pressed={tab === item.key}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors',
              tab === item.key
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : !hasData ? (
        <EmptyState icon={<BarChart3 className="h-6 w-6" />} title={t('empty')} />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          {tab === 'result' ? (
            <div className="max-w-lg p-4">
              <StatementRow label={td('grossRevenue')} valueCents={m!.gross_cents} />
              <StatementRow
                label={td('discounts')}
                valueCents={m!.discount_cents}
                negative
                indent
              />
              <StatementRow
                label={td('netRevenue')}
                valueCents={m!.net_revenue_cents}
                emphasis
              />
              <div className="mt-2">
                <StatementRow label={td('cogs')} valueCents={m!.cogs_cents} negative indent />
                <StatementRow label={td('shipping')} valueCents={m!.shipping_cents} negative indent />
                <StatementRow label={td('fees')} valueCents={m!.fees_cents} negative indent />
                <StatementRow
                  label={td('otherCosts')}
                  valueCents={m!.other_costs_cents}
                  negative
                  indent
                />
                <StatementRow
                  label={td('grossProfit')}
                  valueCents={m!.gross_profit_cents}
                  emphasis
                />
              </div>
              <div className="mt-2">
                <StatementRow
                  label={td('opex')}
                  valueCents={m!.operating_expenses_cents}
                  negative
                  indent
                />
                <StatementRow
                  label={td('operatingProfit')}
                  valueCents={m!.operating_profit_cents}
                  emphasis
                />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3 text-[13px]">
                <Stat label={td('orderCount')} value={String(m!.order_count)} />
                <Stat label={td('avgTicket')} value={formatCents(m!.avg_ticket_cents)} />
                <Stat label={td('unitsSold')} value={String(m!.units_sold)} />
              </div>
            </div>
          ) : null}

          {tab === 'products' ? (
            <>
              <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5">
                {(
                  [
                    ['units', t('sortUnits')],
                    ['revenue', t('sortRevenue')],
                    ['profit', t('sortProfit')],
                    ['margin', t('sortMargin')],
                    ['marginAsc', t('sortMarginAsc')],
                    ['discount', t('sortDiscount')],
                  ] as [RankingSort, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setRankingSort(key)}
                    aria-pressed={rankingSort === key}
                    className={cn(
                      'rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                      rankingSort === key
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Table
                head={[
                  t('tabProducts'),
                  t('units'),
                  t('orderCount'),
                  td('chartRevenue'),
                  td('discounts'),
                  to('cost'),
                  to('profit'),
                  to('margin'),
                ]}
                rows={ranking.map((row) => [
                  <span key="n" className="block max-w-[220px] truncate">{row.product_name}</span>,
                  row.units_sold,
                  row.order_count,
                  formatCents(row.net_revenue_cents),
                  row.discount_cents > 0 ? `− ${formatCents(row.discount_cents)}` : '—',
                  formatCents(row.cogs_cents),
                  <Money key="p" cents={row.gross_profit_cents} signed />,
                  <MarginBadge
                    key="m"
                    profitCents={row.gross_profit_cents}
                    netCents={row.net_revenue_cents}
                  />,
                ])}
              />
            </>
          ) : null}

          {tab === 'sellers' ? (
            <Table
              head={[to('seller'), t('orderCount'), td('chartRevenue'), to('profit'), td('avgTicket')]}
              rows={(data?.sellers ?? []).map((row) => [
                row.seller_name,
                row.order_count,
                formatCents(row.net_revenue_cents),
                <Money key="p" cents={row.gross_profit_cents} signed />,
                formatCents(row.avg_ticket_cents),
              ])}
            />
          ) : null}

          {tab === 'customers' ? (
            <Table
              head={[
                to('customer'),
                t('orderCount'),
                t('totalSpent'),
                to('profit'),
                t('firstOrder'),
                t('lastOrder'),
              ]}
              rows={(data?.customers ?? []).map((row) => [
                row.contact_id.slice(0, 8),
                row.order_count,
                formatCents(row.net_revenue_cents),
                <Money key="p" cents={row.gross_profit_cents} signed />,
                formatDateBR(row.first_order_at),
                formatDateBR(row.last_order_at),
              ])}
            />
          ) : null}

          {tab === 'expenses' ? (
            <Table
              head={[t('tabExpenses'), tc('total'), t('orderCount')]}
              rows={(data?.expenses ?? []).map((row) => [
                row.category_name,
                formatCents(row.amount_cents),
                row.entry_count,
              ])}
            />
          ) : null}

          {tab === 'status' ? (
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5">
              {KANBAN_COLUMNS.map((status) => (
                <div
                  key={status}
                  className="rounded-lg border border-border px-3 py-2.5"
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        ORDER_STATUS_META[status].dotClass
                      )}
                    />
                    <span className="truncate text-xs text-muted-foreground">
                      {to(statusKey(status))}
                    </span>
                  </span>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                    {data?.statusCounts?.[status] ?? 0}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function Table({
  head,
  rows,
}: {
  head: string[];
  rows: (React.ReactNode | string | number)[][];
}) {
  const t = useTranslations('Reports');

  if (rows.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-sm text-muted-foreground">
        {t('empty')}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            {head.map((label, i) => (
              <th
                key={label}
                className={cn(
                  'px-3 py-2.5 font-medium',
                  i === 0 ? 'text-left' : 'text-right'
                )}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr
              key={rowIndex}
              className="border-b border-border/60 last:border-0 hover:bg-muted/40"
            >
              {cells.map((cell, i) => (
                <td
                  key={i}
                  className={cn(
                    'px-3 py-2.5',
                    i === 0
                      ? 'text-left text-foreground'
                      : 'text-right tabular-nums text-muted-foreground'
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
