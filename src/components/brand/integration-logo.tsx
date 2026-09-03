// ============================================================
// Logo de integração de terceiro.
//
// VARIANTES POR TEMA
// ------------------
// Uma logo de tinta escura some sobre fundo preto, e uma de tinta
// branca some sobre fundo claro. Fornecedores sérios publicam as
// duas versões — a SuperFrete publica.
//
// Nomeadas pelo CONTEXTO DE USO, não pela cor da tinta:
//
//   superfrete-on-light.png   tinta verde, para fundo claro
//   superfrete-on-dark.png    tinta branca, para fundo escuro
//   whatsapp.png              versão única, funciona nos dois
//
// A troca é por CSS, não por JavaScript — ler o tema em JS obrigaria
// a esperar a hidratação, e a logo apareceria invertida por um frame
// a cada carregamento. Mesma decisão da marca da Operza.
//
// Se o arquivo não existir, cai num ícone neutro sem quebrar nada.
// ============================================================

'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';

const SO_CLARO = 'block dark:hidden';
const SO_ESCURO = 'hidden dark:block';

export function IntegrationLogo({
  name,
  fallback,
  size = 20,
  themed = false,
  className,
}: {
  /** Nome base do arquivo, sem extensão nem sufixo de variante. */
  name: string;
  /** Exibido quando o arquivo não existe. */
  fallback: React.ReactNode;
  size?: number;
  /**
   * Quando `true`, procura `{name}-on-light.png` e
   * `{name}-on-dark.png` em vez de `{name}.png`.
   */
  themed?: boolean;
  className?: string;
}) {
  const [falhou, setFalhou] = useState(false);

  if (falhou) {
    return <span className={cn('shrink-0', className)}>{fallback}</span>;
  }

  const estilo = { height: size, width: size };
  const base = '/branding/integrations';

  if (!themed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`${base}/${name}.png`}
        alt=""
        width={size}
        height={size}
        onError={() => setFalhou(true)}
        className={cn('shrink-0 object-contain', className)}
        style={estilo}
      />
    );
  }

  return (
    <span className={cn('inline-block shrink-0', className)} style={estilo}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${base}/${name}-on-light.png`}
        alt=""
        width={size}
        height={size}
        onError={() => setFalhou(true)}
        className={cn('object-contain', SO_CLARO)}
        style={estilo}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${base}/${name}-on-dark.png`}
        alt=""
        width={size}
        height={size}
        className={cn('object-contain', SO_ESCURO)}
        style={estilo}
      />
    </span>
  );
}
