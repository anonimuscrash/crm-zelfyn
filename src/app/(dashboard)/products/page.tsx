'use client';

// ============================================================
// Product catalogue (§9).
//
// The margin column is the reason this screen exists in a sales
// platform rather than an inventory one: an operator should be able
// to see, at a glance, which products are barely worth selling.
//
// Editing a price here reprices FUTURE sales only. That guarantee is
// enforced by the schema (order_items snapshot price and cost at
// write time), and stated in the form so nobody has to trust it
// blindly.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, Trash2, Package, Pencil, Plus, Search } from 'lucide-react';
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
  MoneyInput,
  PageHeader,
  Skeleton,
} from '@/components/commerce/primitives';
import { formatBp, formatCents, marginBp } from '@/lib/commerce/money';
import type { Paginated, ProductRow } from '@/lib/commerce/types';
import { useSessionContext } from '@/hooks/use-session-context';
import { canManageProducts } from '@/lib/auth/permissions';

type StatusFilter = 'all' | 'true' | 'false';

export default function ProductsPage() {
  const t = useTranslations('Products');
  const tc = useTranslations('Commerce');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('true');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ProductRow | 'new' | null>(null);
  const { context } = useSessionContext();
  const podeExcluir = canManageProducts(context);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: '25',
      active: statusFilter,
    });
    if (search.trim()) params.set('search', search.trim());
    return params.toString();
  }, [search, statusFilter, page]);

  const { data, error, loading, reload } =
    useCommerceFetch<Paginated<ProductRow>>(`/api/commerce/products?${query}`);

  const rows = data?.rows ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  async function archive(product: ProductRow) {
    if (!window.confirm(t('confirmArchive'))) return;
    try {
      await commerceMutate(`/api/commerce/products/${product.id}`, 'DELETE');
      toast.success(t('archived'));
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tc('loadError'));
    }
  }

  /**
   * Exclusão definitiva.
   *
   * DIFERENTE DE ARQUIVAR, e a distinção importa: arquivar tira o
   * produto do catálogo mas preserva o histórico — as vendas antigas
   * continuam mostrando o que foi vendido. Excluir some com o
   * cadastro.
   *
   * O backend recusa quando há venda registrada, porque o item do
   * pedido referencia o produto. Por isso o aviso menciona isso: um
   * "não foi possível" sem motivo faria o operador tentar de novo.
   */
  async function remove(product: ProductRow) {
    if (!window.confirm(t('confirmDelete', { name: product.name }))) return;
    try {
      await commerceMutate(
        `/api/commerce/products/${product.id}?hard=1`,
        'DELETE'
      );
      toast.success(t('deleted'));
      reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : tc('loadError');
      // Produto com venda não pode sair. Explicar a saída — arquivar
      // — evita que o operador fique tentando o botão errado.
      toast.error(msg, { duration: 7000 });
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <PageHeader
        title={t('title')}
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('newProduct')}
          </Button>
        }
      />

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

        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
          {(
            [
              ['true', t('active')],
              ['false', t('inactive')],
              ['all', t('statusAll')],
            ] as [StatusFilter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setStatusFilter(key);
                setPage(1);
              }}
              aria-pressed={statusFilter === key}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                statusFilter === key
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
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Package className="h-6 w-6" />}
          title={search.trim() ? t('noResults') : t('emptyTitle')}
          description={search.trim() ? undefined : t('emptyBody')}
          action={
            search.trim() ? undefined : (
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t('newProduct')}
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
                    {t('name')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-left font-medium sm:table-cell">
                    {t('category')}
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    {t('unitCost')}
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    {t('unitPrice')}
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    {t('margin')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">
                    {t('stock')}
                  </th>
                  <th className="w-20 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((product) => {
                  const profit =
                    product.unit_price_cents - product.unit_cost_cents;
                  const bp = marginBp(profit, product.unit_price_cents);
                  return (
                    <tr
                      key={product.id}
                      className="border-b border-border/60 last:border-0 hover:bg-muted/40"
                    >
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2">
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-foreground">
                              {product.name}
                            </span>
                            {product.sku ? (
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {product.sku}
                              </span>
                            ) : null}
                          </span>
                          {!product.is_active ? (
                            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {t('inactive')}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="hidden px-3 py-2.5 text-muted-foreground sm:table-cell">
                        {product.category ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {formatCents(product.unit_cost_cents)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
                        {formatCents(product.unit_price_cents)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span
                          className={cn(
                            'tabular-nums',
                            product.unit_price_cents === 0
                              ? 'text-muted-foreground'
                              : bp < 0
                                ? 'text-red-700 dark:text-red-400'
                                : bp < 1500
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : 'text-foreground'
                          )}
                        >
                          {product.unit_price_cents === 0
                            ? '—'
                            : formatBp(bp)}
                        </span>
                      </td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground md:table-cell">
                        {product.stock_quantity ?? '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setEditing(product)}
                            aria-label={tc('edit')}
                            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {product.is_active ? (
                            <button
                              type="button"
                              onClick={() => archive(product)}
                              aria-label={tc('archive')}
                              title={t('archiveHint')}
                              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              <Archive className="h-3.5 w-3.5" />
                            </button>
                          ) : null}

                          {/* Excluir só aparece para master (§9): o
                              vendedor arquiva, o dono apaga. */}
                          {podeExcluir ? (
                            <button
                              type="button"
                              onClick={() => remove(product)}
                              aria-label={tc('delete')}
                              title={t('deleteHint')}
                              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-red-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pages > 1 ? (
            <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              <span>{tc('pageOf', { page, pages })}</span>
              <span className="flex gap-1.5">
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
            </div>
          ) : null}
        </div>
      )}

      {editing ? (
        <ProductForm
          product={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function ProductForm({
  product,
  onClose,
  onSaved,
}: {
  product: ProductRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Products');
  const tc = useTranslations('Commerce');

  const [name, setName] = useState(product?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [costCents, setCostCents] = useState(product?.unit_cost_cents ?? 0);
  const [priceCents, setPriceCents] = useState(product?.unit_price_cents ?? 0);
  const [stock, setStock] = useState(
    product?.stock_quantity === null || product?.stock_quantity === undefined
      ? ''
      : String(product.stock_quantity)
  );
  const [isActive, setIsActive] = useState(product?.is_active ?? true);
  const [saving, setSaving] = useState(false);

  const bp = marginBp(priceCents - costCents, priceCents);

  async function submit() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        sku: sku.trim() || null,
        category: category.trim() || null,
        description: description.trim() || null,
        unit_cost_cents: costCents,
        unit_price_cents: priceCents,
        // Empty string means "stop tracking", which is a different
        // fact from "zero in stock" — the schema keeps them distinct.
        stock_quantity: stock.trim() === '' ? null : Number(stock),
        is_active: isActive,
      };

      if (product) {
        await commerceMutate(
          `/api/commerce/products/${product.id}`,
          'PATCH',
          payload
        );
        toast.success(t('updated'));
      } else {
        await commerceMutate('/api/commerce/products', 'POST', payload);
        toast.success(t('created'));
      }
      onSaved();
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
      <aside
        role="dialog"
        aria-modal="true"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card"
      >
        <header className="flex h-14 shrink-0 items-center border-b border-border px-4">
          <h2 className="text-sm font-semibold text-foreground">
            {product ? t('editProduct') : t('newProduct')}
          </h2>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div>
            <Label htmlFor="p-name" className="text-xs text-muted-foreground">
              {t('name')}
            </Label>
            <Input
              id="p-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 h-9"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="p-sku" className="text-xs text-muted-foreground">
                {t('sku')}
              </Label>
              <Input
                id="p-sku"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
            <div>
              <Label htmlFor="p-cat" className="text-xs text-muted-foreground">
                {t('category')}
              </Label>
              <Input
                id="p-cat"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="p-cost" className="text-xs text-muted-foreground">
                {t('unitCost')}
              </Label>
              <MoneyInput
                id="p-cost"
                valueCents={costCents}
                onChange={setCostCents}
                className="mt-1 h-9"
              />
            </div>
            <div>
              <Label
                htmlFor="p-price"
                className="text-xs text-muted-foreground"
              >
                {t('unitPrice')}
              </Label>
              <MoneyInput
                id="p-price"
                valueCents={priceCents}
                onChange={setPriceCents}
                className="mt-1 h-9"
              />
            </div>
          </div>

          <div className="rounded-lg border border-border px-3 py-2">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">
                {t('margin')}
              </span>
              <span
                className={cn(
                  'text-sm font-semibold tabular-nums',
                  priceCents === 0
                    ? 'text-muted-foreground'
                    : bp < 0
                      ? 'text-red-700 dark:text-red-400'
                      : 'text-foreground'
                )}
              >
                {priceCents === 0
                  ? '—'
                  : `${formatCents(priceCents - costCents)} · ${formatBp(bp)}`}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t('priceHint')}
            </p>
          </div>

          <div>
            <Label htmlFor="p-stock" className="text-xs text-muted-foreground">
              {t('stock')}
            </Label>
            <Input
              id="p-stock"
              type="number"
              min={0}
              value={stock}
              placeholder={t('stockUntracked')}
              onChange={(e) => setStock(e.target.value)}
              className="mt-1 h-9 tabular-nums"
            />
          </div>

          <div>
            <Label htmlFor="p-desc" className="text-xs text-muted-foreground">
              {t('description')}
            </Label>
            <Textarea
              id="p-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 resize-none text-sm"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-[var(--primary)]"
            />
            {t('active')}
          </label>
        </div>

        <footer className="flex shrink-0 gap-2 border-t border-border px-4 py-3">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={onClose}
            disabled={saving}
          >
            {tc('cancel')}
          </Button>
          <Button
            className="flex-1"
            onClick={submit}
            disabled={saving || !name.trim()}
          >
            {saving ? tc('saving') : tc('save')}
          </Button>
        </footer>
      </aside>
    </>
  );
}
