import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';
import { ValidationError } from '@/lib/commerce/validation';
import { instanceIdFor, requireQrProvider } from '@/services/whatsapp';

const COLUNAS =
  'id, account_id, provider, name, phone_number, display_name, status, status_detail, instance_identifier, qr_issued_at, last_connected_at, last_seen_at';

/**
 * Carrega a conexão garantindo que pertence à conta do chamador.
 *
 * O filtro por `account_id` é redundante com a RLS — e proposital.
 * A RLS é a barreira; este filtro é o que sobrevive se alguém
 * amanhã trocar o cliente por um de service role numa rotina de
 * manutenção.
 */
async function carregar(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  id: string
) {
  const { data, error } = await supabase
    .from('whatsapp_connections')
    .select(COLUNAS)
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();

  if (error) throw new RepositoryError(error.message);
  if (!data) throw new RepositoryError('Conexão não encontrada', 404);
  return data;
}

/** Estado da sessão + QR quando houver. É o que a tela consulta em loop. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await params;
    const conexao = await carregar(ctx.supabase, ctx.accountId, id);

    if (conexao.provider !== 'qr') {
      return NextResponse.json({ connection: conexao, qr: null });
    }

    const provider = requireQrProvider();
    const instancia = conexao.instance_identifier ?? instanceIdFor(conexao.id);

    const estado = await provider.getState(instancia);
    const qr =
      estado.status === 'qr_required'
        ? await provider.getQr(instancia)
        : null;

    // Espelha o estado do serviço no banco. A tela lê do banco em
    // outros pontos (sidebar, Inbox) e não deve ver um status
    // diferente do que esta consulta acabou de apurar.
    const mudou =
      estado.status !== conexao.status ||
      (estado.phoneNumber ?? null) !== conexao.phone_number;

    if (mudou) {
      await ctx.supabase
        .from('whatsapp_connections')
        .update({
          status: estado.status,
          status_detail: estado.detail ?? null,
          phone_number: estado.phoneNumber ?? conexao.phone_number,
          display_name: estado.displayName ?? conexao.display_name,
          ...(estado.status === 'connected'
            ? { last_connected_at: new Date().toISOString() }
            : {}),
          ...(qr ? { qr_issued_at: new Date().toISOString() } : {}),
        })
        .eq('id', conexao.id)
        .eq('account_id', ctx.accountId);
    }

    return NextResponse.json({
      connection: {
        ...conexao,
        status: estado.status,
        status_detail: estado.detail ?? null,
        phone_number: estado.phoneNumber ?? conexao.phone_number,
        display_name: estado.displayName ?? conexao.display_name,
        // `instance_identifier` é interno; a tela não precisa e o
        // briefing pede explicitamente para não expor (§3).
        instance_identifier: undefined,
      },
      qr,
    });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

/**
 * Ações de sessão: `connect`, `disconnect`, `restart`.
 * Só master (§6).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const body = (await readJsonBody(request)) as {
      action?: unknown;
      name?: unknown;
    };

    const conexao = await carregar(ctx.supabase, ctx.accountId, id);

    // Renomear não mexe na sessão.
    if (typeof body.name === 'string' && body.name.trim()) {
      await ctx.supabase
        .from('whatsapp_connections')
        .update({ name: body.name.trim().slice(0, 60) })
        .eq('id', id)
        .eq('account_id', ctx.accountId);
      return NextResponse.json({ ok: true });
    }

    if (
      body.action !== 'connect' &&
      body.action !== 'disconnect' &&
      body.action !== 'restart'
    ) {
      throw new ValidationError(
        "action deve ser 'connect', 'disconnect' ou 'restart'",
        'action'
      );
    }

    if (conexao.provider !== 'qr') {
      throw new ValidationError(
        'Esta conexão usa a API oficial e não é gerenciada por QR'
      );
    }

    const provider = requireQrProvider();
    const instancia = conexao.instance_identifier ?? instanceIdFor(conexao.id);

    if (body.action === 'disconnect') {
      await provider.logout(instancia);
      await ctx.supabase
        .from('whatsapp_connections')
        .update({ status: 'disconnected', status_detail: null })
        .eq('id', id)
        .eq('account_id', ctx.accountId);
    } else {
      // `connect` e `restart` são a mesma operação: createSession é
      // idempotente e reinicia uma sessão parada.
      await provider.createSession(instancia);
      await ctx.supabase
        .from('whatsapp_connections')
        .update({
          status: 'connecting',
          status_detail: null,
          instance_identifier: instancia,
        })
        .eq('id', id)
        .eq('account_id', ctx.accountId);
    }

    await ctx.supabase.from('whatsapp_events').insert({
      account_id: ctx.accountId,
      connection_id: id,
      event_type: `session.${body.action}`,
      status: body.action === 'disconnect' ? 'disconnected' : 'connecting',
    });

    await ctx.supabase.rpc('write_audit_log', {
      p_account_id: ctx.accountId,
      p_action: `whatsapp.${body.action}`,
      p_entity_type: 'whatsapp_connection',
      p_entity_id: id,
      p_metadata: {},
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

/**
 * Remove a conexão.
 *
 * Conversas, contatos, pedidos e histórico permanecem (§20): a
 * coluna `conversations.whatsapp_connection_id` é ON DELETE SET
 * NULL. Só a sincronização futura para.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const conexao = await carregar(ctx.supabase, ctx.accountId, id);

    if (conexao.provider === 'qr' && conexao.instance_identifier) {
      // Remover a sessão no serviço é "melhor esforço": se ele
      // estiver fora do ar, o master ainda precisa conseguir apagar
      // a conexão do painel dele.
      await requireQrProvider()
        .deleteSession(conexao.instance_identifier)
        .catch(() => undefined);
    }

    const { error } = await ctx.supabase
      .from('whatsapp_connections')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId);

    if (error) throw new RepositoryError(error.message);

    await ctx.supabase.rpc('write_audit_log', {
      p_account_id: ctx.accountId,
      p_action: 'whatsapp.connection_removed',
      p_entity_type: 'whatsapp_connection',
      p_entity_id: id,
      p_metadata: { name: conexao.name },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
