'use client';

// ============================================================
// Clientes da plataforma (§6, §7).
//
// Cada linha é uma conta Master. Mostra o que administrar a
// plataforma exige — titular para contato, tamanho, uso, status — e
// nada da operação interna: nem clientes finais, nem produtos, nem
// pedidos individuais (§53).
//
// Bloquear NÃO apaga nada. O diálogo diz isso explicitamente, porque
// é a dúvida de quem está prestes a clicar.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Building2, Search, ShieldBan, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { commerceMutate, useCommerceFetch } from '@/hooks/use-commerce';
import {
  EmptyState,
  ErrorState,
  formatDateBR,
  PageHeader,
  Skeleton,
} from '@/components/commerce/primitives';
import { formatCents } from '@/lib/commerce/money';
import type { AccountStatus, PlatformCustomer } from '@/lib/platform/repo';

interface Payload {
  rows: PlatformCustomer[];
  total: number;
  page: number;
  pageSize: number;
}

const STATUS_META: Record<
  AccountStatus,
  { labelKey: string; chip: string; dot: string }
> = {
  active: {
    labelKey: 'statusActive',
    chip: 'border-emerald-600/25 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
    dot: 'bg-emerald-600',
  },
  suspended: {
    labelKey: 'statusSuspended',
    chip: 'border-amber-600/25 bg-amber-600/10 text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  blocked: {
    labelKey: 'statusBlocked',
    chip: 'border-red-600/25 bg-red-600/8 text-red-700 dark:text-red-400',
    dot: 'bg-red-600',
  },
};

export default function AdminCustomersPage() {
  const t = useTranslations('Admin');
  const tc = useTranslations('Commerce');

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<AccountStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const [alvo, setAlvo] = useState<PlatformCustomer | null>(null);

  // Debounce da busca: sem isso é uma requisição por tecla digitada,
  // e a resposta de "op" pode chegar depois da de "operza".
  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (debounced.trim()) p.set('search', debounced.trim());
    if (status !== 'all') p.set('status', status);
    return p.toString();
  }, [debounced, status, page]);

  const { data, error, loading, reload } = useCommerceFetch<Payload>(
    `/api/platform/customers?${query}`
  );

  const rows = data?.rows ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <PageHeader title={t('navCustomers')} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            placeholder={tc('search')}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-8 text-sm"
          />
        </div>

        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
          {(
            [
              ['all', t('filterAll')],
              ['active', t('statusActive')],
              ['suspended', t('statusSuspended')],
              ['blocked', t('statusBlocked')],
            ] as [AccountStatus | 'all', string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setStatus(key);
                setPage(1);
              }}
              aria-pressed={status === key}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                status === key
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Building2 className="h-6 w-6" />}
          title={
            debounced.trim() || status !== 'all'
              ? t('noResults')
              : t('noCustomers')
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t('customer')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-left font-medium md:table-cell">
                    {t('owner')}
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    {t('members')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">
                    {t('orders')}
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    {t('volumeAllTime')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">
                    {t('lastActivity')}
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">Status</th>
                  <th className="w-24 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const meta = STATUS_META[c.status];
                  return (
                    <tr
                      key={c.account_id}
                      className="border-b border-border/60 last:border-0 hover:bg-muted/40"
                    >
                      <td className="px-4 py-2.5">
                        <span className="block truncate font-medium text-foreground">
                          {c.account_name}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {formatDateBR(c.created_at)}
                          {c.team_enabled ? ' · equipe' : ''}
                        </span>
                      </td>
                      <td className="hidden max-w-[220px] px-3 py-2.5 md:table-cell">
                        <span className="block truncate text-foreground">
                          {c.owner_name || '—'}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {c.owner_email}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {c.member_count}
                        {c.seller_count > 0 ? (
                          <span className="text-[11px]"> ({c.seller_count})</span>
                        ) : null}
                      </td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                        {c.order_count}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium text-foreground">
                        {formatCents(c.volume_cents)}
                      </td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground lg:table-cell">
                        {c.last_activity_at
                          ? formatDateBR(c.last_activity_at)
                          : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium',
                            meta.chip
                          )}
                        >
                          <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
                          {t(meta.labelKey)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-7 text-xs"
                          onClick={() => setAlvo(c)}
                        >
                          {c.status === 'active' ? (
                            <ShieldBan className="mr-1 h-3.5 w-3.5" />
                          ) : (
                            <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                          )}
                          {c.status === 'active' ? t('block') : t('reactivate')}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
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

      {alvo ? (
        <StatusDialog
          customer={alvo}
          onClose={() => setAlvo(null)}
          onDone={() => {
            setAlvo(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function StatusDialog({
  customer,
  onClose,
  onDone,
}: {
  customer: PlatformCustomer;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('Admin');
  const tc = useTranslations('Commerce');

  const [novo, setNovo] = useState<AccountStatus>(
    customer.status === 'active' ? 'blocked' : 'active'
  );
  const [motivo, setMotivo] = useState(customer.status_reason ?? '');
  const [saving, setSaving] = useState(false);

  async function aplicar() {
    setSaving(true);
    try {
      await commerceMutate('/api/platform/customers', 'PATCH', {
        account_id: customer.account_id,
        status: novo,
        reason: novo === 'active' ? null : motivo,
      });
      toast.success(t('statusChanged'));
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tc('loadError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={tc('close')}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-background/70 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5"
      >
        <h2 className="text-sm font-semibold text-foreground">
          {t('blockTitle')}
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {customer.account_name}
        </p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {(['active', 'suspended', 'blocked'] as AccountStatus[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setNovo(s)}
              aria-pressed={novo === s}
              className={cn(
                'rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                novo === s
                  ? STATUS_META[s].chip
                  : 'border-border text-muted-foreground hover:bg-muted'
              )}
            >
              {t(STATUS_META[s].labelKey)}
            </button>
          ))}
        </div>

        {novo !== 'active' ? (
          <div className="mt-4">
            <Label htmlFor="motivo" className="text-xs text-muted-foreground">
              {t('blockReason')}
            </Label>
            <Textarea
              id="motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={2}
              className="mt-1 resize-none text-sm"
            />
          </div>
        ) : null}

        <p className="mt-4 rounded-lg border border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {t('blockWarning')}
        </p>

        <div className="mt-4 flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={onClose}
            disabled={saving}
          >
            {tc('cancel')}
          </Button>
          <Button className="flex-1" onClick={aplicar} disabled={saving}>
            {saving ? tc('saving') : tc('save')}
          </Button>
        </div>
      </div>
    </>
  );
}
