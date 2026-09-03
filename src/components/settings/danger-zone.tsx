'use client';

// ============================================================
// Configurações → Limpar dados.
//
// Operação irreversível. A interface é desenhada para DESACELERAR:
//
//   • os números aparecem ANTES de qualquer escolha;
//   • nada vem marcado por padrão;
//   • a lista do que é preservado fica visível o tempo todo — a
//     dúvida "vou perder meus produtos?" é a que trava o operador;
//   • confirmação digitada, não checkbox;
//   • o botão só habilita com escopo escolhido E palavra correta.
//
// Um clique rápido aqui destrói trabalho. O atrito é o recurso.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useSessionContext } from '@/hooks/use-session-context';
import { canManageIntegrations } from '@/lib/auth/permissions';
import { ErrorState, Skeleton } from '@/components/commerce/primitives';

interface Resumo {
  contacts: number;
  conversations: number;
  messages: number;
  orders: number;
  charges: number;
  expenses: number;
  products: number;
  lid_contacts: number;
}

export function DangerZone() {
  const t = useTranslations('DangerZone');
  const tc = useTranslations('Commerce');
  const { context } = useSessionContext();

  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [apagando, setApagando] = useState(false);

  // Nada marcado por padrão. Um checkbox pré-marcado numa tela
  // destrutiva é convite a apagar por engano.
  const [conversas, setConversas] = useState(false);
  const [pedidos, setPedidos] = useState(false);
  const [contatos, setContatos] = useState(false);
  const [despesas, setDespesas] = useState(false);
  const [soLid, setSoLid] = useState(true);
  const [confirmacao, setConfirmacao] = useState('');

  const podeGerenciar = canManageIntegrations(context);

  const carregar = useCallback(async () => {
    try {
      const res = await fetch('/api/account/reset');
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? tc('loadError'));
      }
      setResumo((await res.json()) as Resumo);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setCarregando(false);
    }
  }, [tc]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const algoSelecionado = conversas || pedidos || contatos || despesas;
  const palavraCerta =
    confirmacao.trim().toUpperCase() === t('confirmWord').toUpperCase();

  async function apagar() {
    setApagando(true);
    try {
      const res = await fetch('/api/account/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: confirmacao,
          conversations: conversas,
          orders: pedidos,
          contacts: contatos,
          expenses: despesas,
          lid_contacts_only: contatos && soLid,
        }),
      });

      const json = (await res.json()) as {
        error?: string;
        deleted_conversations?: number;
        deleted_orders?: number;
        deleted_contacts?: number;
      };

      if (!res.ok) throw new Error(json.error ?? tc('loadError'));

      // Mostra os números do que saiu. Um "pronto" sem contagem
      // deixa a dúvida de se algo realmente aconteceu.
      toast.success(
        t('resultSummary', {
          conversations: json.deleted_conversations ?? 0,
          orders: json.deleted_orders ?? 0,
          contacts: json.deleted_contacts ?? 0,
        }),
        { duration: 8000 }
      );

      setConfirmacao('');
      setConversas(false);
      setPedidos(false);
      setContatos(false);
      setDespesas(false);
      void carregar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setApagando(false);
    }
  }

  if (carregando) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (erro) return <ErrorState message={erro} onRetry={carregar} />;
  if (!resumo) return null;

  if (!podeGerenciar) {
    return (
      <p className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
        {t('masterOnly')}
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Trash2 className="h-4 w-4" />
          {t('title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {/* ---- Prévia ---- */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('current')}
        </h3>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
          <Linha rotulo={t('contacts')} valor={resumo.contacts} />
          <Linha rotulo={t('conversations')} valor={resumo.conversations} />
          <Linha rotulo={t('messages')} valor={resumo.messages} />
          <Linha rotulo={t('orders')} valor={resumo.orders} />
          <Linha rotulo={t('charges')} valor={resumo.charges} />
          <Linha rotulo={t('expenses')} valor={resumo.expenses} />
          <Linha rotulo={t('products')} valor={resumo.products} preservado />
        </div>

        {resumo.lid_contacts > 0 ? (
          <p className="mt-3 rounded-lg border border-amber-600/25 bg-amber-600/5 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
            {t('lidContacts', { count: resumo.lid_contacts })}
          </p>
        ) : null}
      </section>

      {/* ---- Escopo ---- */}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('whatToDelete')}
        </h3>

        <Opcao
          marcado={conversas}
          onChange={setConversas}
          rotulo={t('optConversations')}
          contagem={resumo.conversations + resumo.messages}
        />
        <Opcao
          marcado={pedidos}
          onChange={setPedidos}
          rotulo={t('optOrders')}
          contagem={resumo.orders + resumo.charges}
        />
        <Opcao
          marcado={contatos}
          onChange={setContatos}
          rotulo={t('optContacts')}
          contagem={soLid ? resumo.lid_contacts : resumo.contacts}
        />

        {contatos ? (
          <div className="ml-6 border-l border-border pl-3">
            <label className="flex cursor-pointer items-start gap-2 text-[13px] text-foreground">
              <input
                type="checkbox"
                checked={soLid}
                onChange={(e) => setSoLid(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border accent-[var(--primary)]"
              />
              <span>
                {t('lidOnly')}
                <span className="block text-[11px] text-muted-foreground">
                  {t('lidOnlyHelp')}
                </span>
              </span>
            </label>
          </div>
        ) : null}

        <Opcao
          marcado={despesas}
          onChange={setDespesas}
          rotulo={t('optExpenses')}
          contagem={resumo.expenses}
        />
      </section>

      {/* ---- O que sobrevive ----
          Fica visível o tempo todo: "vou perder meus produtos?" é a
          dúvida que trava o operador na frente deste botão. */}
      <section className="rounded-lg border border-border bg-muted/30 p-4">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('keptTitle')}
        </h3>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {t('keptBody')}
        </p>
      </section>

      {/* ---- Confirmação ---- */}
      <section className="space-y-3 rounded-lg border border-red-600/25 bg-red-600/5 p-4">
        <p className="flex items-start gap-2 text-[13px] font-medium text-red-700 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t('warning')}
        </p>

        <div>
          <Label htmlFor="dz-confirm" className="text-xs text-muted-foreground">
            {t('confirmLabel')}
          </Label>
          <Input
            id="dz-confirm"
            value={confirmacao}
            onChange={(e) => setConfirmacao(e.target.value)}
            placeholder={t('confirmWord')}
            autoComplete="off"
            className="mt-1 h-9 max-w-[200px] font-mono"
          />
        </div>

        <Button
          size="sm"
          onClick={apagar}
          disabled={apagando || !algoSelecionado || !palavraCerta}
          className="bg-red-600 text-white hover:bg-red-700"
        >
          {apagando ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          )}
          {apagando ? t('deleting') : t('execute')}
        </Button>

        {!algoSelecionado ? (
          <p className="text-[11px] text-muted-foreground">
            {t('nothingSelected')}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Linha({
  rotulo,
  valor,
  preservado,
}: {
  rotulo: string;
  valor: number;
  preservado?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[12px] text-muted-foreground">{rotulo}</span>
      <span
        className={cn(
          'text-[13px] font-medium tabular-nums',
          preservado
            ? 'text-emerald-700 dark:text-emerald-400'
            : 'text-foreground'
        )}
      >
        {valor}
      </span>
    </div>
  );
}

function Opcao({
  marcado,
  onChange,
  rotulo,
  contagem,
}: {
  marcado: boolean;
  onChange: (v: boolean) => void;
  rotulo: string;
  contagem: number;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors',
        marcado ? 'border-red-600/30 bg-red-600/5' : 'border-border'
      )}
    >
      <span className="flex items-center gap-2 text-[13px] text-foreground">
        <input
          type="checkbox"
          checked={marcado}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-border accent-red-600"
        />
        {rotulo}
      </span>
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
        {contagem}
      </span>
    </label>
  );
}
