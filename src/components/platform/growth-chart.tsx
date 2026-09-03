'use client';

// ============================================================
// Gráfico de crescimento da plataforma.
//
// Quatro séries alternáveis, uma por vez. Sobrepor "contas novas"
// (unidades) e "volume" (reais) no mesmo eixo produziria uma linha
// colada no zero e outra no topo — dois eixos Y resolveriam, mas
// gráfico de eixo duplo é notoriamente fácil de ler errado. Alternar
// é mais honesto.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { cn } from '@/lib/utils';
import { formatCents, formatCentsCompact } from '@/lib/commerce/money';
import type { SeriesBucket } from '@/lib/commerce/periods';
import type { GrowthPoint } from '@/lib/platform/repo';

type Metric = 'accounts' | 'users' | 'orders' | 'volume';

const METRICS: { key: Metric; labelKey: string; money: boolean }[] = [
  { key: 'accounts', labelKey: 'growthAccounts', money: false },
  { key: 'users', labelKey: 'growthUsers', money: false },
  { key: 'orders', labelKey: 'growthOrders', money: false },
  { key: 'volume', labelKey: 'growthVolume', money: true },
];

function pick(p: GrowthPoint, m: Metric): number {
  switch (m) {
    case 'accounts':
      return p.new_accounts;
    case 'users':
      return p.new_users;
    case 'orders':
      return p.order_count;
    case 'volume':
      return p.volume_cents;
  }
}

function label(iso: string, bucket: SeriesBucket): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (bucket === 'hour') {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  }
  if (bucket === 'month') {
    return new Intl.DateTimeFormat('pt-BR', {
      month: 'short',
      year: '2-digit',
    }).format(d);
  }
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
  }).format(d);
}

export function GrowthChart({
  points,
  bucket,
  loading,
}: {
  points: GrowthPoint[];
  bucket: SeriesBucket;
  loading?: boolean;
}) {
  const t = useTranslations('Admin');
  const [metric, setMetric] = useState<Metric>('accounts');

  const isMoney = METRICS.find((m) => m.key === metric)?.money ?? false;

  const rows = useMemo(
    () =>
      points.map((p) => ({
        label: label(p.bucket_start, bucket),
        value: pick(p, metric),
      })),
    [points, bucket, metric]
  );

  const temDados = rows.some((r) => r.value !== 0);

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('growth')}</h2>
        <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border p-0.5">
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
      </header>

      <div className="h-[260px] px-2 py-4">
        {loading ? (
          <div className="h-full w-full animate-pulse rounded bg-muted/50" />
        ) : !temDados ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">{t('noActivity')}</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {/* Barras, não linha: crescimento é contagem por período,
                e uma linha ligando contagens discretas sugere
                continuidade que não existe entre um dia e o outro. */}
            <BarChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
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
                minTickGap={24}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={isMoney ? 64 : 36}
                allowDecimals={false}
                tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                tickFormatter={(v: number) =>
                  isMoney ? formatCentsCompact(v) : String(v)
                }
              />
              <Tooltip
                cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
                contentStyle={{
                  background: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 12,
                  boxShadow: 'none',
                }}
                labelStyle={{ color: 'var(--muted-foreground)' }}
                formatter={(value) => [
                  isMoney
                    ? formatCents(typeof value === 'number' ? value : 0)
                    : String(value),
                  t(METRICS.find((m) => m.key === metric)!.labelKey),
                ]}
              />
              <Bar
                dataKey="value"
                fill="var(--primary)"
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
