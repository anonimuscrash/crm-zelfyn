'use client';

// ============================================================
// Nome do contato, editável no lugar.
//
// O CABEÇALHO NUNCA SOME
// ----------------------
// A primeira versão trocava o título pelo campo quando não havia
// nome. Errado: o operador perdia a referência de com quem está
// falando justamente na tela de atendimento.
//
// Agora o título está sempre lá — nome quando existe, telefone
// enquanto não existe — e o campo aparece só durante a edição. A
// linha do telefone, logo abaixo, é de outro componente e não é
// tocada.
//
// Sem nome: caneta sempre visível, porque há algo a fazer.
// Com nome: caneta ao passar o mouse, porque não há.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';

export function ContactNameEditor({
  contactId,
  name,
  phone,
  onSaved,
}: {
  contactId: string;
  name: string | null;
  phone: string | null;
  onSaved: (novo: string) => void;
}) {
  const t = useTranslations('Inbox.contact');
  const tc = useTranslations('Commerce');

  // "Sem nome" inclui o caso em que o nome É o telefone: o contato
  // veio do WhatsApp e ninguém o identificou ainda.
  const semNome =
    !name?.trim() ||
    name.replace(/\D/g, '') === (phone ?? '').replace(/\D/g, '');

  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState('');
  const [salvando, setSalvando] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editando) inputRef.current?.focus();
  }, [editando]);

  function abrir() {
    setValor(semNome ? '' : (name ?? ''));
    setEditando(true);
  }

  async function salvar() {
    const limpo = valor.trim();
    if (!limpo) {
      setEditando(false);
      return;
    }

    setSalvando(true);
    try {
      // Escrita direta pelo cliente do navegador, com a RLS
      // garantindo o isolamento — é o padrão que o resto da
      // aplicação já usa.
      //
      // A primeira versão chamava `/api/v1/contacts`, que é a API
      // PÚBLICA para integrações externas e exige chave de API, não
      // a sessão. Daí o "Missing or invalid API key": a rota estava
      // certa para um integrador, errada para a própria interface.
      const supabase = createClient();

      const { error } = await supabase
        .from('contacts')
        .update({ name: limpo })
        .eq('id', contactId);

      if (error) throw new Error(error.message);

      toast.success(t('nameSaved'));
      onSaved(limpo);
      setEditando(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setSalvando(false);
    }
  }

  if (editando) {
    return (
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          value={valor}
          placeholder={t('namePlaceholder')}
          maxLength={100}
          onChange={(e) => setValor(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void salvar();
            if (e.key === 'Escape') setEditando(false);
          }}
          className="h-8 flex-1 text-center text-[13px]"
        />
        <button
          type="button"
          onClick={salvar}
          disabled={salvando || !valor.trim()}
          aria-label={tc('save')}
          className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          {salvando ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setEditando(false)}
          aria-label={tc('cancel')}
          className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <span className="group flex items-center justify-center gap-1.5">
      <span
        className={cn(
          'truncate text-sm font-semibold',
          semNome ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {semNome ? (phone ?? t('namePlaceholder')) : name}
      </span>

      <button
        type="button"
        onClick={abrir}
        aria-label={semNome ? t('addName') : t('editName')}
        title={semNome ? t('addName') : t('editName')}
        className={cn(
          'shrink-0 rounded p-1 transition-opacity hover:bg-muted hover:text-foreground',
          // Sem nome, a caneta fica sempre visível: há uma ação
          // pendente e escondê-la atrás do hover a tornaria
          // invisível no toque.
          semNome
            ? 'text-primary opacity-100'
            : 'text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100'
        )}
      >
        <Pencil className="h-3 w-3" />
      </button>
    </span>
  );
}
