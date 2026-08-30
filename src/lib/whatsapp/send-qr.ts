// ============================================================
// Envio por conexão QR.
//
// Vive separado de `send-message.ts` de propósito. Aquele arquivo é
// o caminho da Meta Cloud API: valida template, resolve contexto de
// resposta, faz self-heal de cifra legada. Nada disso se aplica a
// uma sessão do WhatsApp Web, e enfiar `if (provider === 'qr')` no
// meio dele transformaria duas lógicas distintas num emaranhado que
// ninguém consegue mudar com segurança.
//
// O que os dois COMPARTILHAM é o que importa: gravam em `messages`,
// atualizam `conversations`, e a Inbox lê os dois sem saber a
// diferença.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  instanceIdFor,
  ProviderError,
  requireQrProvider,
  type OutgoingContentType,
} from '@/services/whatsapp';

export interface QrSendParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
}

export interface QrSendResult {
  messageId: string;
  externalId: string;
}

export class QrSendError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'QrSendError';
    this.status = status;
  }
}

/** Tipos que uma sessão QR sabe enviar. */
const TIPOS: Record<string, OutgoingContentType> = {
  text: 'text',
  image: 'image',
  document: 'document',
  audio: 'audio',
  video: 'video',
};

/**
 * A conversa usa conexão QR? Em caso afirmativo, devolve os dados
 * necessários para enviar.
 *
 * Retorna `null` quando a conversa não tem conexão QR associada — e
 * aí o chamador segue pelo caminho da Meta, sem mudança de
 * comportamento para quem usa a API oficial.
 */
export async function resolveQrConnection(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<{
  connectionId: string;
  instanceId: string;
  phone: string;
  /** Endereço completo do chat no provedor, quando conhecido. */
  chatId: string | null;
  status: string;
} | null> {
  const { data } = await db
    .from('conversations')
    .select(
      'whatsapp_connection_id, external_chat_id, contact:contacts(phone), connection:whatsapp_connections(id, provider, status, instance_identifier)'
    )
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (!data) return null;

  // O PostgREST devolve o embed como array quando não consegue
  // provar cardinalidade 1 pela FK. Normalizar aqui evita que a
  // diferença apareça como `undefined` silencioso mais adiante.
  const primeiro = <T,>(v: T | T[] | null | undefined): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

  const conexao = primeiro(
    data.connection as
      | {
          id: string;
          provider: string;
          status: string;
          instance_identifier: string | null;
        }
      | Array<{
          id: string;
          provider: string;
          status: string;
          instance_identifier: string | null;
        }>
      | null
  );

  const contato = primeiro(
    data.contact as { phone?: string } | Array<{ phone?: string }> | null
  );
  const phone = (contato?.phone ?? '').replace(/\D/g, '');

  const chatId = (data.external_chat_id as string | null) ?? null;

  // Vínculo explícito: a conversa sabe de qual conexão veio.
  if (conexao && conexao.provider === 'qr') {
    if (!phone && !chatId) {
      throw new QrSendError('Contato sem telefone', 400);
    }
    return {
      connectionId: conexao.id,
      instanceId: conexao.instance_identifier ?? instanceIdFor(conexao.id),
      phone,
      chatId,
      status: conexao.status,
    };
  }

  // Conexão da Meta explicitamente vinculada: segue pelo caminho
  // oficial, sem fallback.
  if (conexao) return null;

  // Sem vínculo. Antes de desistir, procura uma conexão QR ativa na
  // conta.
  //
  // Exigir o vínculo explícito era frágil demais: qualquer conversa
  // criada por outro caminho — importação, conversa anterior à
  // integração, contato criado à mão — ficava impossível de
  // responder, com a mensagem de erro apontando para a Meta, que a
  // conta nem usa.
  //
  // Só entra aqui quando existe UMA conexão QR conectada. Com duas ou
  // mais, adivinhar por qual número responder seria pior que recusar:
  // o cliente receberia resposta de um número que não é o que ele
  // contatou.
  const { data: ativas } = await db
    .from('whatsapp_connections')
    .select('id, status, instance_identifier')
    .eq('account_id', accountId)
    .eq('provider', 'qr')
    .eq('status', 'connected')
    .limit(2);

  if (!ativas || ativas.length !== 1) return null;
  if (!phone && !chatId) throw new QrSendError('Contato sem telefone', 400);

  const unica = ativas[0] as {
    id: string;
    status: string;
    instance_identifier: string | null;
  };

  // Amarra a conversa daqui em diante, para a próxima resposta não
  // precisar adivinhar de novo.
  void db
    .from('conversations')
    .update({ whatsapp_connection_id: unica.id })
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .then(() => undefined);

  return {
    connectionId: unica.id,
    instanceId: unica.instance_identifier ?? instanceIdFor(unica.id),
    phone,
    chatId,
    status: unica.status,
  };
}

/**
 * Envia pela sessão QR e persiste.
 *
 * A ORDEM IMPORTA: envia primeiro, grava depois. O inverso deixaria
 * uma mensagem na Inbox que o cliente nunca recebeu — pior que um
 * envio que falhou visivelmente, porque o operador acreditaria ter
 * respondido.
 */
export async function sendViaQr(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  conexao: {
    connectionId: string;
    instanceId: string;
    phone: string;
    chatId: string | null;
    status: string;
  },
  params: QrSendParams
): Promise<QrSendResult> {
  if (conexao.status !== 'connected') {
    throw new QrSendError(
      'O WhatsApp desta conversa está desconectado. Reconecte em Configurações.',
      409
    );
  }

  const tipo = TIPOS[params.messageType];
  if (!tipo) {
    throw new QrSendError(
      `Tipo de mensagem não suportado na conexão QR: ${params.messageType}`,
      400
    );
  }

  // Endereço do destinatário.
  //
  // Preferimos SEMPRE o chat id guardado: é o endereço exato de onde
  // a mensagem chegou, seja `@c.us` ou `@lid`. Reconstruir a partir
  // do telefone obriga a adivinhar o sufixo — e adivinhar errado
  // produz uma chamada que o provedor aceita e que não entrega nada.
  //
  // A validação de comprimento só se aplica ao caminho reconstruído:
  // um chat id conhecido é válido por definição, mesmo sendo LID.
  const destino = conexao.chatId ?? conexao.phone;

  if (!conexao.chatId) {
    if (conexao.phone.length < 8 || conexao.phone.length > 15) {
      throw new QrSendError(
        'Este contato não tem um endereço de envio conhecido. Peça ao cliente que envie uma mensagem para que a conversa seja identificada.',
        400
      );
    }
  }

  if (tipo === 'text' && !params.contentText?.trim()) {
    throw new QrSendError('Mensagem vazia', 400);
  }
  if (tipo !== 'text' && !params.mediaUrl) {
    throw new QrSendError('URL da mídia é obrigatória', 400);
  }

  const provider = requireQrProvider();

  let externalId: string;
  try {
    const resultado = await provider.sendMessage(conexao.instanceId, {
      to: destino,
      type: tipo,
      text: params.contentText ?? undefined,
      mediaUrl: params.mediaUrl ?? undefined,
      fileName: params.filename ?? undefined,
      caption: tipo === 'text' ? undefined : (params.contentText ?? undefined),
    });
    externalId = resultado.externalId;
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new QrSendError(err.message, err.status);
    }
    throw new QrSendError('Falha ao enviar a mensagem', 502);
  }

  // Reserva o id externo antes de gravar. O WAHA ecoa a mensagem
  // enviada de volta pelo webhook (`fromMe: true`); sem esta reserva
  // ela apareceria duas vezes na conversa.
  await db.from('provider_message_map').insert({
    connection_id: conexao.connectionId,
    external_id: externalId,
    account_id: accountId,
    direction: 'outbound',
  });

  const { data: mensagem, error } = await db
    .from('messages')
    .insert({
      conversation_id: params.conversationId,
      sender_type: 'agent',
      sender_id: userId,
      sent_by_user_id: userId,
      content_type: tipo,
      content_text: params.contentText ?? null,
      media_url: params.mediaUrl ?? null,
      message_id: externalId,
      status: 'sent',
    })
    .select('id')
    .single();

  if (error) {
    // A mensagem FOI entregue ao cliente. Não dá para desfazer, então
    // o erro precisa dizer isso com todas as letras em vez de sugerir
    // que o envio falhou.
    throw new QrSendError(
      'Mensagem enviada, mas não foi possível registrá-la no histórico',
      500
    );
  }

  await db
    .from('provider_message_map')
    .update({ message_id: mensagem.id })
    .eq('connection_id', conexao.connectionId)
    .eq('external_id', externalId);

  await db
    .from('conversations')
    .update({
      last_message_text: (params.contentText ?? `[${tipo}]`).slice(0, 500),
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.conversationId)
    .eq('account_id', accountId);

  return { messageId: mensagem.id, externalId };
}
