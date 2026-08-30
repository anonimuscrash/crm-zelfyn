// ============================================================
// Contrato comum entre provedores de WhatsApp.
//
// Existe para que Inbox, mensagens e contatos não saibam de qual
// provedor a conversa veio. Trocar o serviço QR por outro — ou
// adicionar um terceiro — deve ser escrever um adapter novo, não
// mexer em tela.
//
// O contrato é DELIBERADAMENTE POBRE: só o que os dois provedores
// realmente fazem. Métodos que só um suporta (templates da Meta,
// reações do WhatsApp Web) ficam fora e são acessados pelo adapter
// específico quando necessário. Um contrato que promete mais do que
// o provedor entrega vira `throw new Error('not supported')`
// espalhado pela aplicação.
// ============================================================

export type WhatsAppProviderId = 'meta_cloud' | 'qr';

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_required'
  | 'qr_expired'
  | 'connected'
  | 'logged_out'
  | 'failed';

/** Estado de uma sessão, na linguagem do produto — nunca do provedor. */
export interface SessionState {
  status: ConnectionStatus;
  /** Detalhe curto para o suporte. Nunca exibido cru ao usuário. */
  detail?: string | null;
  phoneNumber?: string | null;
  displayName?: string | null;
}

/** QR de pareamento. Efêmero: nunca persistido. */
export interface QrPayload {
  /** Data URL PNG pronta para <img src>. */
  dataUrl: string;
  /** Quando expira. O front usa para pedir outro sem o usuário agir. */
  expiresAt: string;
}

export type OutgoingContentType = 'text' | 'image' | 'document' | 'audio' | 'video';

export interface OutgoingMessage {
  /**
   * Destinatário. Aceita o chat id completo (`...@c.us`, `...@lid`)
   * ou só dígitos — nesse caso o adapter assume `@c.us`.
   */
  to: string;
  type: OutgoingContentType;
  text?: string;
  /** URL pública da mídia. */
  mediaUrl?: string;
  fileName?: string;
  caption?: string;
}

export interface SendResult {
  /** Id da mensagem no provedor. Alimenta a deduplicação. */
  externalId: string;
}

/** Evento normalizado de entrada, já livre do formato do provedor. */
export interface InboundMessage {
  externalId: string;
  /** Telefone do outro lado da conversa, só dígitos. */
  phone: string;
  /**
   * Identificador COMPLETO do chat no provedor, com sufixo:
   * `5511999998888@c.us` ou `249460508647484@lid`.
   *
   * É este valor que endereça o envio. Reconstruir a partir de
   * `phone` obriga a adivinhar o sufixo, e adivinhar errado produz
   * um endereço que não existe — a chamada é aceita e a mensagem não
   * chega a ninguém.
   */
  chatId: string;
  pushName?: string | null;
  contentType: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location';
  text?: string | null;
  mediaUrl?: string | null;
  /** Verdadeiro quando a mensagem saiu do próprio número (eco). */
  fromMe: boolean;
  /**
   * Verdadeiro quando `phone` é um identificador interno do WhatsApp
   * (LID) e não um número real.
   *
   * A mensagem é ingerida mesmo assim — perder a conversa é pior que
   * ter o contato mal identificado — mas o envio recusa com mensagem
   * clara em vez de falhar no provedor.
   */
  identifierOnly?: boolean;
  timestamp: string;
}

export type WebhookEvent =
  | { kind: 'message'; message: InboundMessage }
  | { kind: 'status'; state: SessionState }
  | { kind: 'ignored'; reason: string };

/**
 * O que todo provedor precisa saber fazer.
 *
 * `instanceId` é o identificador da sessão no serviço, gerado pelo
 * servidor a partir do id da conexão — nunca vindo do cliente.
 */
export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;

  /** Cria a sessão no serviço. Idempotente. */
  createSession(instanceId: string): Promise<void>;

  /** Estado atual da sessão. */
  getState(instanceId: string): Promise<SessionState>;

  /**
   * QR de pareamento. `null` quando a sessão não está esperando
   * pareamento — já conectada, por exemplo.
   */
  getQr(instanceId: string): Promise<QrPayload | null>;

  /** Encerra a sessão. Não apaga nada na Operza. */
  logout(instanceId: string): Promise<void>;

  /** Remove a sessão do serviço. */
  deleteSession(instanceId: string): Promise<void>;

  sendMessage(instanceId: string, message: OutgoingMessage): Promise<SendResult>;

  /**
   * URL da foto de perfil de um contato, ou `null`.
   *
   * `null` é resultado normal, não erro: o contato pode não ter foto,
   * ou tê-la restrita a quem está na agenda dele.
   */
  getProfilePicture(instanceId: string, chatId: string): Promise<string | null>;

  /**
   * Traduz um payload bruto de webhook para o evento normalizado.
   *
   * Puro: sem I/O e sem efeito colateral, para ser testável sem o
   * serviço no ar.
   */
  parseWebhook(payload: unknown): WebhookEvent;
}

/** Erro de provedor com status HTTP para a rota traduzir. */
export class ProviderError extends Error {
  readonly status: number;
  readonly cause?: unknown;

  constructor(message: string, status = 502, cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.cause = cause;
  }
}
