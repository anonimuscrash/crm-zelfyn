// ============================================================
// Branding — ponto único de verdade da identidade Operza.
//
// Existe para que trocar um nome, um caminho de asset ou uma cor
// institucional seja uma edição em UM arquivo, e não um
// find-and-replace por 400 arquivos. Nenhum componente escreve
// "Operza" literalmente: importa daqui.
//
// DUAS VARIANTES POR ASSET
// ------------------------
// A marca tem versão de tinta escura e de tinta branca. Nomeadas
// pelo CONTEXTO DE USO (`onLight` / `onDark`), não pela cor da
// tinta — "logo clara" é ambíguo (clara para usar onde?), enquanto
// "onLight" só pode significar uma coisa.
//
// Alternar por CSS e não por JavaScript: ler o tema em JS obriga a
// esperar a hidratação, e a logo apareceria trocada por um frame a
// cada carregamento.
// ============================================================

export const branding = {
  /** Nome exibido ao usuário. Nunca "wacrm". */
  name: 'Operza',

  /** Usado em título de página: "Pedidos | Operza". */
  titleTemplate: '%s | Operza',

  description:
    'Plataforma de gestão de vendas, pedidos, produtos e equipes.',

  /** Frase de apoio no login. Descreve o produto, não vende nada. */
  tagline: 'Vendas, pedidos e equipe no mesmo lugar.',

  /** Como o produto se refere ao próprio suporte. */
  supportName: 'suporte da Operza',

  /** Rótulo da área administrativa da plataforma. */
  adminName: 'Operza Admin',

  assets: {
    logo: {
      onLight: '/branding/operza-logo-on-light.png',
      onDark: '/branding/operza-logo-on-dark.png',
    },
    symbol: {
      onLight: '/branding/operza-symbol-on-light.png',
      onDark: '/branding/operza-symbol-on-dark.png',
    },
    /** Alta resolução, para a marca d'água em escala grande. */
    symbolLarge: {
      onLight: '/branding/operza-symbol-large-on-light.png',
      onDark: '/branding/operza-symbol-large-on-dark.png',
    },
    appleTouchIcon: '/branding/apple-touch-icon.png',
    icon192: '/branding/icon-192.png',
    icon512: '/branding/icon-512.png',
  },

  /**
   * Proporções nativas. Passadas para next/image para o navegador
   * reservar a caixa exata antes do download — sem isso a sidebar
   * dá um pulo de layout no primeiro paint.
   *
   * As duas variantes do símbolo têm alturas ligeiramente diferentes
   * (340 vs 335), então cada uma carrega a sua: usar uma média
   * deformaria uma das duas.
   */
  dimensions: {
    logoOnLight: { width: 560, height: 115 },
    logoOnDark: { width: 560, height: 115 },
    symbolOnLight: { width: 320, height: 340 },
    symbolOnDark: { width: 320, height: 335 },
  },

  /** Cores institucionais, amostradas do PNG oficial. */
  colors: {
    graphite: '#0C1523',
    blue: '#004EFA',
    blueDark: '#0038C4',
  },
} as const;

export type Branding = typeof branding;
