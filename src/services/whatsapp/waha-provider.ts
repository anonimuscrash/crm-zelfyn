// ============================================================
// Adapter WAHA — conexão por QR Code.
//
// POR QUE WAHA E NÃO EVOLUTION API
// --------------------------------
// Os dois são self-hosted, Docker-first e construídos sobre Baileys.
// A diferença que decidiu: o Evolution API é Apache-2.0 **com
// cláusulas de proteção de marca** — exige preservar logo e
// copyright e notificar o uso. Para um SaaS comercial white-label
// como a Operza isso é um problema jurídico, não estético. O WAHA é
// Apache-2.0 limpo.
//
// Secundariamente: WAHA expõe REST + Swagger e permite trocar o
// motor (NOWEB/WEBJS/GOWS) sem mexer em quem o consome — o que é
// exatamente a mesma postura de desacoplamento que este arquivo
// existe para manter.
//
// LIMITE CONHECIDO: o WAHA gratuito é de sessão única. Múltiplos
// números por instância exigem WAHA Plus (pago). A arquitetura aqui
// já suporta várias conexões; quem escala precisa do Plus ou de uma
// instância por número. Está documentado em WHATSAPP.md.
//
// TUDO QUE É ESPECÍFICO DO WAHA VIVE NESTE ARQUIVO. Nenhum outro
// ponto do projeto conhece os nomes de rota, o formato de payload
// ou o vocabulário de status dele.
// ============================================================

import { randomUUID } from 'node:crypto';

import {
  ProviderError,
  type ConnectionStatus,
  type OutgoingMessage,
  type QrPayload,
  type SendResult,
  type SessionState,
  type WebhookEvent,
  type WhatsAppProvider,
} from './types';

/**
 * Vocabulário de status do WAHA → o nosso.
 *
 * O mapeamento é explícito, não uma conversão de string, porque os
 * nomes não coincidem e um status desconhecido precisa cair num
 * estado seguro em vez de vazar o jargão do provedor para a tela.
 */
const MAPA_STATUS: Record<string, ConnectionStatus> = {
  STOPPED: 'disconnected',
  STARTING: 'connecting',
  SCAN_QR_CODE: 'qr_required',
  WORKING: 'connected',
  FAILED: 'failed',
};

/** Quanto tempo um QR do WhatsApp Web vale, aproximadamente. */
const QR_TTL_MS = 55_000;

interface WahaConfig {
  baseUrl: string;
  apiKey: string;
  /** URL que o WAHA chama com os eventos. */
  webhookUrl: string;
  /** Segredo compartilhado que assina o webhook. */
  webhookSecret: string;
}

export class WahaProvider implements WhatsAppProvider {
  readonly id = 'qr' as const;

  constructor(private readonly config: WahaConfig) {}

  private async call<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T | null> {
    let res: Response;

    try {
      res = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        headers: {
          'X-Api-Key': this.config.apiKey,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        // Um serviço QR fora do ar não pode segurar a requisição do
        // usuário indefinidamente; melhor errar rápido e mostrar
        // "erro de conexão".
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ProviderError(
        'Serviço de WhatsApp indisponível',
        503,
        err
      );
    }

    // 404 significa duas coisas MUITO diferentes conforme o método.
    //
    // Num GET, é "não existe" — `createSession` depende disso para
    // saber se precisa criar a sessão, e devolver null é o certo.
    //
    // Num POST, é "esse endpoint não existe nesta instalação". O
    // /api/sendVideo, por exemplo, só existe no WAHA Plus; no Core
    // ele responde 404. Devolver null aqui fazia o envio seguir como
    // se tivesse dado certo: `extrairIdMensagem(null)` não achava id,
    // o código assumia "aceito, só não li o id", inventava um
    // `local_...` e gravava a mensagem como enviada. Era exatamente
    // isso que fazia vídeo não ir e não mostrar erro nenhum.
    const metodo = String(init.method ?? 'GET').toUpperCase();
    if (res.status === 404) {
      if (metodo === 'GET') return null;
      throw new ProviderError(
        `Endpoint ${path} não existe nesta instalação do WhatsApp ` +
          `(404). Envio de vídeo e de áudio exigem o WAHA Plus.`,
        502
      );
    }

    if (res.status === 401 || res.status === 403) {
      // Não repassar a mensagem do serviço: ela às vezes ecoa parte
      // da chave enviada.
      throw new ProviderError('Credenciais do serviço inválidas', 502);
    }

    if (!res.ok) {
      const corpo = await res.text().catch(() => '');
      throw new ProviderError(
        `Serviço de WhatsApp respondeu ${res.status}`,
        502,
        corpo.slice(0, 300)
      );
    }

    if (res.status === 204) return null;
    return (await res.json().catch(() => null)) as T | null;
  }

  /** GET que devolve o corpo como base64. Para respostas de imagem. */
  private async fetchBinary(path: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.config.baseUrl}${path}`, {
        headers: { 'X-Api-Key': this.config.apiKey, Accept: 'image/png' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) return null;
      return Buffer.from(buf).toString('base64');
    } catch {
      return null;
    }
  }

  async createSession(instanceId: string): Promise<void> {
    // O WAHA rejeita criar uma sessão que já existe. Como esta
    // operação é chamada tanto no "conectar" quanto no "reconectar",
    // ela precisa ser idempotente — daí verificar antes.
    const existente = await this.call<{ name: string }>(
      `/api/sessions/${encodeURIComponent(instanceId)}`
    );

    if (!existente) {
      await this.call('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          name: instanceId,
          start: true,
          config: {
            // O NOWEB não guarda nada por padrão: sem o store, o WAHA
            // não consegue devolver chats, contatos nem histórico, e
            // parte dos payloads chega incompleta. Precisa ser
            // definido na CRIAÇÃO — a documentação avisa que mudar
            // depois do QR escaneado pode custar o histórico.
            noweb: {
              store: { enabled: true, fullSync: false },
            },
            webhooks: [
              {
                url: this.config.webhookUrl,
                events: ['message', 'message.any', 'session.status'],
                hmac: { key: this.config.webhookSecret },
              },
            ],
          },
        }),
      });
      return;
    }

    await this.call(`/api/sessions/${encodeURIComponent(instanceId)}/start`, {
      method: 'POST',
    }).catch(() => undefined);
  }

  async getState(instanceId: string): Promise<SessionState> {
    const dados = await this.call<{
      status?: string;
      me?: { id?: string; pushName?: string } | null;
    }>(`/api/sessions/${encodeURIComponent(instanceId)}`);

    if (!dados) {
      return { status: 'disconnected' };
    }

    const bruto = String(dados.status ?? '').toUpperCase();
    const status = MAPA_STATUS[bruto] ?? 'failed';

    // `me.id` vem como "5511999998888@c.us"; guardamos só os dígitos.
    const phone = dados.me?.id
      ? dados.me.id.split('@')[0].replace(/\D/g, '')
      : null;

    return {
      status,
      detail: MAPA_STATUS[bruto] ? null : `status desconhecido: ${bruto}`,
      phoneNumber: phone,
      displayName: dados.me?.pushName ?? null,
    };
  }

  async getQr(instanceId: string): Promise<QrPayload | null> {
    const estado = await this.getState(instanceId);
    if (estado.status !== 'qr_required') return null;

    // O endpoint devolve PNG BINÁRIO por padrão. O base64 em JSON só
    // vem com `Accept: application/json` — sem esse header a resposta
    // é uma imagem crua, `res.json()` falha e o QR nunca aparece.
    const dados = await this.call<{ mimetype?: string; data?: string }>(
      `/api/${encodeURIComponent(instanceId)}/auth/qr`,
      { headers: { Accept: 'application/json' } }
    );

    if (dados?.data) {
      return {
        dataUrl: `data:${dados.mimetype ?? 'image/png'};base64,${dados.data}`,
        expiresAt: new Date(Date.now() + QR_TTL_MS).toISOString(),
      };
    }

    // Fallback binário: versões mais antigas do WAHA ignoram o
    // Accept e respondem PNG de qualquer forma. Converter aqui evita
    // que uma diferença de versão do serviço deixe o operador sem
    // conseguir parear.
    const bin = await this.fetchBinary(
      `/api/${encodeURIComponent(instanceId)}/auth/qr`
    );
    if (!bin) return null;

    return {
      dataUrl: `data:image/png;base64,${bin}`,
      expiresAt: new Date(Date.now() + QR_TTL_MS).toISOString(),
    };
  }

  async logout(instanceId: string): Promise<void> {
    await this.call(`/api/sessions/${encodeURIComponent(instanceId)}/logout`, {
      method: 'POST',
    });
  }

  async deleteSession(instanceId: string): Promise<void> {
    await this.call(`/api/sessions/${encodeURIComponent(instanceId)}`, {
      method: 'DELETE',
    });
  }

  async sendMessage(
    instanceId: string,
    message: OutgoingMessage
  ): Promise<SendResult> {
    // Se veio com sufixo, usa como está. Só reconstrói quando
    // recebemos apenas dígitos — e aí `@c.us` é o palpite razoável.
    const chatId = message.to.includes('@')
      ? message.to
      : `${message.to.replace(/\D/g, '')}@c.us`;
    const base = { session: instanceId, chatId };

    let path: string;
    let body: Record<string, unknown>;

    switch (message.type) {
      case 'text':
        path = '/api/sendText';
        body = { ...base, text: message.text ?? '' };
        break;
      case 'image':
        path = '/api/sendImage';
        body = {
          ...base,
          file: { url: message.mediaUrl },
          caption: message.caption ?? message.text ?? '',
        };
        break;
      case 'document':
        path = '/api/sendFile';
        body = {
          ...base,
          file: { url: message.mediaUrl, filename: message.fileName },
          caption: message.caption ?? '',
        };
        break;
      case 'audio':
        path = '/api/sendVoice';
        body = { ...base, file: { url: message.mediaUrl } };
        break;
      case 'video':
        path = '/api/sendVideo';
        body = {
          ...base,
          file: { url: message.mediaUrl },
          caption: message.caption ?? '',
        };
        break;
    }

    const resposta = await this.call<Record<string, unknown>>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const id = extrairIdMensagem(resposta);

    if (!id) {
      // A CHAMADA FOI ACEITA (HTTP 2xx). A mensagem quase certamente
      // chegou ao cliente — só não conseguimos ler o identificador.
      //
      // Lançar erro aqui seria a decisão errada: o operador veria
      // "falhou", reenviaria, e o cliente receberia a mesma mensagem
      // duas vezes. Um envio duplicado para o cliente é um problema
      // real de atendimento; um id sintético é só um registro
      // imperfeito do nosso lado.
      //
      // O custo: quando o eco chegar pelo webhook com o id de
      // verdade, ele não vai casar com este e a mensagem pode
      // aparecer duplicada NA INBOX. Incômodo, mas visível e
      // corrigível — ao contrário de um cliente irritado.
      console.warn('[waha] envio sem id reconhecível', {
        path,
        chaves: resposta ? Object.keys(resposta) : [],
      });
      return { externalId: `local_${randomUUID()}` };
    }

    return { externalId: id };
  }

  async getProfilePicture(
    instanceId: string,
    chatId: string
  ): Promise<string | null> {
    try {
      const dados = await this.call<{ profilePictureURL?: string | null }>(
        `/api/${encodeURIComponent(instanceId)}/contacts/profile-picture` +
          `?contactId=${encodeURIComponent(chatId)}`
      );
      return dados?.profilePictureURL ?? null;
    } catch {
      // Foto é enfeite. Se a busca falhar, a conversa continua
      // perfeitamente utilizável — deixar o erro subir derrubaria a
      // ingestão da mensagem por causa de um avatar.
      return null;
    }
  }

  async resolvePhone(
    instanceId: string,
    chatId: string
  ): Promise<string | null> {
    try {
      const dados = await this.call<Record<string, unknown>>(
        `/api/contacts?session=${encodeURIComponent(instanceId)}` +
          `&contactId=${encodeURIComponent(chatId)}`
      );

      // O campo varia conforme o motor: `number`, `id`, `phone`.
      // Testar os três é mais barato que descobrir em produção qual
      // veio nesta versão.
      for (const bruto of [dados?.number, dados?.phone, dados?.id]) {
        const texto = String(bruto ?? '');
        if (!texto || texto.includes('@lid')) continue;
        const digitos = texto.split('@')[0].replace(/\D/g, '');
        if (digitos.length >= 10 && digitos.length <= 13) return digitos;
      }
      return null;
    } catch {
      // Resolver telefone é melhoria, não requisito. Deixar o erro
      // subir derrubaria a ingestão da mensagem por causa dele.
      return null;
    }
  }

  parseWebhook(payload: unknown): WebhookEvent {
    if (typeof payload !== 'object' || payload === null) {
      return { kind: 'ignored', reason: 'payload não é objeto' };
    }

    const evento = payload as {
      event?: string;
      payload?: Record<string, unknown>;
    };

    if (evento.event === 'session.status') {
      const bruto = String(evento.payload?.status ?? '').toUpperCase();
      return {
        kind: 'status',
        state: {
          status: MAPA_STATUS[bruto] ?? 'failed',
          detail: MAPA_STATUS[bruto] ? null : `status: ${bruto}`,
        },
      };
    }

    if (evento.event !== 'message' && evento.event !== 'message.any') {
      return { kind: 'ignored', reason: `evento ${evento.event}` };
    }

    const m = (evento.payload ?? {}) as Record<string, unknown>;
    const id =
      typeof m.id === 'string'
        ? m.id
        : ((m.id as { _serialized?: string } | undefined)?._serialized ?? null);

    if (!id) return { kind: 'ignored', reason: 'mensagem sem id' };

    const from = String(m.from ?? '');

    // Grupos ficam de fora. A Operza organiza atendimento comercial
    // um-a-um; ingerir grupo criaria "contatos" que são salas com
    // dezenas de pessoas e poluiria o CRM sem servir a ninguém.
    if (from.endsWith('@g.us')) {
      return { kind: 'ignored', reason: 'mensagem de grupo' };
    }

    const fromMe = Boolean(m.fromMe);

    // Identidade da contraparte.
    //
    // O WhatsApp às vezes entrega `@lid` (Linked ID) em vez de
    // `@c.us`. O LID é um identificador interno de 15+ dígitos que
    // NÃO é telefone — usá-lo como se fosse cria um contato chamado
    // "249460508647484" e, pior, um SEGUNDO contato quando a mesma
    // pessoa aparecer depois com o número real. O histórico comercial
    // do cliente se parte em dois.
    //
    // Quando só há LID disponível, procuramos o telefone real nos
    // campos alternativos que o WAHA expõe. Se nenhum vier, a
    // mensagem é ignorada: um contato com LID é pior que contato
    // nenhum, porque parece dado válido.
    // Onde procurar o telefone real.
    //
    // O WhatsApp está migrando para LID (Linked ID) e, nessa
    // transição, manda o número de verdade em campos SEPARADOS:
    // `senderPn` / `participantPn` ("Pn" de phone number). Eles
    // convivem com o `from`, que já vem como `...@lid`.
    //
    // Sem olhar esses campos, o telefone chega em toda mensagem e
    // nós o ignoramos — que é exatamente o que vinha acontecendo:
    // 100% dos contatos criados com identificador interno enquanto o
    // número estava ali no mesmo payload.
    const dados = (m._data ?? {}) as Record<string, unknown>;
    const chave = (dados.key ?? {}) as Record<string, unknown>;

    const camposDeTelefone = [
      m.senderPn,
      m.participantPn,
      dados.senderPn,
      dados.participantPn,
      chave.senderPn,
      chave.participantPn,
      chave.remoteJidAlt,
      m.remoteJidAlt,
    ];

    const candidatos = fromMe
      ? [m.to, ...camposDeTelefone, m.chatId, m.participant]
      : [...camposDeTelefone, from, m.chatId, m.participant, m.author];

    // O identificador COMPLETO, com sufixo. É o que endereça o envio.
    // O primeiro candidato não vazio e que não seja grupo.
    // Endereço do chat: continua sendo `from`/`to`/`chatId`, NÃO os
    // campos de telefone. Responder para `...@c.us` quando a conversa
    // vive em `...@lid` manda a mensagem para o lugar errado — foi o
    // que quebrou o envio antes.
    const chatId =
      [fromMe ? m.to : from, m.chatId, m.participant]
        .map((c) => String(c ?? ''))
        .find((c) => c.includes('@') && !c.endsWith('@g.us')) ?? '';

    let phone = '';
    for (const bruto of candidatos) {
      const texto = String(bruto ?? '');
      if (!texto || texto.includes('@lid') || texto.endsWith('@g.us')) continue;
      const digitos = texto.split('@')[0].replace(/\D/g, '');
      // Telefone internacional tem entre 8 e 15 dígitos (E.164). Um
      // LID passa disso; um id truncado fica abaixo.
      if (digitos.length >= 8 && digitos.length <= 15) {
        phone = digitos;
        break;
      }
    }

    // Fallback: nenhum campo trouxe telefone plausível.
    //
    // ACEITAR o identificador, não descartar. Descartar em silêncio
    // foi a decisão errada da versão anterior: a mensagem sumia
    // inteira, e o operador ficava sem a conversa e sem nenhum sinal
    // de que algo tinha chegado. Uma conversa com contato mal
    // identificado ainda é atendível — uma conversa que não existe,
    // não.
    //
    // `identifierOnly` marca o caso para a interface poder pedir o
    // número real e para o envio recusar com mensagem clara em vez
    // de erro genérico do provedor.
    let identifierOnly = false;
    if (!phone) {
      const bruto = String(candidatos.find((c) => c) ?? '');
      const digitos = bruto.split('@')[0].replace(/\D/g, '');
      if (!digitos) return { kind: 'ignored', reason: 'sem identificador' };
      phone = digitos;
      identifierOnly = true;
    }

    const tipoBruto = String(m.type ?? 'text').toLowerCase();
    const tipos: Record<string, 'text' | 'image' | 'document' | 'audio' | 'video' | 'location'> = {
      chat: 'text',
      text: 'text',
      image: 'image',
      document: 'document',
      audio: 'audio',
      ptt: 'audio',
      video: 'video',
      location: 'location',
    };

    const media = m.media as { url?: string } | undefined;

    // `timestamp` vem em segundos (padrão do WhatsApp), não em
    // milissegundos. Tratar como ms colocaria toda mensagem em 1970.
    const ts = Number(m.timestamp);
    const quando =
      Number.isFinite(ts) && ts > 0
        ? new Date(ts * 1000).toISOString()
        : new Date().toISOString();

    return {
      kind: 'message',
      message: {
        externalId: id,
        phone,
        pushName: typeof m.notifyName === 'string' ? m.notifyName : null,
        contentType: tipos[tipoBruto] ?? 'text',
        text: typeof m.body === 'string' ? m.body : null,
        mediaUrl: media?.url ?? null,
        chatId: chatId || `${phone}@c.us`,
        fromMe,
        timestamp: quando,
        identifierOnly,
      },
    };
  }
}


/**
 * Extrai o id da mensagem da resposta de envio.
 *
 * Cada motor do WAHA responde num formato diferente:
 *   NOWEB (Baileys) → { key: { id: 'ABC' } }
 *   WEBJS           → { id: { _serialized: 'true_55...@c.us_ABC' } }
 *   versões antigas → { id: 'ABC' }
 *
 * Procurar num formato só faz o envio "falhar" com a mensagem já
 * entregue — o pior resultado possível, porque leva o operador a
 * reenviar.
 */
function extrairIdMensagem(resposta: Record<string, unknown> | null): string | null {
  if (!resposta) return null;

  const comoTexto = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : null;

  // { id: 'ABC' }
  const direto = comoTexto(resposta.id);
  if (direto) return direto;

  // { id: { _serialized: '...' } } ou { id: { id: '...' } }
  if (typeof resposta.id === 'object' && resposta.id !== null) {
    const obj = resposta.id as Record<string, unknown>;
    const s = comoTexto(obj._serialized) ?? comoTexto(obj.id);
    if (s) return s;
  }

  // { key: { id: 'ABC' } } — formato do NOWEB
  if (typeof resposta.key === 'object' && resposta.key !== null) {
    const k = resposta.key as Record<string, unknown>;
    const s = comoTexto(k.id) ?? comoTexto(k._serialized);
    if (s) return s;
  }

  // { _data: { id: { _serialized: '...' } } }
  if (typeof resposta._data === 'object' && resposta._data !== null) {
    const d = resposta._data as Record<string, unknown>;
    const s = extrairIdMensagem(d);
    if (s) return s;
  }

  // { message: { key: { id } } }
  if (typeof resposta.message === 'object' && resposta.message !== null) {
    const s = extrairIdMensagem(resposta.message as Record<string, unknown>);
    if (s) return s;
  }

  return null;
}
