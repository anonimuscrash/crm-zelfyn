import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { requireQrProvider } from '@/services/whatsapp';
import { verifyWebhookSignature } from '@/services/whatsapp/webhook-auth';

/**
 * Webhook do serviço QR (§27).
 *
 * SUPERFÍCIE PÚBLICA E NÃO AUTENTICADA POR SESSÃO. Grava mensagens
 * no banco de um cliente a partir de um POST vindo de fora, então
 * três coisas são inegociáveis:
 *
 *   1. HMAC sobre o corpo CRU antes de qualquer parse;
 *   2. a conexão é resolvida pelo `instance_identifier` do payload —
 *      nunca por um account_id que o chamador tenha enviado;
 *   3. a escrita passa por `ingest_whatsapp_message`, que deduplica
 *      e é o único ponto com service role.
 *
 * Responde 200 mesmo para evento ignorado ou já processado: o WAHA
 * reentrega tudo que não recebe 2xx, e reentregar algo já gravado é
 * justamente o que estamos evitando.
 */
export async function POST(request: Request) {
  const segredo = process.env.WAHA_WEBHOOK_SECRET;

  if (!segredo) {
    // Sem segredo configurado o endpoint fica fechado. Aceitar
    // qualquer coisa "porque ainda não configuraram" seria deixar a
    // porta aberta exatamente enquanto ninguém está olhando.
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  // Corpo cru: reserializar o JSON reordena chaves e a assinatura
  // deixa de bater por um motivo indepurável.
  const raw = await request.text();
  const assinatura =
    request.headers.get('x-webhook-hmac') ??
    request.headers.get('x-hub-signature-256');

  if (!verifyWebhookSignature(raw, assinatura, segredo)) {
    // Log no servidor. Uma assinatura recusada em silêncio produz o
    // pior sintoma possível: sessão conectada, webhook registrado e
    // nenhuma mensagem chegando, sem nada para investigar.
    console.warn('[whatsapp-webhook] assinatura recusada', {
      temAssinatura: Boolean(assinatura),
      tamanhoCorpo: raw.length,
    });
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const sessao = (payload as { session?: unknown })?.session;
  if (typeof sessao !== 'string' || !sessao) {
    return NextResponse.json({ ok: true, ignored: 'sem sessão' });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  // A conexão vem do identificador da sessão, que o servidor gerou.
  // É isto que amarra o evento ao workspace certo — e o motivo de o
  // payload não poder escolher account_id.
  const { data: conexao } = await db
    .from('whatsapp_connections')
    .select('id, account_id, status')
    .eq('instance_identifier', sessao)
    .maybeSingle();

  if (!conexao) {
    // Sessão órfã: existe no WAHA mas não em `whatsapp_connections`.
    // Acontece quando a conexão é removida na Operza e a sessão
    // sobrevive no serviço.
    //
    // Antes isso era descartado em silêncio. O sintoma era o pior
    // possível: mensagens sumindo sem nenhum registro, com a
    // sessão aparentemente saudável.
    console.warn('[whatsapp-webhook] sessão desconhecida', { sessao });
    return NextResponse.json({ ok: true, ignored: 'sessão desconhecida' });
  }

  const evento = requireQrProvider().parseWebhook(payload);

  try {
    if (evento.kind === 'status') {
      await db
        .from('whatsapp_connections')
        .update({
          status: evento.state.status,
          status_detail: evento.state.detail ?? null,
          ...(evento.state.status === 'connected'
            ? { last_connected_at: new Date().toISOString() }
            : {}),
        })
        .eq('id', conexao.id);

      await db.from('whatsapp_events').insert({
        account_id: conexao.account_id,
        connection_id: conexao.id,
        event_type: 'session.status',
        status: evento.state.status,
        // Sem token, sem chave de sessão, sem conteúdo de mensagem.
        payload: { detail: evento.state.detail ?? null },
      });

      return NextResponse.json({ ok: true });
    }

    if (evento.kind === 'message') {
      const m = evento.message;
      const { data: messageId } = await db.rpc('ingest_whatsapp_message', {
        p_connection_id: conexao.id,
        p_external_id: m.externalId,
        p_phone: m.phone,
        p_push_name: m.pushName ?? null,
        p_content_type: m.contentType,
        p_content_text: m.text ?? null,
        p_media_url: m.mediaUrl ?? null,
        p_from_me: m.fromMe,
        p_timestamp: m.timestamp,
        // Identificador completo, com sufixo. Sem ele o envio precisa
        // adivinhar entre @c.us e @lid, e adivinhar errado produz uma
        // mensagem aceita pelo provedor que não chega a ninguém.
        p_chat_id: m.chatId,
      });

      // Foto de perfil.
      //
      // Só na PRIMEIRA mensagem de um contato (quando a ingestão
      // devolveu id, ou seja, não era duplicata) e só se ele ainda
      // não tiver avatar. Buscar a cada mensagem seria uma chamada
      // extra ao serviço por mensagem recebida, para um dado que
      // muda raramente.
      //
      // Sem `await` no fluxo principal: o webhook precisa responder
      // rápido ou o WAHA reentrega. Falhar aqui não pode custar a
      // mensagem.
      if (messageId !== null && !m.fromMe) {
        void (async () => {
          try {
            const { data: contato } = await db
              .from('conversations')
              .select('contact:contacts(id, avatar_url)')
              .eq('id', (await db
                .from('messages')
                .select('conversation_id')
                .eq('id', messageId)
                .maybeSingle()).data?.conversation_id ?? '')
              .maybeSingle();

            const c = Array.isArray(contato?.contact)
              ? contato?.contact[0]
              : contato?.contact;

            if (!c?.id || c.avatar_url) return;

            const foto = await requireQrProvider().getProfilePicture(
              sessao,
              m.chatId
            );
            if (!foto) return;

            await db
              .from('contacts')
              .update({ avatar_url: foto })
              .eq('id', c.id);
          } catch {
            // Avatar é enfeite; silêncio aqui é aceitável.
          }
        })();
      }

      // `null` = já processada. Não é erro, mas registrar o primeiro
      // evento de mensagem ajuda a confirmar que a ingestão está
      // viva quando alguém for investigar.
      if (messageId !== null) {
        await db.from('whatsapp_events').insert({
          account_id: conexao.account_id,
          connection_id: conexao.id,
          event_type: 'message.ingested',
          status: 'ok',
          // Sem conteúdo de mensagem: quem lê log de conexão está
          // diagnosticando infraestrutura, não precisa ver o que o
          // cliente escreveu.
          payload: {
            direction: m.fromMe ? 'outbound' : 'inbound',
            contentType: m.contentType,
            identifierOnly: Boolean(m.identifierOnly),
          },
        });
      }

      return NextResponse.json({ ok: true, duplicate: messageId === null });
    }

    // Todo descarte deixa rastro. Um evento que some sem registro é
    // indepurável: não dá para distinguir "não chegou" de "chegou e
    // foi ignorado", e as duas causas têm consertos opostos.
    await db.from('whatsapp_events').insert({
      account_id: conexao.account_id,
      connection_id: conexao.id,
      event_type: 'webhook.ignored',
      status: 'ignored',
      payload: { reason: evento.reason },
    });

    return NextResponse.json({ ok: true, ignored: evento.reason });
  } catch (err) {
    // Log técnico no servidor; resposta sem stack trace (§43).
    console.error('[whatsapp-webhook]', {
      connection: conexao.id,
      error: err instanceof Error ? err.message : 'erro desconhecido',
    });

    await db.from('whatsapp_events').insert({
      account_id: conexao.account_id,
      connection_id: conexao.id,
      event_type: 'webhook.failure',
      status: 'failed',
      payload: {
        message: err instanceof Error ? err.message.slice(0, 300) : 'erro',
      },
    });

    // 500 faz o WAHA reentregar — que é o comportamento certo para
    // uma falha transitória de banco.
    return NextResponse.json({ error: 'processing failed' }, { status: 500 });
  }
}
