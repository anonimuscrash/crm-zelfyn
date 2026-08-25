'use client';

// ============================================================
// Shared commerce UI primitives.
//
// Visual brief (§6, §24): this should read as consolidated business
// software, not a template. Concretely, the rules applied here and
// across every commerce screen:
//
//   * Surfaces are flat. `border` + `bg-card`, no drop shadows, no
//     glass, no gradient fills. Depth comes from the border and from
//     spacing, which is what Stripe/Linear/Shopify Admin actually do.
//   * One accent colour, used sparingly — for the active state and
//     the primary action. Financial sign is carried by emerald/red
//     text, never by a filled card.
//   * Numbers are tabular-nums and right-aligned in tables so digits
//     line up column-wise and the eye can scan magnitudes.
//   * Density over drama: compact rows, small labels, generous
//     whitespace between GROUPS rather than inside them.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  deltaBp,
  formatBp,
  formatCents,
  formatDeltaBp,
  parseAmountToCents,
} from '@/lib/commerce/money';
import {
  PERIOD_PRESETS,
  toISODateLocal,
  type PeriodPreset,
  type PeriodSelection,
} from '@/lib/commerce/periods';

// ------------------------------------------------------------
// Page header
// ------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------
// Period filter
// ------------------------------------------------------------

const PRESET_KEY: Record<PeriodPreset, string> = {
  today: 'periodToday',
  last7: 'periodLast7',
  last15: 'periodLast15',
  last30: 'periodLast30',
  thisMonth: 'periodThisMonth',
  lastMonth: 'periodLastMonth',
  custom: 'periodCustom',
};

export function PeriodFilter({
  value,
  onChange,
  className,
}: {
  value: PeriodSelection;
  onChange: (next: PeriodSelection) => void;
  className?: string;
}) {
  const t = useTranslations('Commerce');
  const today = toISODateLocal(new Date());

  const [draftFrom, setDraftFrom] = useState(value.fromDate ?? '');
  const [draftTo, setDraftTo] = useState(value.toDate ?? today);

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {/* Segmented control. A row of pills rather than a <select>:
          the operator switches window constantly, and a dropdown
          costs two clicks every time. */}
      <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
        {PERIOD_PRESETS.map((preset) => {
          const active = value.preset === preset;
          return (
            <button
              key={preset}
              type="button"
              onClick={() =>
                onChange(
                  preset === 'custom'
                    ? { preset, fromDate: draftFrom, toDate: draftTo }
                    : { preset }
                )
              }
              aria-pressed={active}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {t(PRESET_KEY[preset])}
            </button>
          );
        })}
      </div>

      {value.preset === 'custom' ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5">
          <label className="text-xs text-muted-foreground">
            {t('periodFrom')}
          </label>
          <Input
            type="date"
            value={draftFrom}
            max={draftTo || today}
            onChange={(e) => setDraftFrom(e.target.value)}
            className="h-7 w-[8.5rem] px-2 text-xs"
          />
          <label className="text-xs text-muted-foreground">
            {t('periodTo')}
          </label>
          <Input
            type="date"
            value={draftTo}
            min={draftFrom || undefined}
            max={today}
            onChange={(e) => setDraftTo(e.target.value)}
            className="h-7 w-[8.5rem] px-2 text-xs"
          />
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2.5 text-xs"
            disabled={!draftFrom || !draftTo}
            onClick={() =>
              onChange({
                preset: 'custom',
                fromDate: draftFrom,
                toDate: draftTo,
              })
            }
          >
            {t('periodApply')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------
// Metric tile
// ------------------------------------------------------------

export type MetricTone = 'neutral' | 'positive' | 'negative' | 'cost';

/**
 * One KPI. `previous` is optional — when absent, no delta chip is
 * rendered at all rather than a "0%" that implies a flat comparison
 * we never measured.
 */
export function MetricTile({
  label,
  valueCents,
  rawValue,
  previous,
  tone = 'neutral',
  hint,
  compact = false,
}: {
  label: string;
  /** Money value. Mutually exclusive with `rawValue`. */
  valueCents?: number;
  /** Pre-formatted non-money value (counts, percentages). */
  rawValue?: string;
  previous?: number;
  tone?: MetricTone;
  hint?: string;
  compact?: boolean;
}) {
  const t = useTranslations('Commerce');

  const current = valueCents ?? 0;
  const delta =
    previous === undefined || valueCents === undefined
      ? null
      : deltaBp(current, previous);

  const valueClass =
    tone === 'positive' && current > 0
      ? 'text-emerald-700 dark:text-emerald-400'
      : tone === 'negative' || (tone === 'positive' && current < 0)
        ? 'text-red-700 dark:text-red-400'
        : 'text-foreground';

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card',
        compact ? 'p-3' : 'p-4'
      )}
    >
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1.5 font-semibold tabular-nums tracking-tight',
          compact ? 'text-lg' : 'text-2xl',
          valueClass
        )}
      >
        {rawValue ?? formatCents(current)}
      </p>

      {delta !== null ? (
        <p className="mt-1.5 flex items-center gap-1 text-xs">
          <span
            className={cn(
              'font-medium tabular-nums',
              delta > 0
                ? 'text-emerald-700 dark:text-emerald-400'
                : delta < 0
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-muted-foreground'
            )}
          >
            {formatDeltaBp(delta)}
          </span>
          <span className="text-muted-foreground">{t('vsPrevious')}</span>
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Dense label/value row for the P&L statement block. */
export function StatementRow({
  label,
  valueCents,
  emphasis = false,
  negative = false,
  indent = false,
}: {
  label: string;
  valueCents: number;
  emphasis?: boolean;
  /** Render as a subtraction: prefixed minus, muted. */
  negative?: boolean;
  indent?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4 py-1.5',
        emphasis && 'border-t border-border pt-2.5 mt-1',
        indent && 'pl-3'
      )}
    >
      <span
        className={cn(
          'text-[13px]',
          emphasis
            ? 'font-medium text-foreground'
            : 'text-muted-foreground'
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          'shrink-0 tabular-nums',
          emphasis ? 'text-[15px] font-semibold' : 'text-[13px]',
          negative
            ? 'text-muted-foreground'
            : emphasis && valueCents < 0
              ? 'text-red-700 dark:text-red-400'
              : 'text-foreground'
        )}
      >
        {negative ? '− ' : ''}
        {formatCents(Math.abs(valueCents))}
      </span>
    </div>
  );
}

// ------------------------------------------------------------
// States
// ------------------------------------------------------------

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/40 px-6 py-14 text-center">
      {icon ? <div className="mb-3 text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Neutral skeleton. Deliberately dull — a pulsing shimmer on a
 *  financial screen reads as movement in the data. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded bg-muted', className)} />
  );
}

export function MetricSkeletonGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-3 h-7 w-28" />
          <Skeleton className="mt-3 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  const t = useTranslations('Commerce');
  return (
    <div className="rounded-lg border border-red-600/25 bg-red-600/5 px-4 py-3">
      <p className="text-sm text-red-700 dark:text-red-400">{message}</p>
      {onRetry ? (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2.5 h-7 text-xs"
          onClick={onRetry}
        >
          {t('retry')}
        </Button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------
// Money input
// ------------------------------------------------------------

/**
 * Currency field that keeps the operator's raw keystrokes in local
 * state and only emits parsed cents upward.
 *
 * Formatting on every keystroke is the usual approach and it fights
 * the user — a caret that jumps mid-typing because "1.2" became
 * "R$ 1,20". Here the text stays exactly as typed until blur, and
 * the parsed value flows out continuously so totals stay live.
 */
export function MoneyInput({
  valueCents,
  onChange,
  placeholder = '0,00',
  className,
  id,
  disabled,
}: {
  valueCents: number;
  onChange: (cents: number) => void;
  placeholder?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() =>
    valueCents ? centsToText(valueCents) : ''
  );
  const [focused, setFocused] = useState(false);

  // While unfocused, mirror external changes (e.g. a product picker
  // filling in the default price). While focused, never overwrite
  // what the operator is typing.
  const display = focused
    ? text
    : valueCents
      ? centsToText(valueCents)
      : '';

  return (
    <Input
      id={id}
      inputMode="decimal"
      disabled={disabled}
      value={display}
      placeholder={placeholder}
      onFocus={() => {
        setFocused(true);
        setText(valueCents ? centsToText(valueCents) : '');
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw.trim() === '') {
          onChange(0);
          return;
        }
        const parsed = parseAmountToCents(raw);
        if (parsed !== null) onChange(Math.max(parsed, 0));
      }}
      className={cn('tabular-nums', className)}
    />
  );
}

function centsToText(cents: number): string {
  return `${Math.floor(Math.abs(cents) / 100)},${String(
    Math.abs(cents) % 100
  ).padStart(2, '0')}`;
}

// ------------------------------------------------------------
// Small display helpers
// ------------------------------------------------------------

export function MarginBadge({
  profitCents,
  netCents,
}: {
  profitCents: number;
  netCents: number;
}) {
  const bp = useMemo(
    () => (netCents === 0 ? null : Math.round((profitCents / netCents) * 10_000)),
    [profitCents, netCents]
  );

  if (bp === null) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <span
      className={cn(
        'tabular-nums',
        bp < 0
          ? 'text-red-700 dark:text-red-400'
          : bp < 1500
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-foreground'
      )}
    >
      {formatBp(bp)}
    </span>
  );
}

export function Money({
  cents,
  className,
  signed = false,
}: {
  cents: number;
  className?: string;
  signed?: boolean;
}) {
  return (
    <span
      className={cn(
        'tabular-nums',
        signed && cents < 0 && 'text-red-700 dark:text-red-400',
        signed && cents > 0 && 'text-emerald-700 dark:text-emerald-400',
        className
      )}
    >
      {formatCents(cents)}
    </span>
  );
}

export function formatDateBR(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

export function formatDateTimeBR(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
