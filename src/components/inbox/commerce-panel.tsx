'use client';

// ============================================================
// Painel comercial dentro da conversa (§13, §14).
//
// A intenção da Inbox não é ser WhatsApp: é juntar atendimento com
// operação. Enquanto o vendedor conversa, precisa ver quanto aquele
// cliente já comprou, o que costuma levar, e conseguir lançar a
// venda sem sair da tela.
//
// Componente separado em vez de crescer `contact-sidebar.tsx`: a
// sidebar existente cuida de tags, deals e notas, que são do CRM
// original e funcionam. Misturar as duas coisas num arquivo de 500
// linhas tornaria as duas mais difíceis de mudar.
//
// Consome `/api/commerce/customers?contactId=`, que já existia e
// nunca tinha sido plugado em tela nenhuma.
// ============================================================

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, Receipt, ShoppingBag } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCommerceFetch } from '@/hooks/use-commerce';
import { useSessionContext } from '@/hooks/use-session-context';
import { canCreateSale } from '@/lib/auth/permissions';
import { NewSaleDrawer } from '@/components/commerce/new-sale-drawer';
import { formatDateBR, Money } from '@/components/commerce/primitives';
import { formatCents } from '@/lib/commerce/money';
import { CollapsibleSection } from '@/components/inbox/collapsible-section';
import { ORDER_STATUS_META } from '@/lib/commerce/order-status';
import type { CustomerStatsRow, OrderRow } from '@/lib/commerce/types';

interface Payload {
  stats: CustomerStatsRow | null;
  orders: OrderRow[];
  products: { product_name: string; quantity: number }[];
}

function statusKey(status: string): string {
  return `status${status.replace(/(^|_)(\w)/g, (_, __, c: string) =>
    c.toUpperCase()
  )}`;
}

export function CommercePanel({
  contactId,
  contactName,
}: {
  contactId: string | null;
  contactName?: string | null;
}) {
  const t = useTranslations('Inbox.commerce');
  const to = useTranslations('Orders');
  const router = useRouter();

  const { context } = useSessionContext();
  const [saleOpen, setSaleOpen] = useState(false);

  const { data, loading, reload } = useCommerceFetch<Payload>(
    contactId
      ? `/api/commerce/customers?contactId=${encodeURIComponent(contactId)}`
      : null
  );

  if (!contactId) return null;

  const stats = data?.stats ?? null;
  const orders = data?.orders ?? [];
  const podeVender = canCreateSale(context);

  return (
    <>
      <CollapsibleSection
        id="commerce"
        title={t('title')}
        icon={<ShoppingBag className="h-3.5 w-3.5 text-muted-foreground" />}
        badge={stats ? formatCents(stats.net_revenue_cents) : null}
      >

        {loading && !data ? (
          <div className="space-y-2">
            <div className="h-12 animate-pulse rounded bg-muted" />
            <div className="h-12 animate-pulse rounded bg-muted" />
          </div>
        ) : !stats ? (
          // Cliente sem compra é o caso MAIS comum numa conversa nova.
          // Mostrar zeros seria ruído; o que importa aqui é o botão.
          <p className="mb-3 text-[13px] text-muted-foreground">
            {t('noPurchases')}
          </p>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <Metrica rotulo={t('totalSpent')} valor={formatCents(stats.net_revenue_cents)} />
              <Metrica rotulo={t('orders')} valor={String(stats.order_count)} />
              <Metrica rotulo={t('avgTicket')} valor={formatCents(stats.avg_ticket_cents)} />
              <Metrica
                rotulo={t('profit')}
                valor={formatCents(stats.gross_profit_cents)}
                destaque
              />
            </div>

            <p className="mb-3 text-[11px] text-muted-foreground">
              {t('since')} {formatDateBR(stats.first_order_at)}
            </p>
          </>
        )}

        {podeVender ? (
          <Button
            size="sm"
            className="w-full"
            onClick={() => setSaleOpen(true)}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('newSale')}
          </Button>
        ) : null}

        {/* ---- Últimos pedidos ---- */}
        {orders.length > 0 ? (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('recentOrders')}
              </span>
              <button
                type="button"
                onClick={() =>
                  router.push(`/orders?contactId=${encodeURIComponent(contactId)}`)
                }
                className="text-[11px] font-medium text-primary hover:underline"
              >
                {t('seeAll')}
              </button>
            </div>

            <ul className="space-y-1.5">
              {orders.slice(0, 4).map((o) => {
                const meta = ORDER_STATUS_META[o.status];
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => router.push(`/orders?open=${o.id}`)}
                      className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left transition-colors hover:bg-muted"
                    >
                      <span
                        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', meta.dotClass)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] tabular-nums text-foreground">
                          {formatCents(o.net_revenue_cents)}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          #{o.order_number} · {to(statusKey(o.status))}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {formatDateBR(o.ordered_at)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {/* ---- Produtos que costuma comprar ---- */}
        {(data?.products ?? []).length > 0 ? (
          <div className="mt-4">
            <span className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <Receipt className="h-3 w-3" />
              {t('boughtProducts')}
            </span>
            <ul className="space-y-1">
              {(data?.products ?? []).slice(0, 5).map((p) => (
                <li
                  key={p.product_name}
                  className="flex items-baseline justify-between gap-2 text-[12px]"
                >
                  <span className="min-w-0 truncate text-foreground">
                    {p.product_name}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {p.quantity}×
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CollapsibleSection>

      <NewSaleDrawer
        open={saleOpen}
        onClose={() => setSaleOpen(false)}
        onCreated={reload}
        presetContactId={contactId}
        presetContactName={contactName ?? undefined}
      />
    </>
  );
}

function Metrica({
  rotulo,
  valor,
  destaque,
}: {
  rotulo: string;
  valor: string;
  destaque?: boolean;
}) {
  return (
    <div className="rounded-md border border-border px-2 py-1.5">
      <p className="text-[10px] text-muted-foreground">{rotulo}</p>
      <p
        className={cn(
          'mt-0.5 text-[13px] font-medium tabular-nums',
          destaque ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground'
        )}
      >
        {valor}
      </p>
    </div>
  );
}
