'use client';

// ============================================================
// Seção recolhível da coluna do cliente.
//
// A coluna acumula pagamento, frete, histórico comercial, tags,
// negócios e notas. Com tudo aberto, "Nova venda" fica a três telas
// de rolagem — e é justamente o botão que fecha a venda.
//
// A escolha de cada seção é LEMBRADA por sessão. Quem fecha o frete
// porque não usa não deveria fechá-lo de novo a cada conversa.
// Guardado em memória, não em localStorage: os artefatos deste
// projeto não têm acesso a storage do navegador, e a preferência
// vale para a sessão de trabalho, que é o horizonte que importa.
// ============================================================

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

/** Estado compartilhado entre montagens, por seção. */
const abertoPorSecao = new Map<string, boolean>();

export function CollapsibleSection({
  id,
  title,
  icon,
  badge,
  defaultOpen = true,
  children,
}: {
  /** Identificador estável da seção, para lembrar a escolha. */
  id: string;
  title: string;
  icon?: React.ReactNode;
  /** Resumo curto exibido quando fechada — ex: "3 pedidos". */
  badge?: string | null;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [aberto, setAberto] = useState(
    () => abertoPorSecao.get(id) ?? defaultOpen
  );

  function alternar() {
    const novo = !aberto;
    setAberto(novo);
    abertoPorSecao.set(id, novo);
  }

  return (
    <section className="border-t border-border">
      <button
        type="button"
        onClick={alternar}
        aria-expanded={aberto}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40"
      >
        {icon}
        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>

        {/* Resumo quando fechada: sem ele, o operador precisa abrir
            para saber se há algo dentro. */}
        {!aberto && badge ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {badge}
          </span>
        ) : null}

        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            aberto ? 'rotate-180' : ''
          )}
        />
      </button>

      {/* Desmonta ao fechar, não esconde com CSS: a cotação de frete
          e o histórico fazem requisições ao montar, e mantê-los
          montados invisíveis gastaria rede por nada. */}
      {aberto ? <div className="px-4 pb-4">{children}</div> : null}
    </section>
  );
}
