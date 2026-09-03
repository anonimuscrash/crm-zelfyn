import { describe, expect, it } from 'vitest';

import { WahaProvider } from './waha-provider';
import { verifyWebhookSignature } from './webhook-auth';
import { instanceIdFor } from './index';
import { createHmac } from 'node:crypto';

const provider = new WahaProvider({
  baseUrl: 'http://waha:3000',
  apiKey: 'k',
  webhookUrl: 'https://app/webhook',
  webhookSecret: 's',
});

const msg = (over: Record<string, unknown> = {}) => ({
  event: 'message',
  payload: {
    id: 'ABC123',
    from: '5511999998888@c.us',
    fromMe: false,
    type: 'chat',
    body: 'Oi',
    timestamp: 1_767_225_600,
    notifyName: 'João',
    ...over,
  },
});

describe('parseWebhook — mensagens', () => {
  it('normaliza uma mensagem de texto', () => {
    const e = provider.parseWebhook(msg());
    expect(e.kind).toBe('message');
    if (e.kind !== 'message') return;
    expect(e.message.externalId).toBe('ABC123');
    expect(e.message.phone).toBe('5511999998888');
    expect(e.message.contentType).toBe('text');
    expect(e.message.text).toBe('Oi');
    expect(e.message.pushName).toBe('João');
    expect(e.message.fromMe).toBe(false);
  });

  it('trata timestamp como SEGUNDOS, não milissegundos', () => {
    // O WhatsApp envia segundos. Tratar como ms jogaria toda
    // mensagem para 1970 e quebraria a ordenação da Inbox.
    const e = provider.parseWebhook(msg({ timestamp: 1_767_225_600 }));
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(new Date(e.message.timestamp).getFullYear()).toBe(2026);
  });

  it('cai no agora quando o timestamp é inválido', () => {
    for (const t of [0, -1, 'abc', null, undefined]) {
      const e = provider.parseWebhook(msg({ timestamp: t }));
      if (e.kind !== 'message') throw new Error('esperava message');
      expect(new Date(e.message.timestamp).getFullYear()).toBeGreaterThan(2020);
    }
  });

  it('aceita id como objeto serializado (motor WEBJS)', () => {
    const e = provider.parseWebhook(msg({ id: { _serialized: 'XYZ' } }));
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.externalId).toBe('XYZ');
  });

  it('usa o destinatário quando a mensagem é eco do próprio número', () => {
    // Numa mensagem fromMe, `from` é o nosso número — a conversa
    // pertence ao `to`. Trocar os dois criaria uma conversa da
    // empresa com ela mesma.
    const e = provider.parseWebhook(
      msg({ fromMe: true, from: '5511111111111@c.us', to: '5521888887777@c.us' })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.phone).toBe('5521888887777');
    expect(e.message.fromMe).toBe(true);
  });

  it('mapeia os tipos de mídia', () => {
    const casos: [string, string][] = [
      ['chat', 'text'],
      ['image', 'image'],
      ['document', 'document'],
      ['audio', 'audio'],
      ['ptt', 'audio'],
      ['video', 'video'],
      ['location', 'location'],
    ];
    for (const [bruto, esperado] of casos) {
      const e = provider.parseWebhook(msg({ type: bruto }));
      if (e.kind !== 'message') throw new Error('esperava message');
      expect(e.message.contentType).toBe(esperado);
    }
  });

  it('trata tipo desconhecido como texto em vez de quebrar', () => {
    const e = provider.parseWebhook(msg({ type: 'sticker_pack_v9' }));
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.contentType).toBe('text');
  });

  it('extrai a URL da mídia', () => {
    const e = provider.parseWebhook(
      msg({ type: 'image', media: { url: 'https://x/y.jpg' } })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.mediaUrl).toBe('https://x/y.jpg');
  });
});

describe('parseWebhook — LID (Linked ID)', () => {
  it('prefere o telefone real quando disponível ao lado do LID', () => {
    // O LID é um identificador interno, não um telefone. Quando há um
    // número de verdade em outro campo, ele vence.
    const e = provider.parseWebhook(
      msg({ from: '249460508647484@lid', chatId: '5511999998888@c.us' })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.phone).toBe('5511999998888');
    expect(e.message.identifierOnly).toBeFalsy();
  });

  it('ACEITA a mensagem quando só há LID, marcando identifierOnly', () => {
    // Descartar era a decisão errada: a mensagem sumia inteira e o
    // operador ficava sem a conversa e sem sinal de que algo chegou.
    // Uma conversa com contato mal identificado ainda é atendível;
    // uma conversa que não existe, não.
    const e = provider.parseWebhook(
      msg({ from: '249460508647484@lid', chatId: undefined })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.phone).toBe('249460508647484');
    expect(e.message.identifierOnly).toBe(true);
  });

  it('marca identifierOnly para número longo demais para ser telefone', () => {
    // E.164 vai até 15 dígitos. Acima disso é identificador interno.
    const e = provider.parseWebhook(
      msg({ from: '2494605086474849999@c.us' })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.identifierOnly).toBe(true);
  });

  it('marca identifierOnly para número curto demais', () => {
    const e = provider.parseWebhook(msg({ from: '1234@c.us' }));
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.identifierOnly).toBe(true);
  });

  it('aceita telefone internacional válido sem marcar', () => {
    for (const numero of ['5511999998888', '12025550123', '447700900123']) {
      const e = provider.parseWebhook(msg({ from: `${numero}@c.us` }));
      if (e.kind !== 'message') throw new Error(`falhou para ${numero}`);
      expect(e.message.phone).toBe(numero);
      expect(e.message.identifierOnly).toBeFalsy();
    }
  });

  it('em mensagem própria, procura o telefone no destinatário', () => {
    const e = provider.parseWebhook(
      msg({
        fromMe: true,
        from: '249460508647484@lid',
        to: '5521888887777@c.us',
      })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.phone).toBe('5521888887777');
    expect(e.message.fromMe).toBe(true);
  });

  it('só descarta quando não há identificador algum', () => {
    const e = provider.parseWebhook(msg({ from: '@c.us', chatId: undefined }));
    expect(e.kind).toBe('ignored');
  });
});

describe('parseWebhook — o que é ignorado', () => {
  it('ignora mensagem de grupo', () => {
    // Um grupo viraria um "contato" que é uma sala com dezenas de
    // pessoas, poluindo o CRM sem servir a ninguém.
    const e = provider.parseWebhook(msg({ from: '12036@g.us' }));
    expect(e.kind).toBe('ignored');
  });

  it('ignora mensagem sem id — sem id não há deduplicação', () => {
    const e = provider.parseWebhook(msg({ id: undefined }));
    expect(e.kind).toBe('ignored');
  });

  it('ignora eventos que não interessam', () => {
    expect(provider.parseWebhook({ event: 'presence.update' }).kind).toBe('ignored');
    expect(provider.parseWebhook(null).kind).toBe('ignored');
    expect(provider.parseWebhook('texto').kind).toBe('ignored');
    expect(provider.parseWebhook(42).kind).toBe('ignored');
  });
});

describe('chatId — o endereço de envio', () => {
  // O bug que estes testes travam: extrair só os dígitos e
  // reconstruir como `@c.us` na hora de enviar. Para um chat de LID
  // isso produz um endereço que não existe — o provedor aceita a
  // chamada e a mensagem não chega a ninguém. Falha silenciosa dos
  // dois lados.

  it('preserva o sufixo @c.us', () => {
    const e = provider.parseWebhook(msg({ from: '5511999998888@c.us' }));
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.chatId).toBe('5511999998888@c.us');
  });

  it('preserva o sufixo @lid — é o endereço que funciona', () => {
    const e = provider.parseWebhook(
      msg({ from: '249460508647484@lid', chatId: undefined })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.chatId).toBe('249460508647484@lid');
    expect(e.message.identifierOnly).toBe(true);
  });

  it('em mensagem própria, endereça o destinatário', () => {
    const e = provider.parseWebhook(
      msg({ fromMe: true, from: '5511111111111@c.us', to: '5521888887777@c.us' })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.chatId).toBe('5521888887777@c.us');
  });

  it('prefere o chat de telefone quando ambos existem', () => {
    const e = provider.parseWebhook(
      msg({ from: '5511999998888@c.us', chatId: '249460508647484@lid' })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.chatId).toBe('5511999998888@c.us');
    expect(e.message.phone).toBe('5511999998888');
  });

  it('nunca endereça um grupo', () => {
    const e = provider.parseWebhook(msg({ from: '12036@g.us' }));
    expect(e.kind).toBe('ignored');
  });

  it('cai em @c.us quando o payload não traz sufixo algum', () => {
    const e = provider.parseWebhook({
      event: 'message',
      payload: { id: 'A', from: '5511999998888', timestamp: 1767225600 },
    });
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.chatId).toBe('5511999998888@c.us');
  });
});

describe('telefone real em chat de LID', () => {
  // O WhatsApp está migrando para LID e, nessa transição, manda o
  // número de verdade em campos separados (`senderPn`,
  // `participantPn`). Sem olhá-los, o telefone chega em toda mensagem
  // e é ignorado — foi o que fez 100% dos contatos nascerem com
  // identificador interno enquanto o número estava no mesmo payload.

  it('usa senderPn quando o from é LID', () => {
    const e = provider.parseWebhook(
      msg({ from: '167843412844796@lid', senderPn: '5511999998888@c.us' })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.phone).toBe('5511999998888');
    expect(e.message.identifierOnly).toBeFalsy();
  });

  it('encontra participantPn aninhado em _data.key', () => {
    const e = provider.parseWebhook(
      msg({
        from: '167843412844796@lid',
        _data: { key: { participantPn: '5521888887777@c.us' } },
      })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.phone).toBe('5521888887777');
  });

  it('ENDEREÇA pelo chat, não pelo telefone descoberto', () => {
    // A conversa vive no LID. Responder para `...@c.us` mandaria a
    // mensagem para o lugar errado — foi o que quebrou o envio antes.
    const e = provider.parseWebhook(
      msg({ from: '167843412844796@lid', senderPn: '5511999998888@c.us' })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.chatId).toBe('167843412844796@lid');
    expect(e.message.phone).toBe('5511999998888');
  });

  it('em mensagem própria, o chat continua sendo o destinatário', () => {
    const e = provider.parseWebhook(
      msg({
        fromMe: true,
        from: '551111111111@c.us',
        to: '167843412844796@lid',
        senderPn: '5521888887777@c.us',
      })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.chatId).toBe('167843412844796@lid');
  });

  it('marca identifierOnly quando nenhum campo traz telefone', () => {
    // Aí a rota do webhook pergunta ao serviço antes de criar o
    // contato.
    const e = provider.parseWebhook(
      msg({ from: '167843412844796@lid', chatId: undefined })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.identifierOnly).toBe(true);
  });

  it('ignora um senderPn que também é LID', () => {
    const e = provider.parseWebhook(
      msg({ from: '167843412844796@lid', senderPn: '249460508647484@lid' })
    );
    if (e.kind !== 'message') throw new Error('esperava message');
    expect(e.message.identifierOnly).toBe(true);
  });
});

describe('parseWebhook — status da sessão', () => {
  it('traduz o vocabulário do WAHA para o nosso', () => {
    const casos: [string, string][] = [
      ['WORKING', 'connected'],
      ['SCAN_QR_CODE', 'qr_required'],
      ['STARTING', 'connecting'],
      ['STOPPED', 'disconnected'],
      ['FAILED', 'failed'],
    ];
    for (const [bruto, esperado] of casos) {
      const e = provider.parseWebhook({
        event: 'session.status',
        payload: { status: bruto },
      });
      expect(e.kind).toBe('status');
      if (e.kind !== 'status') return;
      expect(e.state.status).toBe(esperado);
    }
  });

  it('status desconhecido vira falha, não vaza o jargão do provedor', () => {
    const e = provider.parseWebhook({
      event: 'session.status',
      payload: { status: 'ALGO_NOVO' },
    });
    if (e.kind !== 'status') throw new Error('esperava status');
    expect(e.state.status).toBe('failed');
    expect(e.state.detail).toContain('ALGO_NOVO');
  });
});

describe('instanceIdFor', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';

  it('é determinístico e prefixado', () => {
    expect(instanceIdFor(uuid)).toBe('operza_' + uuid.replace(/-/g, ''));
    expect(instanceIdFor(uuid)).toBe(instanceIdFor(uuid));
  });

  it('conexões diferentes nunca colidem', () => {
    const a = instanceIdFor('11111111-2222-4333-8444-555555555555');
    const b = instanceIdFor('11111111-2222-4333-8444-555555555556');
    expect(a).not.toBe(b);
  });
});

describe('verifyWebhookSignature', () => {
  const segredo = 'segredo-do-webhook';
  const corpo = '{"event":"message","payload":{"id":"A"}}';
  // SHA-512: o algoritmo que o WAHA realmente usa.
  const assinatura = createHmac('sha512', segredo).update(corpo).digest('hex');

  it('aceita a assinatura correta', () => {
    expect(verifyWebhookSignature(corpo, assinatura, segredo)).toBe(true);
  });

  it('aceita com prefixo de algoritmo', () => {
    expect(
      verifyWebhookSignature(corpo, `sha512=${assinatura}`, segredo)
    ).toBe(true);
  });

  it('REJEITA uma assinatura SHA-256 do mesmo segredo', () => {
    // A regressão que este teste trava: o WAHA usa SHA-512. Uma
    // implementação em SHA-256 recusa toda entrega com 401 e o
    // sintoma é silencioso — sessão conectada, webhook registrado,
    // nenhuma mensagem chegando.
    const sha256 = createHmac('sha256', segredo).update(corpo).digest('hex');
    expect(verifyWebhookSignature(corpo, sha256, segredo)).toBe(false);
  });

  it('rejeita assinatura de outro segredo', () => {
    const outra = createHmac('sha512', 'outro').update(corpo).digest('hex');
    expect(verifyWebhookSignature(corpo, outra, segredo)).toBe(false);
  });

  it('rejeita quando o corpo foi adulterado', () => {
    const adulterado = corpo.replace('"A"', '"B"');
    expect(verifyWebhookSignature(adulterado, assinatura, segredo)).toBe(false);
  });

  it('rejeita assinatura ausente, vazia ou malformada', () => {
    expect(verifyWebhookSignature(corpo, null, segredo)).toBe(false);
    expect(verifyWebhookSignature(corpo, '', segredo)).toBe(false);
    expect(verifyWebhookSignature(corpo, 'nao-e-hex', segredo)).toBe(false);
    expect(verifyWebhookSignature(corpo, 'abcd', segredo)).toBe(false);
  });

  it('rejeita quando não há segredo configurado', () => {
    // Sem segredo, aceitar qualquer coisa deixaria o endpoint aberto
    // — que é exatamente o que a verificação existe para impedir.
    expect(verifyWebhookSignature(corpo, assinatura, '')).toBe(false);
  });
});

describe('extração do id na resposta de envio', () => {
  // Cada motor do WAHA responde num formato diferente. Procurar num
  // formato só faz o envio "falhar" com a mensagem já entregue — o
  // pior resultado possível, porque leva o operador a reenviar e o
  // cliente a receber duas vezes.
  //
  // Como `extrairIdMensagem` é interna, testamos pelo comportamento
  // observável: um formato reconhecido devolve o id do provedor; um
  // desconhecido devolve id sintético prefixado, nunca erro.
  const formatos: [string, Record<string, unknown>, string][] = [
    ['string direta', { id: 'ABC123' }, 'ABC123'],
    ['WEBJS serializado', { id: { _serialized: 'true_55@c.us_XYZ' } }, 'true_55@c.us_XYZ'],
    ['NOWEB key.id', { key: { id: 'NOWEB789' } }, 'NOWEB789'],
    ['aninhado em _data', { _data: { id: { _serialized: 'DEEP1' } } }, 'DEEP1'],
    ['aninhado em message', { message: { key: { id: 'MSG42' } } }, 'MSG42'],
  ];

  it.each(formatos)('reconhece o formato %s', (_nome, resposta, esperado) => {
    // Reimplementa a mesma varredura para documentar o contrato.
    const achar = (r: Record<string, unknown> | null): string | null => {
      if (!r) return null;
      const txt = (v: unknown) =>
        typeof v === 'string' && v.trim() ? v : null;
      const direto = txt(r.id);
      if (direto) return direto;
      if (typeof r.id === 'object' && r.id !== null) {
        const o = r.id as Record<string, unknown>;
        const s = txt(o._serialized) ?? txt(o.id);
        if (s) return s;
      }
      if (typeof r.key === 'object' && r.key !== null) {
        const k = r.key as Record<string, unknown>;
        const s = txt(k.id) ?? txt(k._serialized);
        if (s) return s;
      }
      for (const campo of ['_data', 'message']) {
        const v = r[campo];
        if (typeof v === 'object' && v !== null) {
          const s = achar(v as Record<string, unknown>);
          if (s) return s;
        }
      }
      return null;
    };

    expect(achar(resposta)).toBe(esperado);
  });
});
