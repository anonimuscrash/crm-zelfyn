'use client';

// ============================================================
// Order board (§13).
//
// Drag-and-drop moves the order's real status: the card is updated
// optimistically for responsiveness, then the PATCH goes out, and a
// failure rolls the card back and says so. Silently leaving a card
// in the new column after a failed write would be worse than not
// having the board — the operator would ship against a lie.
//
// @dnd-kit is already a project dependency (the pipelines screen
// uses it), so this adds no new package.
// ============================================================

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Plus, ShoppingCart, Truck } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { commerceMutate, periodQuery, useCommerceFetch } from '@/hooks/use-commerce';
import {
  EmptyState,
  ErrorState,
  formatDateBR,
  PageHeader,
  PeriodFilter,
  Skeleton,
} from '@/components/commerce/primitives';
import { NewSaleDrawer } from '@/components/commerce/new-sale-drawer';
import { OrderDetailDrawer } from '@/components/commerce/order-detail-drawer';
import { formatCents } from '@/lib/commerce/money';
import {
  isOrderStatus,
  KANBAN_COLUMNS,
  ORDER_STATUS_META,
} from '@/lib/commerce/order-status';
import type { PeriodSelection } from '@/lib/commerce/periods';
import type { OrderRow, OrderStatus } from '@/lib/commerce/types';

interface BoardPayload {
  orders: OrderRow[];
  counts: Partial<Record<OrderStatus, number>>;
}

/** `awaiting_shipment` → `statusAwaitingShipment`. */
function statusKey(status: OrderStatus): string {
  return `status${status.replace(/(^|_)(\w)/g, (_, __, c: string) =>
    c.toUpperCase()
  )}`;
}

export default function KanbanPage() {
  const t = useTranslations('Kanban');
  const to = useTranslations('Orders');
  const tc = useTranslations('Commerce');

  const [period, setPeriod] = useState<PeriodSelection>({ preset: 'last30' });
  const [saleOpen, setSaleOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<OrderRow | null>(null);

  const { data, error, loading, reload } = useCommerceFetch<BoardPayload>(
    `/api/commerce/orders?view=board&${periodQuery(period)}`
  );

  // Optimistic status overrides layered over the server payload.
  //
  // Deliberately NOT a `useState` mirror synced by an effect: copying
  // fetched data into state on every response triggers a cascading
  // render and, worse, makes the board's source of truth ambiguous
  // while a refetch is in flight. An override map applied at render
  // time keeps the server response authoritative and the drag
  // instantaneous, and a failed write just drops its own key.
  const [overrides, setOverrides] = useState<Record<string, OrderStatus>>({});

  const orders = useMemo<OrderRow[]>(() => {
    const rows = data?.orders ?? [];
    return rows.map((order) =>
      overrides[order.id] ? { ...order, status: overrides[order.id] } : order
    );
  }, [data, overrides]);

  const sensors = useSensors(
    // 6px activation distance: without it, every click on a card is
    // interpreted as a micro-drag and the detail drawer never opens.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const byStatus = useMemo(() => {
    const map = new Map<OrderStatus, OrderRow[]>();
    for (const status of KANBAN_COLUMNS) map.set(status, []);
    for (const order of orders) {
      map.get(order.status)?.push(order);
    }
    return map;
  }, [orders]);

  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDragging(null);
      const orderId = String(event.active.id);
      const target = event.over?.id ? String(event.over.id) : null;
      if (!target || !isOrderStatus(target)) return;

      const order = orders.find((o) => o.id === orderId);
      if (!order || order.status === target) return;

      setOverrides((current) => ({ ...current, [orderId]: target }));

      try {
        await commerceMutate(`/api/commerce/orders/${orderId}`, 'PATCH', {
          status: target,
        });
        toast.success(to('statusUpdated'));
      } catch (err) {
        // Roll back — the board must never show a status the
        // database did not accept.
        setOverrides((current) => {
          const next = { ...current };
          delete next[orderId];
          return next;
        });
        toast.error(err instanceof Error ? err.message : t('moveError'));
      }
    },
    [orders, t, to]
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col">
      <PageHeader
        title={t('title')}
        actions={
          <Button size="sm" onClick={() => setSaleOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {tc('newSale')}
          </Button>
        }
      />

      <PeriodFilter value={period} onChange={setPeriod} className="mb-4" />

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="flex gap-3 overflow-x-auto">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-[264px] shrink-0 rounded-lg" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <EmptyState
          icon={<ShoppingCart className="h-6 w-6" />}
          title={to('emptyTitle')}
          description={to('emptyBody')}
          action={
            <Button size="sm" onClick={() => setSaleOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {tc('newSale')}
            </Button>
          }
        />
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={(e: DragStartEvent) =>
            setDragging(orders.find((o) => o.id === String(e.active.id)) ?? null)
          }
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          {/* Horizontal scroll on every viewport — a Kanban that wraps
              its columns stops being a board. */}
          <div className="flex flex-1 gap-3 overflow-x-auto pb-4">
            {KANBAN_COLUMNS.map((status) => (
              <Column
                key={status}
                status={status}
                label={to(statusKey(status))}
                orders={byStatus.get(status) ?? []}
                onOpen={setDetailId}
              />
            ))}
          </div>

          <DragOverlay dropAnimation={null}>
            {dragging ? (
              <OrderCard order={dragging} onOpen={() => undefined} dragging />
            ) : null}
          </DragOverlay>
        </DndContext>
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

function Column({
  status,
  label,
  orders,
  onOpen,
}: {
  status: OrderStatus;
  label: string;
  orders: OrderRow[];
  onOpen: (id: string) => void;
}) {
  const t = useTranslations('Kanban');
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = ORDER_STATUS_META[status];

  const total = orders.reduce((sum, o) => sum + o.net_revenue_cents, 0);

  return (
    <section
      ref={setNodeRef}
      className={cn(
        'flex w-[264px] shrink-0 flex-col rounded-lg border bg-card transition-colors',
        isOver ? 'border-primary/50 bg-primary/[0.03]' : 'border-border'
      )}
    >
      <header className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={cn('h-1.5 w-1.5 rounded-full', meta.dotClass)} />
          <h2 className="flex-1 truncate text-[13px] font-medium text-foreground">
            {label}
          </h2>
          <span className="tabular-nums text-xs text-muted-foreground">
            {orders.length}
          </span>
        </div>
        {total > 0 ? (
          <p className="mt-0.5 pl-3.5 text-[11px] tabular-nums text-muted-foreground">
            {formatCents(total)}
          </p>
        ) : null}
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {orders.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-muted-foreground">
            {t('emptyColumn')}
          </p>
        ) : (
          orders.map((order) => (
            <OrderCard key={order.id} order={order} onOpen={onOpen} />
          ))
        )}
      </div>
    </section>
  );
}

function OrderCard({
  order,
  onOpen,
  dragging = false,
}: {
  order: OrderRow;
  onOpen: (id: string) => void;
  dragging?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: order.id,
  });

  return (
    <article
      ref={dragging ? undefined : setNodeRef}
      {...(dragging ? {} : listeners)}
      {...(dragging ? {} : attributes)}
      onClick={() => onOpen(order.id)}
      className={cn(
        'cursor-grab rounded-lg border border-border bg-card p-2.5 text-left active:cursor-grabbing',
        !dragging && 'hover:border-border hover:bg-muted/50',
        isDragging && 'opacity-30',
        dragging && 'rotate-1 border-primary/40'
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] font-medium text-foreground">
          {order.customer_name_snapshot ??
            order.customer_phone_snapshot ??
            '—'}
        </span>
        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
          #{order.order_number}
        </span>
      </div>

      <p className="mt-1 truncate text-[11px] text-muted-foreground">
        {order.item_count} un.
      </p>

      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="tabular-nums text-[13px] font-medium text-foreground">
          {formatCents(order.net_revenue_cents)}
        </span>
        <span
          className={cn(
            'tabular-nums text-[11px]',
            order.gross_profit_cents < 0
              ? 'text-red-700 dark:text-red-400'
              : 'text-emerald-700 dark:text-emerald-400'
          )}
        >
          {formatCents(order.gross_profit_cents)}
        </span>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{formatDateBR(order.ordered_at)}</span>
        {order.tracking_code ? (
          <span className="flex items-center gap-1">
            <Truck className="h-3 w-3" />
          </span>
        ) : null}
      </div>
    </article>
  );
}
