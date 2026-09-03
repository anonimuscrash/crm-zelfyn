'use client';

// ============================================================
// Orders table (§14).
//
// The board is for working orders through fulfilment; this is for
// interrogating them. Hence the columns nobody wants on a card —
// cost, profit, margin, seller — and filters that compose.
//
// Every filter is a server query parameter. Nothing here filters a
// pre-loaded array, so the result count is the true count and page 7
// is really page 7.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Search, ShoppingCart } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
} from '@/components/commerce/primitives';
import { NewSaleDrawer } from '@/components/commerce/new-sale-drawer';
import { OrderDetailDrawer } from '@/components/commerce/order-detail-drawer';
import { formatCents } from '@/lib/commerce/money';
import { KANBAN_COLUMNS, ORDER_STATUS_META } from '@/lib/commerce/order-status';
import type { PeriodSelection } from '@/lib/commerce/periods';
import type { OrderRow, OrderStatus, Paginated } from '@/lib/commerce/types';

function statusKey(status: OrderStatus): string {
  return `status${status.replace(/(^|_)(\w)/g, (_, __, c: string) =>
    c.toUpperCase()
  )}`;
}

export default function OrdersPage() {
  const t = useTranslations('Orders');
  const tc = useTranslations('Commerce');

  const [period, setPeriod] = useState<PeriodSelection>({ preset: 'last30' });
  const [search, setSearch] = useState('');
  const [statuses, setStatuses] = useState<OrderStatus[]>([]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<
    'ordered_at' | 'net_revenue_cents' | 'gross_profit_cents' | 'order_number'
  >('ordered_at');
  const [saleOpen, setSaleOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams(periodQuery(period));
    params.set('page', String(page));
    params.set('pageSize', '25');
    params.set('sort', sort);
    if (search.trim()) params.set('search', search.trim());
    for (const s of statuses) params.append('status', s);
    return params.toString();
  }, [period, page, sort, search, statuses]);

  const { data, error, loading, reload } = useCommerceFetch<
    Paginated<OrderRow>
  >(`/api/commerce/orders?${query}`);

  const rows = data?.rows ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const toggleStatus = (status: OrderStatus) => {
    setPage(1);
    setStatuses((current) =>
      current.includes(status)
        ? current.filter((s) => s !== status)
        : [...current, status]
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1600px]">
      <PageHeader
        title={t('title')}
        actions={
          <Button size="sm" onClick={() => setSaleOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {tc('newSale')}
          </Button>
        }
      />

      <div className="mb-3">
        <PeriodFilter value={period} onChange={setPeriod} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            placeholder={tc('search')}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="h-9 pl-8 text-sm"
          />
        </div>

        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as typeof sort);
            setPage(1);
          }}
          className="h-9 rounded-lg border border-input bg-card px-2.5 text-[13px] text-foreground"
        >
          <option value="ordered_at">{t('date')}</option>
          <option value="net_revenue_cents">{t('netValue')}</option>
          <option value="gross_profit_cents">{t('profit')}</option>
          <option value="order_number">{t('number')}</option>
        </select>

        {statuses.length > 0 ? (
          <Button
            size="sm"
            variant="secondary"
            className="h-9 text-xs"
            onClick={() => {
              setStatuses([]);
              setPage(1);
            }}
          >
            {tc('clearFilters')}
          </Button>
        ) : null}
      </div>

      {/* Status chips: multi-select, because "show me everything not
          yet shipped" is two clicks, not a dropdown per status. */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {KANBAN_COLUMNS.map((status) => {
          const active = statuses.includes(status);
          return (
            <button
              key={status}
              type="button"
              onClick={() => toggleStatus(status)}
              aria-pressed={active}
              className={cn(
                'rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                active
                  ? ORDER_STATUS_META[status].chipClass
                  : 'border-border text-muted-foreground hover:bg-muted'
              )}
            >
              {t(statusKey(status))}
            </button>
          );
        })}
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ShoppingCart className="h-6 w-6" />}
          title={
            search.trim() || statuses.length > 0
              ? t('noResults')
              : t('emptyTitle')
          }
          description={
            search.trim() || statuses.length > 0 ? undefined : t('emptyBody')
          }
          action={
            search.trim() || statuses.length > 0 ? undefined : (
              <Button size="sm" onClick={() => setSaleOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                {tc('newSale')}
              </Button>
            )
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t('number')}
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    {t('customer')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">
                    {t('grossValue')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">
                    {t('discount')}
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    {t('netValue')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">
                    {t('cost')}
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    {t('profit')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">
                    {t('margin')}
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    {t('status')}
                  </th>
                  <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">
                    {t('date')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr
                    key={order.id}
                    onClick={() => setDetailId(order.id)}
                    className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/40"
                  >
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      #{order.order_number}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2.5 text-foreground">
                      {order.customer_name_snapshot ??
                        order.customer_phone_snapshot ??
                        '—'}
                    </td>
                    <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                      {formatCents(order.gross_cents)}
                    </td>
                    <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground md:table-cell">
                      {order.discount_total_cents > 0
                        ? `− ${formatCents(order.discount_total_cents)}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-foreground">
                      {formatCents(order.net_revenue_cents)}
                    </td>
                    <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground lg:table-cell">
                      {formatCents(order.direct_costs_cents)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Money cents={order.gross_profit_cents} signed />
                    </td>
                    <td className="hidden px-3 py-2.5 text-right lg:table-cell">
                      <MarginBadge
                        profitCents={order.gross_profit_cents}
                        netCents={order.net_revenue_cents}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          'inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium',
                          ORDER_STATUS_META[order.status].chipClass
                        )}
                      >
                        {t(statusKey(order.status))}
                      </span>
                    </td>
                    <td className="hidden px-4 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                      {formatDateBR(order.ordered_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            <span>{tc('resultCount', { count: data?.total ?? 0 })}</span>
            {pages > 1 ? (
              <span className="flex items-center gap-1.5">
                <span>{tc('pageOf', { page, pages })}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-xs"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {tc('previous')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-xs"
                  disabled={page >= pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {tc('next')}
                </Button>
              </span>
            ) : null}
          </div>
        </div>
      )}

      <NewSaleDrawer
        open={saleOpen}
        onClose={() => setSaleOpen(false)}
        onCreated={reload}
      />
      <OrderDetailDrawer
        orderId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={reload}
      />
    </div>
  );
}
