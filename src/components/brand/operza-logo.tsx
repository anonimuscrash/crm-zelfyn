// ============================================================
// Componentes de marca.
//
// TROCA DE VARIANTE POR CSS, NÃO POR JAVASCRIPT
// ---------------------------------------------
// As duas versões (tinta escura e tinta branca) são renderizadas, e
// o CSS esconde a errada conforme `data-mode` no <html>.
//
// A alternativa — ler o tema em JS — obrigaria a esperar a
// hidratação, e a logo apareceria invertida por um frame a cada
// carregamento. O boot script do layout já grava `data-mode` antes
// do primeiro paint, então a variante certa é a única visível desde
// o começo.
//
// O custo é um download extra de ~20 KB. Barato pelo que evita.
//
// Nada de `filter: invert()` sobre a logo: deformaria o azul
// institucional para um laranja que não é a marca.
// ============================================================

import Image from 'next/image';

import { branding } from '@/lib/branding';
import { cn } from '@/lib/utils';

/** Esconde a variante que não corresponde ao modo atual. */
const SO_CLARO = 'block dark:hidden';
const SO_ESCURO = 'hidden dark:block';

export function OperzaLogo({
  className,
  height = 26,
  priority = false,
}: {
  className?: string;
  /** Altura em px. A largura acompanha pela proporção nativa. */
  height?: number;
  priority?: boolean;
}) {
  const d = branding.dimensions.logoOnLight;
  const width = Math.round((height * d.width) / d.height);

  return (
    <span
      className={cn('inline-block shrink-0 select-none', className)}
      style={{ height, width }}
    >
      <Image
        src={branding.assets.logo.onLight}
        alt={branding.name}
        width={width}
        height={height}
        priority={priority}
        className={SO_CLARO}
        style={{ height, width }}
      />
      <Image
        src={branding.assets.logo.onDark}
        alt=""
        aria-hidden
        width={width}
        height={height}
        priority={priority}
        className={SO_ESCURO}
        style={{ height, width }}
      />
    </span>
  );
}

export function OperzaSymbol({
  className,
  size = 28,
  priority = false,
}: {
  className?: string;
  size?: number;
  priority?: boolean;
}) {
  // Cada variante tem a própria proporção (340 vs 335 de altura
  // nativa); usar uma média deformaria uma das duas.
  const claro = branding.dimensions.symbolOnLight;
  const escuro = branding.dimensions.symbolOnDark;
  const wClaro = Math.round((size * claro.width) / claro.height);
  const wEscuro = Math.round((size * escuro.width) / escuro.height);

  return (
    <span
      className={cn('inline-block shrink-0 select-none', className)}
      style={{ height: size }}
    >
      <Image
        src={branding.assets.symbol.onLight}
        alt={branding.name}
        width={wClaro}
        height={size}
        priority={priority}
        className={SO_CLARO}
        style={{ height: size, width: wClaro }}
      />
      <Image
        src={branding.assets.symbol.onDark}
        alt=""
        aria-hidden
        width={wEscuro}
        height={size}
        priority={priority}
        className={SO_ESCURO}
        style={{ height: size, width: wEscuro }}
      />
    </span>
  );
}

/**
 * Marca d'água: símbolo em escala grande, atrás do conteúdo.
 *
 * Decorativa e apenas decorativa — `aria-hidden` e `pointer-events:
 * none` (aplicado pela classe `.operza-watermark`). Um leitor de
 * tela não deve anunciá-la, e um clique deve atravessá-la.
 *
 * A opacidade vive no CSS, não aqui, porque difere por modo: sobre
 * fundo escuro o mesmo valor lê como mais forte.
 */
export function OperzaWatermark({
  size = 520,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const d = branding.dimensions.symbolOnLight;
  const width = Math.round((size * d.width) / d.height);

  return (
    <div
      aria-hidden
      className={cn('operza-watermark', className)}
      style={{ height: size, width }}
    >
      <Image
        src={branding.assets.symbolLarge.onLight}
        alt=""
        width={width}
        height={size}
        className={SO_CLARO}
        style={{ height: size, width }}
      />
      <Image
        src={branding.assets.symbolLarge.onDark}
        alt=""
        width={width}
        height={size}
        className={SO_ESCURO}
        style={{ height: size, width }}
      />
    </div>
  );
}

/**
 * Tela de carregamento da aplicação.
 *
 * O símbolo pulsa lentamente. Sem spinner ao lado: dois indicadores
 * de espera na mesma tela competem, e o movimento adicional não
 * informa nada que o pulso já não informe.
 */
export function OperzaLoading({ label }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[60vh] w-full flex-col items-center justify-center gap-4">
      <OperzaSymbol size={44} className="animate-pulse" priority />
      {label ? (
        <p className="text-sm text-muted-foreground">{label}</p>
      ) : null}
    </div>
  );
}
