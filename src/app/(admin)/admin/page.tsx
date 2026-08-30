'use client';

// ============================================================
// Visão geral da plataforma (§5, §53).
//
// Mede USO do SaaS, não conteúdo dos clientes: quantas contas,
// quantos usuários, quanto volume passou. Nada sobre o que foi
// vendido, para quem, ou por qual produto — administrar a
// plataforma não requer ler a operação de ninguém.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Activity } from 'lucide-react';

import { periodQuery, useCommerceFetch } from '@/hooks/use-commerce';
import {
  ErrorState,
  formatDateTimeBR,
  MetricSkeletonGrid,
  MetricTile,
  PageHeader,
  PeriodFilter,
  Skeleton,
} from '@/components/commerce/primitives';
import { GrowthChart } from '@/components/platform/growth-chart';
import { formatCents } from '@/lib/commerce/money';
import type { PeriodSelection, SeriesBucket } from '@/lib/commerce/periods';
import type {
  ActivityRow,
  GrowthPoint,
  PlatformMetrics,
} from '@/lib/platform/repo';

interface Payload {
  period: { bucket: SeriesBucket };
  metrics: PlatformMetrics;
  previous: PlatformMetrics;
  growth: GrowthPoint[];
  activity: ActivityRow[];
}

export default function AdminOverviewPage() {
  const t = useTranslations('Admin');
  const [period, setPeriod] = useState<PeriodSelection>({ preset: 'last30' });

  const { data, error, loading, reload } = useCommerceFetch<Payload>(
    `/api/platform/metrics?${periodQuery(period)}`
  );

  const m = data?.metrics;
  const prev = data?.previous;

  return (
    <div>
      <PageHeader title={t('title')} />
      <PeriodFilter value={period} onChange={setPeriod} className="mb-5" />

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="space-y-4">
          <MetricSkeletonGrid />
          <Skeleton className="h-[280px] w-full rounded-lg" />
        </div>
      ) : (
        <div className="space-y-5">
          {/* ---- Contas ---- */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricTile
              label={t('accounts')}
              rawValue={String(m!.total_accounts)}
              hint={`${m!.active_accounts} ${t('activeAccounts').toLowerCase()}`}
            />
            <MetricTile
              label={t('newAccounts')}
              rawValue={String(m!.new_accounts)}
              hint={
                prev
                  ? `${prev.new_accounts} ${t('navOverview').toLowerCase()}`
                  : undefined
              }
            />
            <MetricTile
              label={t('users')}
              rawValue={String(m!.total_users)}
              hint={`${m!.total_sellers} ${t('sellers').toLowerCase()}`}
            />
            <MetricTile
              label={t('activeUsers')}
              rawValue={String(m!.active_users)}
              hint={t('activeUsersHint')}
            />
          </div>

          {/* ---- Volume e pedidos ---- */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricTile
              label={t('volume')}
              valueCents={m!.volume_cents}
              previous={prev?.volume_cents}
            />
            <MetricTile
              label={t('orders')}
              rawValue={String(m!.orders_in_period)}
            />
            <MetricTile
              label={t('volumeAllTime')}
              valueCents={m!.volume_all_time_cents}
            />
            <MetricTile
              label={t('ordersAllTime')}
              rawValue={String(m!.total_orders)}
            />
          </div>

          <GrowthChart
            points={data?.growth ?? []}
            bucket={data?.period.bucket ?? 'day'}
            loading={loading}
          />

          <div className="grid gap-5 lg:grid-cols-3">
            {/* ---- Distribuição de status ---- */}
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold text-foreground">
                {t('accounts')}
              </h2>
              <StatusRow
                label={t('activeAccounts')}
                value={m!.active_accounts}
              />
              <StatusRow
                label={t('suspendedAccounts')}
                value={m!.suspended_accounts}
                tone="amber"
              />
              <StatusRow
                label={t('blockedAccounts')}
                value={m!.blocked_accounts}
                tone="red"
              />
              <div className="mt-3 border-t border-border pt-3">
                <StatusRow label={t('teamAccounts')} value={m!.team_accounts} />
                <StatusRow label={t('soloAccounts')} value={m!.solo_accounts} />
              </div>
            </section>

            {/* ---- Atividade ---- */}
            <section className="rounded-lg border border-border bg-card lg:col-span-2">
              <header className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">
                  {t('recentActivity')}
                </h2>
              </header>

              {(data?.activity ?? []).length === 0 ? (
                <p className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
                  <Activity className="h-4 w-4" />
                  {t('noActivity')}
                </p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {(data?.activity ?? []).map((a) => (
                    <li key={a.id} className="px-4 py-2.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                          {a.action}
                          {a.account_name ? (
                            <span className="text-muted-foreground">
                              {' · '}
                              {a.account_name}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {formatDateTimeBR(a.created_at)}
                        </span>
                      </div>
                      {a.actor_label ? (
                        <p className="text-[11px] text-muted-foreground">
                          {t('actor')} {a.actor_label}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'amber' | 'red';
}) {
  return (
    <div className="flex items-baseline justify-between py-1.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span
        className={
          tone === 'amber' && value > 0
            ? 'text-[15px] font-semibold tabular-nums text-amber-700 dark:text-amber-400'
            : tone === 'red' && value > 0
              ? 'text-[15px] font-semibold tabular-nums text-red-700 dark:text-red-400'
              : 'text-[15px] font-semibold tabular-nums text-foreground'
        }
      >
        {value}
      </span>
    </div>
  );
}
