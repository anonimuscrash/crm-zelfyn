import { describe, expect, it } from 'vitest';

import {
  buildShippingMessage,
  DEFAULT_SERVICES,
  isValidPostalCode,
  normalizePostalCode,
  normalizeQuoteResponse,
} from './superfrete';

describe('normalizePostalCode', () => {
  it('remove hífen, ponto e espaço', () => {
    expect(normalizePostalCode('01001-000')).toBe('01001000');
    expect(normalizePostalCode('01.001-000')).toBe('01001000');
    expect(normalizePostalCode(' 01001000 ')).toBe('01001000');
  });

  it('valida os 8 dígitos', () => {
    expect(isValidPostalCode('01001-000')).toBe(true);
    expect(isValidPostalCode('0100100')).toBe(false);
    expect(isValidPostalCode('010010000')).toBe(false);
    expect(isValidPostalCode('')).toBe(false);
  });
});

describe('normalizeQuoteResponse', () => {
  const resposta = [
    {
      id: 1,
      name: 'PAC',
      price: 63.9,
      custom_price: 51.46,
      delivery_time: 10,
      company: { name: 'Correios', picture: 'https://x/correios.png' },
    },
    {
      id: 2,
      name: 'SEDEX',
      price: 104.5,
      custom_price: 81.06,
      delivery_time: 6,
      company: { name: 'Correios' },
    },
    {
      id: 3,
      name: 'LOGGI',
      price: 42.84,
      custom_price: 28.56,
      delivery_time: 11,
      company: { name: 'Loggi' },
    },
  ];

  it('converte reais em centavos sem perder precisão', () => {
    const [primeiro] = normalizeQuoteResponse(resposta);
    expect(primeiro.priceCents).toBe(2856);
    expect(primeiro.listPriceCents).toBe(4284);
  });

  it('ordena do mais barato para o mais caro', () => {
    const o = normalizeQuoteResponse(resposta);
    expect(o.map((x) => x.name)).toEqual(['LOGGI', 'PAC', 'SEDEX']);
  });

  it('prefere custom_price — é o que o cliente vai pagar', () => {
    const o = normalizeQuoteResponse([
      { id: 1, name: 'PAC', price: 100, custom_price: 60, delivery_time: 5 },
    ]);
    expect(o[0].priceCents).toBe(6000);
    expect(o[0].listPriceCents).toBe(10000);
  });

  it('não inventa desconto quando os dois preços são iguais', () => {
    // Mostrar o mesmo valor riscado ao lado dele seria um desconto
    // falso — o tipo de detalhe que corrói a confiança na tela.
    const o = normalizeQuoteResponse([
      { id: 1, name: 'PAC', price: 50, custom_price: 50, delivery_time: 5 },
    ]);
    expect(o[0].listPriceCents).toBeNull();
  });

  it('aceita preço como string com vírgula decimal', () => {
    // `Number("28,56")` é NaN. Sem tratar, a opção apareceria como
    // R$ 0,00 — que o operador leria como frete grátis.
    const o = normalizeQuoteResponse([
      { id: 1, name: 'PAC', price: '63,90', custom_price: '51,46' },
    ]);
    expect(o[0].priceCents).toBe(5146);
    expect(o[0].listPriceCents).toBe(6390);
  });

  it('MANTÉM opções com erro, no fim da lista', () => {
    // Sumir com elas faria a lista variar de tamanho sem explicação,
    // e o operador ficaria sem saber por que o SEDEX não apareceu.
    const o = normalizeQuoteResponse([
      { id: 1, name: 'SEDEX', error: 'Rota não atendida' },
      { id: 2, name: 'PAC', price: 30, delivery_time: 8 },
    ]);
    expect(o).toHaveLength(2);
    expect(o[0].name).toBe('PAC');
    expect(o[1].error).toBe('Rota não atendida');
  });

  it('aceita a resposta embrulhada em data', () => {
    const o = normalizeQuoteResponse({ data: resposta });
    expect(o).toHaveLength(3);
  });

  it('devolve lista vazia para resposta inesperada, sem quebrar', () => {
    for (const entrada of [null, undefined, 'texto', 42, {}, { data: 'x' }]) {
      expect(normalizeQuoteResponse(entrada)).toEqual([]);
    }
  });

  it('ignora itens malformados no meio da lista', () => {
    const o = normalizeQuoteResponse([
      null,
      'lixo',
      { id: 1, name: 'PAC', price: 30 },
    ]);
    expect(o).toHaveLength(1);
  });

  it('extrai a logo da transportadora quando existe', () => {
    const o = normalizeQuoteResponse(resposta);
    const pac = o.find((x) => x.name === 'PAC');
    expect(pac?.companyLogoUrl).toBe('https://x/correios.png');
    const sedex = o.find((x) => x.name === 'SEDEX');
    expect(sedex?.companyLogoUrl).toBeNull();
  });
});

describe('buildShippingMessage', () => {
  const opcoes = normalizeQuoteResponse([
    { id: 1, name: 'LOGGI', custom_price: 28.56, delivery_time: 11 },
    { id: 2, name: 'PAC', custom_price: 51.46, delivery_time: 10 },
  ]);

  it('formata em texto puro com o negrito do WhatsApp', () => {
    const msg = buildShippingMessage(opcoes);
    expect(msg).toContain('*Opções de envio*');
    expect(msg).toContain('• LOGGI: R$ 28,56 — até 11 dias úteis');
    expect(msg).toContain('• PAC: R$ 51,46 — até 10 dias úteis');
    // Markdown de asterisco duplo apareceria literal para o cliente.
    expect(msg).not.toContain('**');
  });

  it('usa singular para prazo de um dia', () => {
    const um = normalizeQuoteResponse([
      { id: 1, name: 'Expresso', custom_price: 20, delivery_time: 1 },
    ]);
    expect(buildShippingMessage(um)).toContain('até 1 dia útil');
  });

  it('omite o prazo quando o provedor não informa', () => {
    const semPrazo = normalizeQuoteResponse([
      { id: 1, name: 'PAC', custom_price: 30 },
    ]);
    expect(buildShippingMessage(semPrazo)).toBe(
      '*Opções de envio*\n\n• PAC: R$ 30,00'
    );
  });

  it('não inclui opções com erro nem preço zero', () => {
    const mistas = normalizeQuoteResponse([
      { id: 1, name: 'PAC', custom_price: 30, delivery_time: 8 },
      { id: 2, name: 'SEDEX', error: 'Rota não atendida' },
      { id: 3, name: 'Grátis', custom_price: 0 },
    ]);
    const msg = buildShippingMessage(mistas);
    expect(msg).toContain('PAC');
    expect(msg).not.toContain('SEDEX');
    expect(msg).not.toContain('Grátis');
  });

  it('devolve vazio quando não há opção válida', () => {
    expect(buildShippingMessage([])).toBe('');
    const soErro = normalizeQuoteResponse([{ id: 1, name: 'X', error: 'nao' }]);
    expect(buildShippingMessage(soErro)).toBe('');
  });
});

describe('parâmetro services', () => {
  // O comportamento mudou por evidência, não por preferência: sem
  // enviar o campo, a API devolvia UMA transportadora; enviando
  // "1,2,17", devolvia três. Um padrão que sabemos funcionar vale
  // mais que um comportamento implícito do provedor.
  const montarCorpo = (services?: string | null, seguroCents = 0) => ({
    from: { postal_code: '01001000' },
    to: { postal_code: '20040020' },
    package: { height: 4, width: 12, length: 17, weight: 0.3 },
    services: services?.trim() || DEFAULT_SERVICES,
    ...(seguroCents > 0
      ? {
          options: {
            own_hand: false,
            receipt: false,
            insurance_value: seguroCents / 100,
            use_insurance_value: true,
          },
        }
      : {}),
  });

  it('usa o padrão quando nada foi configurado', () => {
    for (const v of [undefined, null, '', '   ']) {
      expect(montarCorpo(v).services).toBe('1,2,17');
    }
  });

  it('respeita a lista configurada', () => {
    expect(montarCorpo('1,2').services).toBe('1,2');
    expect(montarCorpo('  31  ').services).toBe('31');
  });

  it('nunca envia services vazio', () => {
    // Vazio pode significar "nenhum serviço" e devolver lista vazia —
    // pior que o problema que o campo resolve.
    expect(montarCorpo('').services).toBeTruthy();
    expect(montarCorpo(null).services).toBeTruthy();
  });

  it('omite `options` quando não há seguro declarado', () => {
    // A chamada que devolveu as três transportadoras não enviava
    // este bloco.
    expect('options' in montarCorpo(null, 0)).toBe(false);
  });

  it('inclui `options` quando há seguro', () => {
    const corpo = montarCorpo(null, 15_000);
    expect(corpo).toHaveProperty('options');
    expect(corpo.options?.insurance_value).toBe(150);
    expect(corpo.options?.use_insurance_value).toBe(true);
  });
});

describe('resposta real da API', () => {
  // Payload capturado da API de produção. Testar contra a resposta
  // REAL, e não contra a que eu imaginei, é o que pegou os dois bugs
  // desta seção: o desconto vinha em campo separado e a falha em
  // `has_error`, não em `error`.
  const real = [
    {
      id: 1,
      name: 'PAC',
      price: 21.15,
      discount: '4.65',
      currency: 'R$',
      delivery_time: 10,
      company: { id: 1, name: 'Correios', picture: 'https://x/correios.png' },
      has_error: false,
    },
    {
      id: 2,
      name: 'SEDEX',
      price: 13.73,
      discount: '13.87',
      delivery_time: 6,
      company: { id: 1, name: 'Correios', picture: 'https://x/correios.png' },
      has_error: false,
    },
    {
      id: 31,
      name: 'LOGGI',
      price: 10.66,
      discount: '5.33',
      delivery_time: 1,
      company: { id: 14, name: 'loggi', picture: 'https://x/loggi.png' },
      has_error: false,
    },
  ];

  it('devolve as três opções', () => {
    expect(normalizeQuoteResponse(real)).toHaveLength(3);
  });

  it('usa `price` como valor final', () => {
    const o = normalizeQuoteResponse(real);
    expect(o.find((x) => x.name === 'PAC')?.priceCents).toBe(2115);
    expect(o.find((x) => x.name === 'SEDEX')?.priceCents).toBe(1373);
    expect(o.find((x) => x.name === 'LOGGI')?.priceCents).toBe(1066);
  });

  it('SOMA o desconto para chegar ao preço de tabela', () => {
    // A API não devolve o valor cheio — devolve o quanto foi
    // abatido. Sem somar, o card nunca mostrava o riscado, e o
    // desconto é justamente a razão de usar a SuperFrete.
    const o = normalizeQuoteResponse(real);
    expect(o.find((x) => x.name === 'PAC')?.listPriceCents).toBe(2580);
    expect(o.find((x) => x.name === 'SEDEX')?.listPriceCents).toBe(2760);
    expect(o.find((x) => x.name === 'LOGGI')?.listPriceCents).toBe(1599);
  });

  it('aceita desconto como string', () => {
    // Vem como "4.65", não como número.
    const o = normalizeQuoteResponse([
      { id: 1, name: 'PAC', price: 10, discount: '2.50' },
    ]);
    expect(o[0].listPriceCents).toBe(1250);
  });

  it('não inventa riscado quando não há desconto', () => {
    const o = normalizeQuoteResponse([
      { id: 1, name: 'PAC', price: 10, discount: '0' },
    ]);
    expect(o[0].listPriceCents).toBeNull();
  });

  it('ordena LOGGI primeiro — é o mais barato', () => {
    const o = normalizeQuoteResponse(real);
    expect(o[0].name).toBe('LOGGI');
    expect(o[2].name).toBe('PAC');
  });

  it('reconhece falha por has_error, não só pelo texto', () => {
    // Checar só `error` deixava passar opções que a transportadora
    // recusou — elas apareceriam como se fossem escolhas válidas,
    // com preço zero.
    const o = normalizeQuoteResponse([
      { id: 2, name: 'SEDEX', has_error: true },
      { id: 1, name: 'PAC', price: 10, has_error: false },
    ]);
    expect(o.find((x) => x.name === 'SEDEX')?.error).toBe('Rota não atendida');
    expect(o.find((x) => x.name === 'PAC')?.error).toBeNull();
  });

  it('prefere o texto do erro quando a API o fornece', () => {
    const o = normalizeQuoteResponse([
      { id: 2, name: 'SEDEX', has_error: true, error: 'CEP fora de área' },
    ]);
    expect(o[0].error).toBe('CEP fora de área');
  });

  it('monta a mensagem com as três opções', () => {
    const msg = buildShippingMessage(normalizeQuoteResponse(real));
    expect(msg).toContain('• LOGGI: R$ 10,66 — até 1 dia útil');
    expect(msg).toContain('• SEDEX: R$ 13,73 — até 6 dias úteis');
    expect(msg).toContain('• PAC: R$ 21,15 — até 10 dias úteis');
  });
});
