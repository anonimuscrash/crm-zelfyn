'use client';

// ============================================================
// Cotação de frete dentro da conversa.
//
// O LAYOUT SEGUE O APP DO SUPERFRETE de propósito: o operador já
// conhece aquela leitura — nome da transportadora, preço em verde,
// preço de tabela riscado ao lado, prazo embaixo, selo no mais
// barato. Reinventar a apresentação obrigaria a reaprender uma
// informação que ele lê dezenas de vezes por dia.
//
// O que NÃO copiei: o botão de emitir etiqueta. Emitir frete é
// operação com custo financeiro e não deve estar a um clique de
// distância no meio de um atendimento. Cotar informa; emitir
// compromete dinheiro.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Loader2, Truck } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { IntegrationLogo } from '@/components/brand/integration-logo';
import { formatCents } from '@/lib/commerce/money';
import type { ShippingOption } from '@/services/shipping/superfrete';

interface Status {
  provider: string;
  is_enabled: boolean;
  is_configured: boolean;
  has_origin: boolean;
}

export function ShippingQuotePanel({
  contactId,
  savedPostalCode,
}: {
  contactId: string;
  /** CEP já conhecido do contato, se houver. */
  savedPostalCode?: string | null;
}) {
  const t = useTranslations('Shipping');
  const tc = useTranslations('Commerce');

  const [status, setStatus] = useState<Status | null>(null);
  const [cep, setCep] = useState(savedPostalCode ?? '');
  const [opcoes, setOpcoes] = useState<ShippingOption[] | null>(null);
  const [mensagem, setMensagem] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    setCep(savedPostalCode ?? '');
    // Cotação de um contato não vale para outro.
    setOpcoes(null);
    setErro(null);
  }, [contactId, savedPostalCode]);

  useEffect(() => {
    let cancelado = false;
    fetch('/api/shipping/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: Status | null) => {
        if (!cancelado) setStatus(json);
      })
      .catch(() => undefined);
    return () => {
      cancelado = true;
    };
  }, []);

  const cotar = useCallback(async () => {
    const digitos = cep.replace(/\D/g, '');
    if (digitos.length !== 8) {
      setErro(t('invalidPostalCode'));
      return;
    }

    setCarregando(true);
    setErro(null);
    try {
      const res = await fetch('/api/shipping/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postal_code: digitos, contact_id: contactId }),
      });

      const json = (await res.json()) as {
        options?: ShippingOption[];
        message?: string;
        error?: string;
      };

      if (!res.ok) throw new Error(json.error ?? tc('loadError'));

      setOpcoes(json.options ?? []);
      setMensagem(json.message ?? '');
    } catch (e) {
      setErro(e instanceof Error ? e.message : tc('loadError'));
      setOpcoes(null);
    } finally {
      setCarregando(false);
    }
  }, [cep, contactId, t, tc]);

  async function copiar() {
    if (!mensagem) return;
    try {
      await navigator.clipboard.writeText(mensagem);
      setCopiado(true);
      toast.success(t('copied'));
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  // Integração desativada ou incompleta: nada é renderizado. Um
  // painel que só diz "configure isto" ocuparia espaço permanente na
  // sidebar de quem não usa frete.
  if (!status?.is_enabled || !status.is_configured) return null;

  const maisBarato = opcoes?.find((o) => !o.error && o.priceCents > 0);

  return (
    <section className="border-t border-border px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <IntegrationLogo
          name="superfrete"
          themed
          size={14}
          fallback={<Truck className="h-3.5 w-3.5 text-muted-foreground" />}
        />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('title')}
        </h3>
      </div>

      <div className="flex gap-1.5">
        <Input
          value={cep}
          placeholder={t('postalCodePlaceholder')}
          inputMode="numeric"
          maxLength={9}
          onChange={(e) => setCep(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void cotar();
          }}
          className="h-8 flex-1 text-[13px] tabular-nums"
        />
        <Button
          size="sm"
          className="h-8 shrink-0 px-3 text-xs"
          onClick={cotar}
          disabled={carregando}
        >
          {carregando ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            t('calculate')
          )}
        </Button>
      </div>

      {!status.has_origin ? (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
          {t('noOrigin')}
        </p>
      ) : null}

      {erro ? (
        <p className="mt-2 text-[11px] text-red-700 dark:text-red-400">{erro}</p>
      ) : null}

      {opcoes !== null ? (
        opcoes.length === 0 ? (
          <p className="mt-3 text-[12px] text-muted-foreground">
            {t('noOptions')}
          </p>
        ) : (
          <>
            <ul className="mt-3 space-y-1.5">
              {opcoes.map((o) => (
                <li
                  key={o.id}
                  className={cn(
                    'relative rounded-lg border px-2.5 py-2',
                    o.error
                      ? 'border-border opacity-50'
                      : o.id === maisBarato?.id
                        ? 'border-emerald-600/40 bg-emerald-600/5'
                        : 'border-border'
                  )}
                >
                  {/* Selo do mais barato, como no app. É a informação
                      que o operador procura primeiro. */}
                  {o.id === maisBarato?.id ? (
                    <span className="absolute -top-2 right-2 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                      {t('bestPrice')}
                    </span>
                  ) : null}

                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {/* Logo da transportadora vinda da própria API.
                          É o mesmo reconhecimento visual do app: o
                          operador identifica Correios ou Loggi pela
                          marca antes de ler o nome. */}
                      {o.companyLogoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={o.companyLogoUrl}
                          alt=""
                          width={20}
                          height={20}
                          className="h-5 w-5 shrink-0 rounded object-contain"
                          loading="lazy"
                        />
                      ) : null}
                      <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-foreground">
                        {o.name}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {o.error
                          ? o.error
                          : o.deliveryDays === null
                            ? o.company
                            : t('upToDays', { days: o.deliveryDays })}
                      </p>
                      </div>
                    </div>

                    {!o.error ? (
                      <div className="shrink-0 text-right">
                        <p className="text-[13px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                          {formatCents(o.priceCents)}
                        </p>
                        {o.listPriceCents ? (
                          <p className="text-[10px] tabular-nums text-muted-foreground line-through">
                            {formatCents(o.listPriceCents)}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>

            {/* Uma opção só quase nunca é o que o operador espera.
                Sem esta linha ele fica sem saber se é limitação da
                conta ou falha da integração — e as duas têm
                consertos completamente diferentes. */}
            {opcoes.filter((o) => !o.error).length === 1 ? (
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {t('singleOptionHint')}
              </p>
            ) : null}

            {mensagem ? (
              <Button
                size="sm"
                variant="secondary"
                className="mt-2.5 h-8 w-full text-xs"
                onClick={copiar}
              >
                {copiado ? (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t('copyMessage')}
              </Button>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}
