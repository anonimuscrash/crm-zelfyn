'use client';

// ============================================================
// Operating expenses (§17, §18).
//
// The banner at the top is load-bearing, not decoration: the single
// most damaging mistake an operator can make on this screen is
// logging a per-order cost (a product's cost, one shipment's
// freight, a gateway fee) here. That would double-count it — once
// inside the order's direct costs and again as overhead — and quietly
// understate profit for the period.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Info, Plus, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { commerceMutate, periodQuery, useCommerceFetch } from '@/hooks/use-commerce';
import {
  EmptyState,
  ErrorState,
  formatDateBR,
  MoneyInput,
  PageHeader,
  PeriodFilter,
  Skeleton,
} from '@/components/commerce/primitives';
import { formatCents } from '@/lib/commerce/money';
import { toISODateLocal, type PeriodSelection } from '@/lib/commerce/periods';
import type {
  ExpenseCategoryRow,
  ExpenseRow,
  Paginated,
} from '@/lib/commerce/types';

export default function ExpensesPage() {
  const t = useTranslations('Expenses');
  const tc = useTranslations('Commerce');

  const [period, setPeriod] = useState<PeriodSelection>({
    preset: 'thisMonth',
  });
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams(periodQuery(period));
    params.set('page', String(page));
    params.set('pageSize', '25');
    return params.toString();
  }, [period, page]);

  const { data, error, loading, reload } = useCommerceFetch<
    Paginated<ExpenseRow>
  >(`/api/commerce/expenses?${query}`);

  const { data: catData } = useCommerceFetch<{
    categories: ExpenseCategoryRow[];
  }>('/api/commerce/expense-categories');

  const rows = data?.rows ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const periodTotal = rows.reduce((sum, r) => sum + r.amount_cents, 0);

  async function remove(expense: ExpenseRow) {
    try {
      await commerceMutate(`/api/commerce/expenses/${expense.id}`, 'DELETE');
      toast.success(t('deleted'));
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tc('loadError'));
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px]">
      <PageHeader
        title={t('title')}
        actions={
          <Button size="sm" onClick={() => setFormOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('newExpense')}
          </Button>
        }
      />

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('scopeNote')}
        </p>
      </div>

      <PeriodFilter value={period} onChange={setPeriod} className="mb-4" />

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
          icon={<Wallet className="h-6 w-6" />}
          title={t('emptyTitle')}
          description={t('emptyBody')}
          action={
            <Button size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('newExpense')}
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t('description')}
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    {t('category')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-left font-medium sm:table-cell">
                    {t('supplier')}
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    {t('amount')}
                  </th>
                  <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">
                    {t('date')}
                  </th>
                  <th className="w-12 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((expense) => (
                  <tr
                    key={expense.id}
                    className="border-b border-border/60 last:border-0 hover:bg-muted/40"
                  >
                    <td className="px-4 py-2.5">
                      <span className="block truncate text-foreground">
                        {expense.description}
                      </span>
                      {expense.is_recurring ? (
                        <span className="text-[11px] text-muted-foreground">
                          {t('recurring')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {expense.category_name_snapshot ?? '—'}
                    </td>
                    <td className="hidden px-3 py-2.5 text-muted-foreground sm:table-cell">
                      {expense.supplier ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-foreground">
                      {formatCents(expense.amount_cents)}
                    </td>
                    <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                      {formatDateBR(expense.incurred_on)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => remove(expense)}
                        aria-label={tc('remove')}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td
                    colSpan={3}
                    className="px-4 py-2.5 text-xs font-medium text-muted-foreground"
                  >
                    {tc('total')}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-foreground">
                    {formatCents(periodTotal)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
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

      {formOpen ? (
        <ExpenseForm
          categories={catData?.categories ?? []}
          onClose={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function ExpenseForm({
  categories,
  onClose,
  onSaved,
}: {
  categories: ExpenseCategoryRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Expenses');
  const tc = useTranslations('Commerce');

  const [description, setDescription] = useState('');
  const [amountCents, setAmountCents] = useState(0);
  const [categoryId, setCategoryId] = useState('');
  const [incurredOn, setIncurredOn] = useState(toISODateLocal(new Date()));
  const [supplier, setSupplier] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [notes, setNotes] = useState('');
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrence, setRecurrence] = useState<'monthly' | 'weekly' | 'yearly'>(
    'monthly'
  );
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!description.trim() || amountCents <= 0) return;
    setSaving(true);
    try {
      await commerceMutate('/api/commerce/expenses', 'POST', {
        description: description.trim(),
        amount_cents: amountCents,
        category_id: categoryId || null,
        incurred_on: incurredOn,
        supplier: supplier.trim() || null,
        payment_method: paymentMethod.trim() || null,
        notes: notes.trim() || null,
        is_recurring: isRecurring,
        recurrence: isRecurring ? recurrence : null,
      });
      toast.success(t('created'));
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
            {t('newExpense')}
          </h2>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div>
            <Label htmlFor="e-desc" className="text-xs text-muted-foreground">
              {t('description')}
            </Label>
            <Input
              id="e-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 h-9"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="e-amt" className="text-xs text-muted-foreground">
                {t('amount')}
              </Label>
              <MoneyInput
                id="e-amt"
                valueCents={amountCents}
                onChange={setAmountCents}
                className="mt-1 h-9"
              />
            </div>
            <div>
              <Label htmlFor="e-date" className="text-xs text-muted-foreground">
                {t('date')}
              </Label>
              <Input
                id="e-date"
                type="date"
                value={incurredOn}
                onChange={(e) => setIncurredOn(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="e-cat" className="text-xs text-muted-foreground">
              {t('category')}
            </Label>
            <select
              id="e-cat"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground"
            >
              <option value="">{tc('none')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="e-sup" className="text-xs text-muted-foreground">
                {t('supplier')}
              </Label>
              <Input
                id="e-sup"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
            <div>
              <Label htmlFor="e-pay" className="text-xs text-muted-foreground">
                {t('paymentMethod')}
              </Label>
              <Input
                id="e-pay"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
          </div>

          <div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={isRecurring}
                onChange={(e) => setIsRecurring(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-[var(--primary)]"
              />
              {t('recurring')}
            </label>
            {isRecurring ? (
              <select
                value={recurrence}
                onChange={(e) =>
                  setRecurrence(e.target.value as typeof recurrence)
                }
                className="mt-2 h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground"
              >
                <option value="monthly">{t('recurrenceMonthly')}</option>
                <option value="weekly">{t('recurrenceWeekly')}</option>
                <option value="yearly">{t('recurrenceYearly')}</option>
              </select>
            ) : null}
          </div>

          <div>
            <Label htmlFor="e-notes" className="text-xs text-muted-foreground">
              {t('notes')}
            </Label>
            <Textarea
              id="e-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1 resize-none text-sm"
            />
          </div>
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
            disabled={saving || !description.trim() || amountCents <= 0}
          >
            {saving ? tc('saving') : tc('save')}
          </Button>
        </footer>
      </aside>
    </>
  );
}
