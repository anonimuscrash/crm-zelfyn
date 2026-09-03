'use client';

// ============================================================
// Quem atende numa conexão de WhatsApp.
//
// A tabela `whatsapp_connection_members` existe desde a migration
// 048 e a regra de acesso já era aplicada — faltava a interface para
// gerenciá-la.
//
// NENHUM SELECIONADO = TODOS ATENDEM
// ----------------------------------
// É a leitura que o operador faz ao desmarcar tudo, e a alternativa
// — "ninguém atende" — deixaria a conexão inútil. A tela diz isso
// explicitamente em vez de deixar adivinhar.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Users } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Agente {
  user_id: string;
  full_name: string;
  account_role: string;
  assigned: boolean;
}

export function ConnectionAgents({
  connectionId,
  onSaved,
}: {
  connectionId: string;
  onSaved?: () => void;
}) {
  const t = useTranslations('WhatsApp');
  const tt = useTranslations('Team');
  const tc = useTranslations('Commerce');

  const [agentes, setAgentes] = useState<Agente[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/whatsapp/connections/${connectionId}/agents`
      );
      if (!res.ok) return;
      const json = (await res.json()) as { agents: Agente[] };
      setAgentes(json.agents);
    } finally {
      setCarregando(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function alternar(userId: string) {
    setAgentes((atual) =>
      atual.map((a) =>
        a.user_id === userId ? { ...a, assigned: !a.assigned } : a
      )
    );
  }

  async function salvar() {
    setSalvando(true);
    try {
      const res = await fetch(
        `/api/whatsapp/connections/${connectionId}/agents`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_ids: agentes.filter((a) => a.assigned).map((a) => a.user_id),
          }),
        }
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? tc('loadError'));
      }
      toast.success(t('agentsSaved'));
      onSaved?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) {
    return (
      <div className="h-16 animate-pulse rounded-lg bg-muted" />
    );
  }

  const nenhum = agentes.every((a) => !a.assigned);

  return (
    <div className="mt-4 border-t border-border pt-4">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Users className="h-3 w-3" />
        {t('sellers')}
      </p>

      <ul className="space-y-1">
        {agentes.map((a) => (
          <li key={a.user_id}>
            <label
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[13px] transition-colors',
                a.assigned
                  ? 'border-primary/30 bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground'
              )}
            >
              <input
                type="checkbox"
                checked={a.assigned}
                onChange={() => alternar(a.user_id)}
                className="h-3.5 w-3.5 rounded border-border accent-[var(--primary)]"
              />
              <span className="min-w-0 flex-1 truncate">{a.full_name}</span>
              <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                {a.account_role === 'owner' || a.account_role === 'admin'
                  ? tt('roleMaster')
                  : tt('roleSeller')}
              </span>
            </label>
          </li>
        ))}
      </ul>

      {nenhum ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t('agentsAll')}
        </p>
      ) : null}

      <Button
        size="sm"
        variant="secondary"
        className="mt-2 h-8 text-xs"
        onClick={salvar}
        disabled={salvando}
      >
        {salvando ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
        {tc('save')}
      </Button>
    </div>
  );
}
