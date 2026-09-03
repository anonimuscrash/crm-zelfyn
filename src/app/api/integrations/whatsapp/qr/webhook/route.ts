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

      // Última tentativa de descobrir o telefone real.
      //
      // Quando nem o payload nem os campos de LID trouxeram número,
      // perguntamos ao serviço. Feito ANTES da ingestão de propósito:
      // o contato é criado uma vez só, e corrigi-lo depois exigiria
      // mesclar dois registros com históricos separados.
      //
      // Bloqueia o webhook por até 15s no pior caso, mas só na
      // primeira mensagem de um contato desconhecido.
      if (m.identifierOnly) {
        const real = await requireQrProvider()
          .resolvePhone(sessao, m.chatId)
          .catch(() => null);

        if (real) {
          m.phone = real;
          m.identifierOnly = false;
        } else {
          // Registra as CHAVES do payload, não o conteúdo.
          //
          // Se o telefone continuar não aparecendo, é aqui que se
          // descobre em qual campo ele está — sem precisar de mim e
          // sem gravar mensagem de cliente em log.
          await db.from('whatsapp_events').insert({
            account_id: conexao.account_id,
            connection_id: conexao.id,
            event_type: 'message.lid_unresolved',
            status: 'warning',
            payload: {
              chat_id: m.chatId,
              campos_do_payload: Object.keys(
                (payload as { payload?: Record<string, unknown> })?.payload ?? {}
              ),
              campos_em_data: Object.keys(
                ((payload as { payload?: { _data?: Record<string, unknown> } })
                  ?.payload?._data ?? {}) as Record<string, unknown>
              ),
            },
          });
        }
      }
      const { data: messageId, error: erroIngestao } = await db.rpc('ingest_whatsapp_message', {
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
      // A ingestão falhar não pode passar em silêncio.
      //
      // O `.rpc()` do supabase-js NÃO lança: devolve `{ data, error }`.
      // Antes só `data` era lido, então qualquer erro — assinatura da
      // função diferente da esperada, violação de restrição, tenant
      // errado — virava `messageId === undefined` e a mensagem
      // desaparecia sem deixar rastro. É o tipo de falha que se
      // manifesta como "recebi no celular e não apareceu no CRM".
      if (erroIngestao) {
        console.error('[waha] ingest_whatsapp_message falhou', {
          external_id: m.externalId,
          content_type: m.contentType,
          code: erroIngestao.code,
          message: erroIngestao.message,
        });
        await db.from('whatsapp_events').insert({
          account_id: conexao.account_id,
          connection_id: conexao.id,
          event_type: 'message.ingest_failed',
          status: 'error',
          payload: {
            external_id: m.externalId,
            content_type: m.contentType,
            from_me: m.fromMe,
            code: erroIngestao.code ?? null,
            message: erroIngestao.message ?? null,
          },
        });
      }

      // Mídia que chegou sem URL.
      //
      // O WAHA só preenche `media.url` quando o download de mídia
      // está habilitado na instalação. Sem isso a mensagem entra como
      // um balão vazio e ninguém sabe por quê. Registrar o caso é o
      // que transforma "a foto não aparece" em algo diagnosticável.
      if (
        messageId !== null &&
        m.contentType !== 'text' &&
        m.contentType !== 'location' &&
        !m.mediaUrl
      ) {
        await db.from('whatsapp_events').insert({
          account_id: conexao.account_id,
          connection_id: conexao.id,
          event_type: 'message.media_without_url',
          status: 'warning',
          payload: {
            external_id: m.externalId,
            content_type: m.contentType,
            from_me: m.fromMe,
            dica:
              'WAHA entregou a mensagem sem media.url — verifique se o ' +
              'download de mídia está habilitado na instalação.',
          },
        });
      }

      // Foto de perfil do contato.
      //
      // A busca do contato agora é feita por RPC, com a MESMA
      // normalização de telefone que a ingestão usa. A versão anterior
      // filtrava com `phone LIKE '%<8 dígitos>'` contra a coluna crua,
      // enquanto a ingestão compara contra `normalize_phone(phone)` —
      // um contato gravado como "+55 11 99999-8888" nunca casava, e o
      // avatar nunca era gravado.
      //
      // Sem `await` no fluxo principal: o webhook precisa responder
      // rápido ou o WAHA reentrega. Falhar aqui não pode custar a
      // mensagem.
      if (messageId !== null && !m.fromMe && !m.identifierOnly) {
        void (async () => {
          try {
            const { data: precisa } = await db.rpc('contact_avatar_missing', {
              p_account_id: conexao.account_id,
              p_phone: m.phone,
            });
            if (precisa !== true) return;

            const foto = await requireQrProvider().getProfilePicture(
              sessao,
              m.chatId
            );
            if (!foto) return;

            await db.rpc('set_contact_avatar_by_phone', {
              p_account_id: conexao.account_id,
              p_phone: m.phone,
              p_avatar_url: foto,
            });
          } catch (err) {
            // Avatar é enfeite e não pode derrubar a ingestão, mas o
            // `catch {}` mudo da versão anterior foi justamente o que
            // escondeu esse bug por tanto tempo.
            console.warn('[waha] avatar não gravado', {
              phone: m.phone.slice(-4),
              erro: err instanceof Error ? err.message : String(err),
            });
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
