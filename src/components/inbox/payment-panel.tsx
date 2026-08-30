'use client';

// ============================================================
// Pagamento dentro da conversa.
//
// DUAS FORMAS, DUAS ABAS — porque são coisas diferentes
// -----------------------------------------------------
// A cobrança Dotfy tem valor, vencimento e confirma sozinha. A chave
// estática é um dado que o operador copia. Misturá-las na mesma
// interface levaria o vendedor a esperar confirmação de uma chave
// estática, que nunca vem.
//
// A aba de chave estática vem PRIMEIRO quando a Dotfy não está
// configurada: é a única que funciona nesse caso, e abrir numa aba
// vazia com "configure isto" é pior que abrir na que serve.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, KeyRound, Loader2, QrCode, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { commerceMutate } from '@/hooks/use-commerce';
import { MoneyInput, formatDateTimeBR } from '@/components/commerce/primitives';
import { formatCents } from '@/lib/commerce/money';
import { formatPixKey, type PixKeyType } from '@/services/payments/dotfy';

interface Status {
  dotfy_enabled: boolean;
  dotfy_configured: boolean;
  pix_key_count: number;
}

interface PixKey {
  id: string;
  label: string;
  key_type: PixKeyType;
  key_value: string;
  holder_name: string | null;
  is_default: boolean;
}

interface Charge {
  id: string;
  correlation_id: string;
  amount_cents: number;
  status: 'pending' | 'paid' | 'expired' | 'canceled' | 'failed';
  qr_code: string | null;
  qr_code_image: string | null;
  payment_link: string | null;
  expires_at: string | null;
  created_at: string;
}

const STATUS_CHIP: Record<Charge['status'], string> = {
  pending: 'border-amber-600/25 bg-amber-600/10 text-amber-700 dark:text-amber-400',
  paid: 'border-emerald-600/25 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  expired: 'border-border bg-muted text-muted-foreground',
  canceled: 'border-border bg-muted text-muted-foreground',
  failed: 'border-red-600/25 bg-red-600/8 text-red-700 dark:text-red-400',
};

export function PaymentPanel({
  contactId,
  conversationId,
}: {
  contactId: string;
  conversationId?: string | null;
}) {
  const t = useTranslations('Payments');
  const tc = useTranslations('Commerce');

  const [status, setStatus] = useState<Status | null>(null);
  const [aba, setAba] = useState<'dotfy' | 'pix'>('pix');
  const [chaves, setChaves] = useState<PixKey[]>([]);
  const [cobrancas, setCobrancas] = useState<Charge[]>([]);
  const [valorCents, setValorCents] = useState(0);
  const [descricao, setDescricao] = useState('');
  const [gerando, setGerando] = useState(false);
  const [copiado, setCopiado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    const [s, k, c] = await Promise.all([
      fetch('/api/payments/status').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/payments/pix-keys').then((r) => (r.ok ? r.json() : null)),
      fetch(
        `/api/payments/charges?contactId=${encodeURIComponent(contactId)}&limit=3`
      ).then((r) => (r.ok ? r.json() : null)),
    ]);

    setStatus(s);
    setChaves(k?.keys ?? []);
    setCobrancas(c?.charges ?? []);

    // Abre na aba que funciona. Cair numa aba de "configure isto"
    // quando a outra está pronta é fazer o operador clicar à toa.
    if (s?.dotfy_enabled && s?.dotfy_configured) setAba('dotfy');
  }, [contactId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function copiar(texto: string, id: string) {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(id);
      toast.success(t('copied'));
      setTimeout(() => setCopiado(null), 2000);
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  async function gerar() {
    if (valorCents <= 0) return;
    setGerando(true);
    try {
      const nova = await commerceMutate<Charge>(
        '/api/payments/charges',
        'POST',
        {
          amount_cents: valorCents,
          description: descricao.trim() || null,
          contact_id: contactId,
          conversation_id: conversationId ?? null,
        }
      );
      toast.success(t('chargeCreated'));
      setCobrancas([nova, ...cobrancas]);
      setValorCents(0);
      setDescricao('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setGerando(false);
    }
  }

  // Nada configurado: o painel não aparece. Espaço permanente na
  // sidebar dizendo "configure isto" é ruído para quem não usa.
  const temDotfy = Boolean(status?.dotfy_enabled && status?.dotfy_configured);
  const temChaves = chaves.length > 0;
  if (!status || (!temDotfy && !temChaves)) return null;

  return (
    <section className="border-t border-border px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <Zap className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('title')}
        </h3>
      </div>

      {temDotfy && temChaves ? (
        <div className="mb-3 inline-flex items-center gap-0.5 rounded-lg border border-border p-0.5">
          <button
            type="button"
            onClick={() => setAba('dotfy')}
            aria-pressed={aba === 'dotfy'}
            className={cn(
              'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              aba === 'dotfy'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted'
            )}
          >
            <QrCode className="h-3 w-3" />
            PIX
          </button>
          <button
            type="button"
            onClick={() => setAba('pix')}
            aria-pressed={aba === 'pix'}
            className={cn(
              'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              aba === 'pix'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted'
            )}
          >
            <KeyRound className="h-3 w-3" />
            {t('typeRandom')}
          </button>
        </div>
      ) : null}

      {/* ---- Cobrança automática ---- */}
      {aba === 'dotfy' && temDotfy ? (
        <>
          <div className="space-y-2">
            <div>
              <Label className="text-[10px] text-muted-foreground">
                {t('amount')}
              </Label>
              <MoneyInput
                valueCents={valorCents}
                onChange={setValorCents}
                className="mt-0.5 h-8"
              />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">
                {t('chargeDescription')}
              </Label>
              <Input
                value={descricao}
                onChange={(e) => setDescricao(e.target.value)}
                maxLength={255}
                className="mt-0.5 h-8 text-[13px]"
              />
            </div>
            <Button
              size="sm"
              className="w-full"
              onClick={gerar}
              disabled={gerando || valorCents <= 0}
            >
              {gerando ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <QrCode className="mr-1.5 h-3.5 w-3.5" />
              )}
              {gerando ? t('generating') : t('generateCharge')}
            </Button>
          </div>

          {cobrancas.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {cobrancas.map((c) => (
                <li
                  key={c.id}
                  className="rounded-lg border border-border px-2.5 py-2"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium tabular-nums text-foreground">
                      {formatCents(c.amount_cents)}
                    </span>
                    <span
                      className={cn(
                        'rounded border px-1.5 py-0.5 text-[10px] font-medium',
                        STATUS_CHIP[c.status]
                      )}
                    >
                      {t(
                        `status${c.status.charAt(0).toUpperCase()}${c.status.slice(1)}`
                      )}
                    </span>
                  </div>

                  {c.expires_at && c.status === 'pending' ? (
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {t('expiresAt')} {formatDateTimeBR(c.expires_at)}
                    </p>
                  ) : null}

                  {c.qr_code && c.status === 'pending' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-1.5 h-7 w-full text-[11px]"
                      onClick={() => copiar(c.qr_code as string, c.id)}
                    >
                      {copiado === c.id ? (
                        <Check className="mr-1 h-3 w-3" />
                      ) : (
                        <Copy className="mr-1 h-3 w-3" />
                      )}
                      {t('copyCode')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {/* ---- Chaves estáticas ---- */}
      {(aba === 'pix' || !temDotfy) && temChaves ? (
        <ul className="space-y-1.5">
          {chaves.map((k) => (
            <li
              key={k.id}
              className="rounded-lg border border-border px-2.5 py-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[12px] font-medium text-foreground">
                  {k.label}
                </span>
                {k.is_default ? (
                  <span className="shrink-0 rounded border border-border px-1 py-0.5 text-[9px] text-muted-foreground">
                    {t('isDefault')}
                  </span>
                ) : null}
              </div>

              <p className="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground">
                {formatPixKey(k.key_type, k.key_value)}
              </p>
              {k.holder_name ? (
                <p className="truncate text-[10px] text-muted-foreground">
                  {k.holder_name}
                </p>
              ) : null}

              <Button
                size="sm"
                variant="secondary"
                className="mt-1.5 h-7 w-full text-[11px]"
                onClick={() => copiar(k.key_value, k.id)}
              >
                {copiado === k.id ? (
                  <Check className="mr-1 h-3 w-3" />
                ) : (
                  <Copy className="mr-1 h-3 w-3" />
                )}
                {t('copyKey')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
