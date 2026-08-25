'use client';

// ============================================================
// Order detail drawer.
//
// Opened from the board or the table. Its job is to answer "where
// did the money on this sale actually go" — so the layout is a
// statement, not a form: gross, what was given away, what it cost,
// what was left.
//
// Status is editable here as a full ten-option list. The board only
// exposes the columns; this is where an operator marks something
// refunded without dragging it across nine columns.
// ============================================================

import { useTranslations } from 'next-intl';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { commerceMutate, useCommerceFetch } from '@/hooks/use-commerce';
import {
  ErrorState,
  formatDateTimeBR,
  StatementRow,
} from '@/components/commerce/primitives';
import { formatBp, formatCents, marginBp } from '@/lib/commerce/money';
import {
  KANBAN_COLUMNS,
  ORDER_STATUS_META,
} from '@/lib/commerce/order-status';
import type { OrderStatus, OrderWithItems } from '@/lib/commerce/types';

function statusKey(status: OrderStatus): string {
  return `status${status.replace(/(^|_)(\w)/g, (_, __, c: string) =>
    c.toUpperCase()
  )}`;
}

export function OrderDetailDrawer({
  orderId,
  onClose,
  onChanged,
}: {
  orderId: string | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const t = useTranslations('Orders');
  const tc = useTranslations('Commerce');

  const { data, error, loading, reload } = useCommerceFetch<OrderWithItems>(
    orderId ? `/api/commerce/orders/${orderId}` : null
  );

  async function setStatus(status: OrderStatus) {
    if (!orderId) return;
    try {
      await commerceMutate(`/api/commerce/orders/${orderId}`, 'PATCH', {
        status,
      });
      toast.success(t('statusUpdated'));
      reload();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tc('loadError'));
    }
  }

  if (!orderId) return null;

  return (
    <>
      <button
        type="button"
        aria-label={tc('close')}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-background/70 backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-border bg-card"
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="text-sm font-semibold text-foreground">
            {data ? t('detailTitle', { number: data.order_number }) : tc('loading')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={tc('close')}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : loading || !data ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-5">
              {/* ---- Customer + date ---- */}
              <section>
                <p className="text-sm font-medium text-foreground">
                  {data.customer_name_snapshot ??
                    data.customer_phone_snapshot ??
                    '—'}
                </p>
                {data.customer_phone_snapshot &&
                data.customer_name_snapshot ? (
                  <p className="text-xs text-muted-foreground">
                    {data.customer_phone_snapshot}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDateTimeBR(data.ordered_at)}
                </p>
              </section>

              {/* ---- Status picker ---- */}
              <section>
                <p className="mb-1.5 text-xs text-muted-foreground">
                  {t('status')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {KANBAN_COLUMNS.map((status) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => setStatus(status)}
                      aria-pressed={data.status === status}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                        data.status === status
                          ? ORDER_STATUS_META[status].chipClass
                          : 'border-border text-muted-foreground hover:bg-muted'
                      )}
                    >
                      {t(statusKey(status))}
                    </button>
                  ))}
                </div>
              </section>

              {/* ---- Lines ---- */}
              <section>
                <p className="mb-1.5 text-xs text-muted-foreground">
                  {t('items')}
                </p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {data.order_items.map((item) => {
                    const gross = item.unit_price_cents * item.quantity;
                    return (
                      <li key={item.id} className="px-3 py-2.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                            {item.product_name}
                          </span>
                          <span className="shrink-0 tabular-nums text-[13px] text-foreground">
                            {formatCents(gross - item.discount_cents)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                          {item.quantity} ×{' '}
                          {formatCents(item.unit_price_cents)}
                          {item.discount_cents > 0
                            ? ` · −${formatCents(item.discount_cents)}`
                            : ''}
                          {' · '}
                          {t('cost')} {formatCents(
                            item.unit_cost_cents * item.quantity
                          )}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* ---- Financial breakdown ---- */}
              <section className="rounded-lg border border-border p-3">
                <p className="mb-1 text-xs font-medium text-foreground">
                  {t('breakdown')}
                </p>
                <StatementRow
                  label={t('grossValue')}
                  valueCents={data.gross_cents}
                />
                {data.discount_total_cents > 0 ? (
                  <StatementRow
                    label={t('discount')}
                    valueCents={data.discount_total_cents}
                    negative
                    indent
                  />
                ) : null}
                <StatementRow
                  label={t('netValue')}
                  valueCents={data.net_revenue_cents}
                  emphasis
                />
                <StatementRow
                  label={t('cost')}
                  valueCents={data.cogs_cents}
                  negative
                  indent
                />
                {data.shipping_cost_cents > 0 ? (
                  <StatementRow
                    label={t('shipping')}
                    valueCents={data.shipping_cost_cents}
                    negative
                    indent
                  />
                ) : null}
                {data.payment_fee_cents > 0 ? (
                  <StatementRow
                    label={tc('total')}
                    valueCents={data.payment_fee_cents}
                    negative
                    indent
                  />
                ) : null}
                {data.order_costs.map((cost) => (
                  <StatementRow
                    key={cost.id}
                    label={cost.label}
                    valueCents={cost.amount_cents}
                    negative
                    indent
                  />
                ))}
                <StatementRow
                  label={t('profit')}
                  valueCents={data.gross_profit_cents}
                  emphasis
                />
                <p className="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">
                  {t('margin')}{' '}
                  {data.net_revenue_cents === 0
                    ? '—'
                    : formatBp(
                        marginBp(
                          data.gross_profit_cents,
                          data.net_revenue_cents
                        )
                      )}
                </p>
              </section>

              {/* ---- Shipping ---- */}
              {data.tracking_code || data.shipping_carrier ? (
                <section className="rounded-lg border border-border p-3 text-[13px]">
                  <p className="mb-1 text-xs font-medium text-foreground">
                    {t('shipping')}
                  </p>
                  {data.shipping_carrier ? (
                    <p className="text-muted-foreground">
                      {t('carrier')}: {data.shipping_carrier}
                    </p>
                  ) : null}
                  {data.tracking_code ? (
                    <p className="text-muted-foreground">
                      {t('trackingCode')}: {data.tracking_code}
                    </p>
                  ) : null}
                </section>
              ) : null}

              {data.notes ? (
                <section>
                  <p className="mb-1 text-xs text-muted-foreground">
                    {t('notes')}
                  </p>
                  <p className="whitespace-pre-wrap text-[13px] text-foreground">
                    {data.notes}
                  </p>
                </section>
              ) : null}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
