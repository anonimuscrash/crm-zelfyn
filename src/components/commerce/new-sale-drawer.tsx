'use client';

// ============================================================
// Quick sale entry (§10, §22, §39).
//
// The design constraint: an operator is mid-conversation on WhatsApp
// and needs the sale booked in seconds. So — no wizard, no required
// fields beyond one product, defaults pulled automatically, and the
// profit visible before saving.
//
// LIVE MATHS vs. STORED TRUTH
// ---------------------------
// The summary panel runs `calculateOrder`, the same pure function
// covered by calculations.test.ts. It exists for feedback while
// typing. What gets SAVED is recomputed by the database trigger from
// the submitted lines — the client never posts a total. If the two
// ever disagreed, the database wins and the tests that pin them
// together would already be red.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, Plus, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { commerceMutate } from '@/hooks/use-commerce';
import { MoneyInput } from '@/components/commerce/primitives';
import { calculateOrder, type DiscountKind } from '@/lib/commerce/calculations';
import { formatBp, formatCents, parsePercentToBp } from '@/lib/commerce/money';
import { ORDER_STATUS_META } from '@/lib/commerce/order-status';
import type { OrderStatus } from '@/lib/commerce/types';

interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
  unit_price_cents: number;
  unit_cost_cents: number;
  stock_quantity: number | null;
}

interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

interface LineState {
  key: string;
  productId: string | null;
  productName: string;
  unitPriceCents: number;
  unitCostCents: number;
  quantity: number;
  discountKind: DiscountKind;
  discountRaw: string;
}

let lineSeq = 0;
const newKey = () => `line-${++lineSeq}`;

const QUICK_STATUSES: OrderStatus[] = [
  'new',
  'paid',
  'awaiting_shipment',
  'shipped',
];

export function NewSaleDrawer({
  open,
  onClose,
  onCreated,
  presetContactId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  presetContactId?: string;
}) {
  const t = useTranslations('NewSale');
  const tc = useTranslations('Commerce');
  const to = useTranslations('Orders');

  const [lines, setLines] = useState<LineState[]>([]);
  const [contact, setContact] = useState<ContactOption | null>(null);
  const [status, setStatus] = useState<OrderStatus>('new');
  const [orderDiscountKind, setOrderDiscountKind] =
    useState<DiscountKind>('fixed');
  const [orderDiscountRaw, setOrderDiscountRaw] = useState('');
  const [shippingCents, setShippingCents] = useState(0);
  const [feeCents, setFeeCents] = useState(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = useCallback(() => {
    setLines([]);
    setContact(null);
    setStatus('new');
    setOrderDiscountKind('fixed');
    setOrderDiscountRaw('');
    setShippingCents(0);
    setFeeCents(0);
    setNotes('');
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // ---- live totals ----
  const totals = useMemo(() => {
    const parseDiscount = (kind: DiscountKind, raw: string) => {
      if (!raw.trim()) return 0;
      const parsed = parsePercentToBp(raw);
      if (parsed === null) return 0;
      // Both branches parse to hundredths: for 'fixed' that's cents,
      // for 'percent' that's basis points. Same number, two units —
      // which is exactly why the SQL stores discount_value raw and
      // records the kind alongside it.
      return kind === 'percent' ? Math.min(parsed, 10_000) : parsed;
    };

    return calculateOrder({
      lines: lines.map((l) => ({
        productName: l.productName,
        unitPriceCents: l.unitPriceCents,
        unitCostCents: l.unitCostCents,
        quantity: l.quantity,
        discount: {
          kind: l.discountKind,
          value: parseDiscount(l.discountKind, l.discountRaw),
        },
      })),
      discount: {
        kind: orderDiscountKind,
        value: parseDiscount(orderDiscountKind, orderDiscountRaw),
      },
      shippingCostCents: shippingCents,
      paymentFeeCents: feeCents,
    });
  }, [lines, orderDiscountKind, orderDiscountRaw, shippingCents, feeCents]);

  const addProduct = useCallback((product: ProductOption) => {
    setLines((current) => {
      // Same product twice = bump the quantity. Two identical lines
      // would be a data-entry artefact, not a business fact.
      const existing = current.find((l) => l.productId === product.id);
      if (existing) {
        return current.map((l) =>
          l.key === existing.key ? { ...l, quantity: l.quantity + 1 } : l
        );
      }
      return [
        ...current,
        {
          key: newKey(),
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.unit_price_cents,
          unitCostCents: product.unit_cost_cents,
          quantity: 1,
          discountKind: 'fixed',
          discountRaw: '',
        },
      ];
    });
  }, []);

  const patchLine = (key: string, patch: Partial<LineState>) =>
    setLines((current) =>
      current.map((l) => (l.key === key ? { ...l, ...patch } : l))
    );

  const removeLine = (key: string) =>
    setLines((current) => current.filter((l) => l.key !== key));

  async function submit() {
    if (lines.length === 0) {
      toast.error(t('needsItem'));
      return;
    }

    setSaving(true);
    try {
      const parseDiscount = (kind: DiscountKind, raw: string) => {
        if (!raw.trim()) return 0;
        const parsed = parsePercentToBp(raw);
        if (parsed === null) return 0;
        return kind === 'percent' ? Math.min(parsed, 10_000) : parsed;
      };

      await commerceMutate('/api/commerce/orders', 'POST', {
        contact_id: contact?.id ?? presetContactId ?? null,
        status,
        discount_kind: orderDiscountKind,
        discount_value: parseDiscount(orderDiscountKind, orderDiscountRaw),
        shipping_cost_cents: shippingCents,
        payment_fee_cents: feeCents,
        notes: notes.trim() || null,
        // No totals in this payload by design — the server derives
        // every one of them.
        items: lines.map((l) => ({
          product_id: l.productId,
          product_name: l.productName,
          unit_price_cents: l.unitPriceCents,
          unit_cost_cents: l.unitCostCents,
          quantity: l.quantity,
          discount_kind: l.discountKind,
          discount_value: parseDiscount(l.discountKind, l.discountRaw),
        })),
      });

      toast.success(to('created'));
      reset();
      onCreated?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tc('loadError'));
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

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
        aria-label={t('title')}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card"
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="text-sm font-semibold text-foreground">
            {t('title')}
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

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {/* ---- Customer ---- */}
          <section>
            <Label className="text-xs text-muted-foreground">
              {t('customer')}
            </Label>
            <ContactPicker
              value={contact}
              onChange={setContact}
              placeholder={t('searchCustomer')}
              emptyLabel={t('noCustomer')}
            />
          </section>

          {/* ---- Products ---- */}
          <section>
            <Label className="text-xs text-muted-foreground">
              {t('products')}
            </Label>
            <ProductPicker onPick={addProduct} placeholder={t('searchProduct')} />

            {lines.length === 0 ? (
              <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                {t('needsItem')}
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {lines.map((line, i) => {
                  const lineTotals = totals.lines[i];
                  return (
                    <li
                      key={line.key}
                      className="rounded-lg border border-border p-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {line.productName}
                        </p>
                        <button
                          type="button"
                          onClick={() => removeLine(line.key)}
                          aria-label={tc('remove')}
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <div className="mt-2 grid grid-cols-3 gap-2">
                        <div>
                          <Label className="text-[10px] text-muted-foreground">
                            {t('quantity')}
                          </Label>
                          <Input
                            type="number"
                            min={1}
                            value={line.quantity}
                            onChange={(e) =>
                              patchLine(line.key, {
                                quantity: Math.max(
                                  1,
                                  Math.trunc(Number(e.target.value) || 1)
                                ),
                              })
                            }
                            className="h-8 tabular-nums"
                          />
                        </div>
                        <div>
                          <Label className="text-[10px] text-muted-foreground">
                            {t('unitPrice')}
                          </Label>
                          <MoneyInput
                            valueCents={line.unitPriceCents}
                            onChange={(cents) =>
                              patchLine(line.key, { unitPriceCents: cents })
                            }
                            className="h-8"
                          />
                        </div>
                        <div>
                          <Label className="text-[10px] text-muted-foreground">
                            {t('lineDiscount')}
                          </Label>
                          <DiscountField
                            kind={line.discountKind}
                            raw={line.discountRaw}
                            onKind={(kind) =>
                              patchLine(line.key, { discountKind: kind })
                            }
                            onRaw={(raw) =>
                              patchLine(line.key, { discountRaw: raw })
                            }
                          />
                        </div>
                      </div>

                      {lineTotals ? (
                        <p className="mt-1.5 text-[11px] tabular-nums text-muted-foreground">
                          {formatCents(lineTotals.netCents)}
                          {lineTotals.discountCents > 0 ? (
                            <span className="ml-1.5 line-through opacity-60">
                              {formatCents(lineTotals.grossCents)}
                            </span>
                          ) : null}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ---- Order-level money ---- */}
          <section className="grid grid-cols-3 gap-2">
            <div>
              <Label className="text-xs text-muted-foreground">
                {t('orderDiscount')}
              </Label>
              <DiscountField
                kind={orderDiscountKind}
                raw={orderDiscountRaw}
                onKind={setOrderDiscountKind}
                onRaw={setOrderDiscountRaw}
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                {t('shippingCost')}
              </Label>
              <MoneyInput
                valueCents={shippingCents}
                onChange={setShippingCents}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                {t('paymentFee')}
              </Label>
              <MoneyInput
                valueCents={feeCents}
                onChange={setFeeCents}
                className="h-9"
              />
            </div>
          </section>

          {/* ---- Status ---- */}
          <section>
            <Label className="text-xs text-muted-foreground">
              {t('status')}
            </Label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {QUICK_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  aria-pressed={status === s}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                    status === s
                      ? ORDER_STATUS_META[s].chipClass
                      : 'border-border text-muted-foreground hover:bg-muted'
                  )}
                >
                  {to(`status${s.replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())}`)}
                </button>
              ))}
            </div>
          </section>

          <section>
            <Label className="text-xs text-muted-foreground">
              {t('notes')}
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1 resize-none text-sm"
            />
          </section>
        </div>

        {/* ---- Summary + save ---- */}
        <footer className="shrink-0 border-t border-border bg-card px-4 py-3">
          <div className="mb-3 space-y-1 text-[13px]">
            <Row label={t('subtotal')} value={formatCents(totals.grossCents)} />
            {totals.discountTotalCents > 0 ? (
              <Row
                label={t('lineDiscount')}
                value={`− ${formatCents(totals.discountTotalCents)}`}
                muted
              />
            ) : null}
            {totals.directCostsCents > 0 ? (
              <Row
                label={tc('total')}
                value={`− ${formatCents(totals.directCostsCents)}`}
                muted
              />
            ) : null}
            <div className="flex items-baseline justify-between border-t border-border pt-2">
              <span className="text-xs text-muted-foreground">
                {t('profitPreview')}
              </span>
              <span className="flex items-baseline gap-2">
                <span
                  className={cn(
                    'text-base font-semibold tabular-nums',
                    totals.grossProfitCents < 0
                      ? 'text-red-700 dark:text-red-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  )}
                >
                  {formatCents(totals.grossProfitCents)}
                </span>
                {totals.netRevenueCents > 0 ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatBp(totals.marginBp)}
                  </span>
                ) : null}
              </span>
            </div>
          </div>

          <div className="flex gap-2">
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
              disabled={saving || lines.length === 0}
            >
              {saving ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1.5 h-4 w-4" />
              )}
              {saving ? tc('saving') : t('saveSale')}
            </Button>
          </div>
        </footer>
      </aside>
    </>
  );
}

function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          'tabular-nums',
          muted ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Amount field with a fixed/percent toggle welded to its right edge. */
function DiscountField({
  kind,
  raw,
  onKind,
  onRaw,
}: {
  kind: DiscountKind;
  raw: string;
  onKind: (kind: DiscountKind) => void;
  onRaw: (raw: string) => void;
}) {
  return (
    <div className="flex">
      <Input
        inputMode="decimal"
        value={raw}
        placeholder="0"
        onChange={(e) => onRaw(e.target.value)}
        className="h-8 rounded-r-none tabular-nums"
      />
      <button
        type="button"
        onClick={() => onKind(kind === 'fixed' ? 'percent' : 'fixed')}
        aria-label={kind === 'fixed' ? 'R$' : '%'}
        className="h-8 w-9 shrink-0 rounded-r-md border border-l-0 border-input bg-muted text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {kind === 'fixed' ? 'R$' : '%'}
      </button>
    </div>
  );
}

// ------------------------------------------------------------
// Pickers
// ------------------------------------------------------------

function useDebounced(value: string, delay = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

function ProductPicker({
  onPick,
  placeholder,
}: {
  onPick: (product: ProductOption) => void;
  placeholder: string;
}) {
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<ProductOption[]>([]);
  const [openList, setOpenList] = useState(false);
  const debounced = useDebounced(term);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openList) return;
    const params = new URLSearchParams({ pageSize: '8', active: 'true' });
    if (debounced.trim()) params.set('search', debounced.trim());

    let cancelled = false;
    fetch(`/api/commerce/products?${params}`)
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((json: { rows: ProductOption[] }) => {
        if (!cancelled) setOptions(json.rows ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debounced, openList]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpenList(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  return (
    <div ref={boxRef} className="relative mt-1">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={term}
          placeholder={placeholder}
          onFocus={() => setOpenList(true)}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpenList(true);
          }}
          className="h-9 pl-8 text-sm"
        />
      </div>

      {openList && options.length > 0 ? (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-card py-1">
          {options.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(product);
                  setTerm('');
                }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">
                    {product.name}
                  </span>
                  {product.sku ? (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {product.sku}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                  {formatCents(product.unit_price_cents)}
                </span>
                <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ContactPicker({
  value,
  onChange,
  placeholder,
  emptyLabel,
}: {
  value: ContactOption | null;
  onChange: (contact: ContactOption | null) => void;
  placeholder: string;
  emptyLabel: string;
}) {
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<ContactOption[]>([]);
  const [openList, setOpenList] = useState(false);
  const debounced = useDebounced(term);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // No `setOptions([])` on the early return: clearing state
    // synchronously inside an effect cascades a render. Stale results
    // are filtered at render time instead (see `visible` below).
    if (!openList || !debounced.trim()) return;
    let cancelled = false;
    fetch(
      `/api/v1/contacts?search=${encodeURIComponent(debounced.trim())}&limit=8`
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: ContactOption[] } | null) => {
        if (!cancelled) setOptions(json?.data ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debounced, openList]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpenList(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Results belong to whatever the operator last searched; if the box
  // is empty they are stale by definition.
  const visible = term.trim() ? options : [];

  if (value) {
    return (
      <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
        <span className="min-w-0">
          <span className="block truncate text-sm text-foreground">
            {value.name ?? value.phone}
          </span>
          {value.name ? (
            <span className="block truncate text-[11px] text-muted-foreground">
              {value.phone}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative mt-1">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={term}
          placeholder={placeholder}
          onFocus={() => setOpenList(true)}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpenList(true);
          }}
          className="h-9 pl-8 text-sm"
        />
      </div>

      {openList && term.trim() ? (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-card py-1">
          {visible.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(c);
                  setOpenList(false);
                }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <span className="block truncate text-foreground">
                  {c.name ?? c.phone}
                </span>
                {c.name ? (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {c.phone}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
          {visible.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {emptyLabel}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
