'use client';

// ============================================================
// Painel de equipe (§46, §15, §47).
//
// Três estados possíveis, e cada um precisa de tratamento próprio:
//
//   1. Vendedor abre a rota  → não deveria ver nada. A RPC recusa,
//      mas redirecionamos para o dashboard em vez de mostrar erro.
//   2. Master com modo equipe DESLIGADO → tela de ativação, não
//      tabela vazia. Quem opera sozinho não tem "equipe de zero
//      pessoas"; tem uma funcionalidade desligada (§56).
//   3. Master com equipe → o painel de verdade.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Info, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { periodQuery, useCommerceFetch } from '@/hooks/use-commerce';
import { useSessionContext } from '@/hooks/use-session-context';
import {
  canManageTeam,
  hasFeature,
  isMaster,
} from '@/lib/auth/permissions';
import {
  EmptyState,
  ErrorState,
  formatDateBR,
  MarginBadge,
  MetricTile,
  Money,
  PageHeader,
  PeriodFilter,
  Skeleton,
} from '@/components/commerce/primitives';
import { sortTeam } from '@/lib/commerce/analytics.repo';
import { deltaBp, formatCents, formatDeltaBp } from '@/lib/commerce/money';
import type { PeriodSelection } from '@/lib/commerce/periods';
import type { TeamMemberRow, TeamSort } from '@/lib/commerce/types';

interface TeamPayload {
  team: TeamMemberRow[];
  previous: TeamMemberRow[];
}

export default function TeamPage() {
  const t = useTranslations('Team');
  const tc = useTranslations('Commerce');
  const router = useRouter();

  const { context, loading: ctxLoading, reload: reloadCtx } =
    useSessionContext();
  const [period, setPeriod] = useState<PeriodSelection>({ preset: 'last30' });
  const [sort, setSort] = useState<TeamSort>('revenue');
  const [enabling, setEnabling] = useState(false);

  const teamOn = hasFeature(context, 'team_enabled');
  const podeVer = isMaster(context);

  // Vendedor que digitou a URL: manda de volta em silêncio. A RPC já
  // recusaria, mas mostrar "sem permissão" para quem nunca deveria
  // ter visto o link é pior que simplesmente não ter a página.
  useEffect(() => {
    if (!ctxLoading && context && !podeVer) {
      router.replace('/dashboard');
    }
  }, [ctxLoading, context, podeVer, router]);

  const { data, error, loading, reload } = useCommerceFetch<TeamPayload>(
    podeVer && teamOn ? `/api/commerce/team?${periodQuery(period)}` : null
  );

  const linhas = useMemo(
    () => sortTeam(data?.team ?? [], sort),
    [data, sort]
  );

  const anteriorPorId = useMemo(() => {
    const m = new Map<string, TeamMemberRow>();
    for (const r of data?.previous ?? []) m.set(r.user_id, r);
    return m;
  }, [data]);

  const totais = useMemo(() => {
    const rows = data?.team ?? [];
    return {
      faturamento: rows.reduce((s, r) => s + r.net_revenue_cents, 0),
      lucro: rows.reduce((s, r) => s + r.gross_profit_cents, 0),
      pedidos: rows.reduce((s, r) => s + r.order_count, 0),
      vendedores: rows.filter((r) => r.account_role === 'agent').length,
    };
  }, [data]);

  async function ativarEquipe() {
    setEnabling(true);
    try {
      const res = await fetch('/api/commerce/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_enabled: true }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? tc('loadError'));
      }
      toast.success(t('enabled'));
      reloadCtx();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tc('loadError'));
    } finally {
      setEnabling(false);
    }
  }

  if (ctxLoading || !context) {
    return (
      <div className="mx-auto w-full max-w-[1400px] space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (!podeVer) return null;

  // ---- Modo equipe desligado ----
  if (!teamOn) {
    return (
      <div className="mx-auto w-full max-w-[1400px]">
        <PageHeader title={t('title')} />
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title={t('disabledTitle')}
          description={t('disabledBody')}
          action={
            <Button
              size="sm"
              onClick={ativarEquipe}
              disabled={enabling || !canManageTeam(context)}
            >
              {enabling ? tc('saving') : t('enable')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <PageHeader
        title={t('title')}
        actions={
          <Button size="sm" onClick={() => router.push('/settings?tab=members')}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            {t('invite')}
          </Button>
        }
      />

      <PeriodFilter value={period} onChange={setPeriod} className="mb-5" />

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      ) : linhas.length === 0 ? (
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title={t('emptyTitle')}
          description={t('emptyBody')}
        />
      ) : (
        <div className="space-y-5">
          {/* ---- Consolidado ---- */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricTile label={t('revenue')} valueCents={totais.faturamento} />
            <MetricTile
              label={t('profit')}
              valueCents={totais.lucro}
              tone="positive"
            />
            <MetricTile label={t('orders')} rawValue={String(totais.pedidos)} />
            <MetricTile
              label={t('seller')}
              rawValue={String(totais.vendedores)}
            />
          </div>

          {/* ---- Ranking ---- */}
          <section className="rounded-lg border border-border bg-card">
            <header className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                {t('ranking')}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ['revenue', t('sortRevenue')],
                    ['profit', t('sortProfit')],
                    ['orders', t('sortOrders')],
                    ['ticket', t('sortTicket')],
                    ['margin', t('sortMargin')],
                  ] as [TeamSort, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSort(key)}
                    aria-pressed={sort === key}
                    className={cn(
                      'rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                      sort === key
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </header>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-medium">
                      {t('seller')}
                    </th>
                    <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">
                      {t('salesToday')}
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      {t('orders')}
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      {t('revenue')}
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      {t('profit')}
                    </th>
                    <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">
                      {t('avgTicket')}
                    </th>
                    <th className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">
                      {t('margin')}
                    </th>
                    <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">
                      {t('lastActivity')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((m, i) => {
                    const ant = anteriorPorId.get(m.user_id);
                    const delta = ant
                      ? deltaBp(m.net_revenue_cents, ant.net_revenue_cents)
                      : null;

                    return (
                      <tr
                        key={m.user_id}
                        className="border-b border-border/60 last:border-0 hover:bg-muted/40"
                      >
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-2.5">
                            <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                              {i + 1}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-foreground">
                                {m.full_name || m.email || '—'}
                              </span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {m.account_role === 'owner' ||
                                m.account_role === 'admin'
                                  ? t('roleMaster')
                                  : m.account_role === 'agent'
                                    ? t('roleSeller')
                                    : t('roleViewer')}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                          {m.today_order_count > 0
                            ? formatCents(m.today_net_revenue_cents)
                            : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                          {m.order_count}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span className="block tabular-nums font-medium text-foreground">
                            {formatCents(m.net_revenue_cents)}
                          </span>
                          {delta !== null ? (
                            <span
                              className={cn(
                                'block text-[11px] tabular-nums',
                                delta > 0
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : delta < 0
                                    ? 'text-red-700 dark:text-red-400'
                                    : 'text-muted-foreground'
                              )}
                            >
                              {formatDeltaBp(delta)}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Money cents={m.gross_profit_cents} signed />
                        </td>
                        <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground md:table-cell">
                          {formatCents(m.avg_ticket_cents)}
                        </td>
                        <td className="hidden px-3 py-2.5 text-right lg:table-cell">
                          <MarginBadge
                            profitCents={m.gross_profit_cents}
                            netCents={m.net_revenue_cents}
                          />
                        </td>
                        <td className="hidden px-4 py-2.5 text-right tabular-nums text-muted-foreground lg:table-cell">
                          {m.last_seen_at
                            ? formatDateBR(m.last_seen_at)
                            : t('neverSold')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('expensesNote')}
          </p>
        </div>
      )}
    </div>
  );
}
