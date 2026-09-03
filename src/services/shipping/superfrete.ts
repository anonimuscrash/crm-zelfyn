// ============================================================
// Integração SuperFrete — cotação de frete.
//
// SOBRE A DOCUMENTAÇÃO
// --------------------
// O endpoint, a autenticação e o header obrigatório vêm da
// documentação oficial:
//
//   POST {base}/api/v0/calculator
//   Authorization: Bearer {token}
//   User-Agent: Nome da aplicação e versão (email@contato)
//   accept: application/json
//
// A página de referência do payload bloqueia acesso automatizado, e
// eu NÃO inventei campos. O corpo abaixo segue o formato público que
// as integrações da SuperFrete usam, e o parser da resposta é
// deliberadamente TOLERANTE: aceita variações de nome de campo
// (`price`/`custom_price`, `delivery_time`/`custom_delivery_time`) e
// ignora o que não reconhece, em vez de quebrar.
//
// Isso importa porque uma cotação que falha por um nome de campo
// diferente é indistinguível, para o operador, de uma integração
// mal configurada.
//
// VALIDE NO SANDBOX antes de produção. O ambiente é configurável
// exatamente para isso.
// ============================================================

export type ShippingEnvironment = 'sandbox' | 'production';

/**
 * Serviços pedidos por padrão: PAC (1), SEDEX (2), Mini Envios (17).
 *
 * NÃO é um chute. Estes IDs vieram da resposta real da API, e a
 * chamada com exatamente esta lista devolveu PAC, SEDEX **e** LOGGI —
 * ou seja, o campo não é um filtro estrito: transportadoras
 * habilitadas na conta vêm junto.
 *
 * Sem enviar o campo, a mesma conta devolvia só LOGGI. Por isso o
 * padrão é enviar, não omitir: um valor que sabemos funcionar vale
 * mais que um comportamento implícito do provedor que não
 * controlamos.
 */
export const DEFAULT_SERVICES = '1,2,17';

const BASES: Record<ShippingEnvironment, string> = {
  sandbox: 'https://sandbox.superfrete.com',
  production: 'https://api.superfrete.com',
};

export class ShippingError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ShippingError';
    this.status = status;
  }
}

export interface QuoteRequest {
  originPostalCode: string;
  destinationPostalCode: string;
  heightCm: number;
  widthCm: number;
  lengthCm: number;
  weightKg: number;
  /** Valor declarado, em centavos. 0 = sem seguro. */
  insuranceCents?: number;
  /**
   * IDs de serviço separados por vírgula. Vazio ou ausente = deixa o
   * provedor decidir.
   *
   * Existe porque o retorno padrão depende do que está habilitado na
   * conta SuperFrete, e às vezes vem só uma transportadora. Forçar a
   * lista é a saída quando o padrão não traz o que se espera.
   */
  services?: string | null;
}

/** Uma opção de envio, já normalizada. */
export interface ShippingOption {
  id: string;
  /** "PAC", "SEDEX", "Loggi", "Jadlog". */
  name: string;
  company: string;
  /** Logo da transportadora, quando o provedor fornece. */
  companyLogoUrl: string | null;
  /** Preço final, em centavos. */
  priceCents: number;
  /** Preço de tabela (sem desconto), em centavos. `null` se igual. */
  listPriceCents: number | null;
  /** Prazo em dias úteis. */
  deliveryDays: number | null;
  /** Mensagem quando a transportadora recusou a rota. */
  error: string | null;
}

interface SuperFreteConfig {
  token: string;
  contactEmail: string;
  environment: ShippingEnvironment;
}

/** Só dígitos. O provedor recusa CEP com hífen. */
export function normalizePostalCode(cep: string): string {
  return (cep ?? '').replace(/\D/g, '');
}

export function isValidPostalCode(cep: string): boolean {
  return normalizePostalCode(cep).length === 8;
}

/** Converte reais (número ou string) para centavos, sem float. */
function toCents(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value === 'string') {
    // Aceita "28,56" e "28.56": a API às vezes devolve string com
    // vírgula decimal, e `Number("28,56")` é NaN.
    const limpo = value.replace(/[^\d,.-]/g, '').replace(',', '.');
    const n = Number(limpo);
    if (Number.isFinite(n)) return Math.round(n * 100);
  }
  return 0;
}

function toDays(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value === 'string') {
    const n = Number(value.replace(/\D/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export class SuperFreteProvider {
  constructor(private readonly config: SuperFreteConfig) {}

  private get baseUrl(): string {
    return BASES[this.config.environment];
  }

  async quote(request: QuoteRequest): Promise<ShippingOption[]> {
    const from = normalizePostalCode(request.originPostalCode);
    const to = normalizePostalCode(request.destinationPostalCode);

    if (from.length !== 8) {
      throw new ShippingError('CEP de origem inválido', 400);
    }
    if (to.length !== 8) {
      throw new ShippingError('CEP de destino inválido', 400);
    }

    const body = {
      from: { postal_code: from },
      to: { postal_code: to },
      package: {
        height: request.heightCm,
        width: request.widthCm,
        length: request.lengthCm,
        weight: request.weightKg,
      },
      // `services` SEMPRE enviado. O padrão só é substituído quando
      // a conta configura outra lista.
      services: request.services?.trim() || DEFAULT_SERVICES,
      // `options` só quando há seguro declarado.
      //
      // A chamada que devolveu as três transportadoras não enviava
      // este bloco. Mandá-lo com valores neutros não deveria mudar
      // nada — mas "não deveria" é diferente de "não muda", e num
      // provedor de terceiro a diferença aparece em produção.
      ...((request.insuranceCents ?? 0) > 0
        ? {
            options: {
              own_hand: false,
              receipt: false,
              insurance_value: (request.insuranceCents ?? 0) / 100,
              use_insurance_value: true,
            },
          }
        : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v0/calculator`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          // Obrigatório pela documentação. Sem ele a API recusa.
          'User-Agent': `Operza (${this.config.contactEmail})`,
          accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        // Cotação acontece no meio de um atendimento; melhor errar
        // rápido que segurar a tela do vendedor.
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ShippingError('Serviço de frete indisponível', 503);
    }

    if (res.status === 401 || res.status === 403) {
      // Não repassar o corpo: às vezes ecoa parte do token enviado.
      throw new ShippingError('Credencial do SuperFrete inválida', 502);
    }

    if (!res.ok) {
      const texto = await res.text().catch(() => '');
      throw new ShippingError(
        `SuperFrete respondeu ${res.status}${texto ? `: ${texto.slice(0, 200)}` : ''}`,
        502
      );
    }

    const dados = (await res.json().catch(() => null)) as unknown;
    const opcoes = normalizeQuoteResponse(dados);

    // Log de diagnóstico quando o provedor devolve menos do que o
    // esperado. Sem isto, descobrir por que faltou uma transportadora
    // exige reproduzir a chamada por fora com curl — foi exatamente
    // o que aconteceu na primeira vez.
    if (opcoes.length <= 1) {
      console.warn('[superfrete] cotação com poucas opções', {
        services: body.services,
        origem: from,
        destino: to,
        peso: request.weightKg,
        retornadas: opcoes.length,
        nomes: opcoes.map((o) => o.name),
      });
    }

    return opcoes;
  }
}

/**
 * Normaliza a resposta em opções de envio.
 *
 * Exportada para ser testável sem rede — é aqui que mora toda a
 * lógica frágil de nomes de campo.
 *
 * Opções com erro (transportadora não atende a rota) são MANTIDAS
 * com a mensagem: some-las faria a lista variar de tamanho sem
 * explicação, e o operador ficaria sem saber por que o SEDEX não
 * apareceu.
 */
export function normalizeQuoteResponse(dados: unknown): ShippingOption[] {
  const lista = Array.isArray(dados)
    ? dados
    : Array.isArray((dados as { data?: unknown })?.data)
      ? ((dados as { data: unknown[] }).data)
      : [];

  const opcoes: ShippingOption[] = [];

  for (const bruto of lista) {
    if (typeof bruto !== 'object' || bruto === null) continue;
    const o = bruto as Record<string, unknown>;

    const empresa = (o.company ?? {}) as Record<string, unknown>;

    // PREÇO FINAL
    //
    // `price` já é o valor com desconto aplicado — confirmado contra
    // a resposta real da API. `custom_price` aparece em algumas
    // integrações e, quando vem, é o mesmo papel.
    const precoFinal = toCents(o.custom_price ?? o.price);

    // PREÇO DE TABELA
    //
    // A API não devolve o valor cheio: devolve `discount`, o quanto
    // foi abatido. O riscado é a soma dos dois.
    //
    // Sem isto o card nunca mostrava o desconto — e o desconto é a
    // razão de o operador usar a SuperFrete. Mostrar só "R$ 10,66"
    // esconde que o cliente está economizando R$ 5,33.
    const desconto = toCents(o.discount);
    const precoTabela =
      desconto > 0 ? precoFinal + desconto : toCents(o.price);

    // A API marca falha em `has_error` (booleano) e às vezes traz
    // `error` com o texto. Checar só o texto deixava passar opções
    // que a transportadora recusou.
    const temErro = o.has_error === true;
    const textoErro =
      typeof o.error === 'string' && o.error.trim() ? o.error.trim() : null;
    const erro = textoErro ?? (temErro ? 'Rota não atendida' : null);

    const nome =
      (typeof o.name === 'string' && o.name) ||
      (typeof empresa.name === 'string' && empresa.name) ||
      'Envio';

    opcoes.push({
      id: String(o.id ?? nome),
      name: nome,
      company:
        (typeof empresa.name === 'string' && empresa.name) || 'Transportadora',
      companyLogoUrl:
        typeof empresa.picture === 'string' && empresa.picture
          ? empresa.picture
          : null,
      priceCents: precoFinal,
      // Só mostra o riscado quando há desconto real. Exibir o mesmo
      // valor riscado ao lado dele seria um desconto falso.
      listPriceCents:
        precoTabela > precoFinal && precoFinal > 0 ? precoTabela : null,
      deliveryDays: toDays(o.delivery_time ?? o.custom_delivery_time),
      error: erro,
    });
  }

  // Mais barato primeiro — é a ordem em que o operador decide. As
  // que deram erro vão para o fim: não são escolhas.
  return opcoes.sort((a, b) => {
    if (a.error && !b.error) return 1;
    if (!a.error && b.error) return -1;
    return a.priceCents - b.priceCents;
  });
}

/**
 * Monta a mensagem para o vendedor colar no WhatsApp.
 *
 * Texto puro, sem markdown: o WhatsApp não renderiza `**` e o
 * cliente veria os asteriscos. Usa o `*negrito*` do próprio
 * WhatsApp, que ele entende.
 */
export function buildShippingMessage(opcoes: ShippingOption[]): string {
  const validas = opcoes.filter((o) => !o.error && o.priceCents > 0);
  if (validas.length === 0) return '';

  const linhas = validas.map((o) => {
    const preco = (o.priceCents / 100).toFixed(2).replace('.', ',');
    const prazo =
      o.deliveryDays === null
        ? ''
        : ` — até ${o.deliveryDays} ${o.deliveryDays === 1 ? 'dia útil' : 'dias úteis'}`;
    return `• ${o.name}: R$ ${preco}${prazo}`;
  });

  return `*Opções de envio*\n\n${linhas.join('\n')}`;
}
