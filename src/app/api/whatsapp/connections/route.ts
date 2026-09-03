import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { ValidationError } from '@/lib/commerce/validation';
import { RepositoryError } from '@/lib/commerce/products.repo';
import {
  instanceIdFor,
  qrModeAvailable,
  requireQrProvider,
} from '@/services/whatsapp';

/**
 * GET  — conexões que o usuário atual pode usar.
 * POST — cria uma conexão (só master).
 *
 * A listagem passa pela RPC `whatsapp_connections_for_user`, que já
 * aplica o recorte de vendedor e NÃO seleciona
 * `encrypted_credentials`. Consultar a tabela direto daqui
 * arriscaria trazer a coluna por descuido num `select('*')` futuro.
 */
export async function GET() {
  try {
    const ctx = await requireRole('viewer');

    const { data, error } = await ctx.supabase.rpc(
      'whatsapp_connections_for_user',
      { p_account_id: ctx.accountId }
    );

    if (error) throw new RepositoryError(error.message);

    // Uso e teto, para a tela mostrar "2 de 3" e desabilitar o
    // botão antes de o operador tentar e receber erro.
    const { data: uso } = await ctx.supabase.rpc(
      'whatsapp_connection_usage',
      { p_account_id: ctx.accountId }
    );
    const limite = Array.isArray(uso) ? uso[0] : uso;

    return NextResponse.json({
      connections: data ?? [],
      usage: limite ?? { used: 0, allowed: 3, plan: 'free' },
      // A tela precisa saber se o modo QR existe nesta instalação
      // para não oferecer um botão que vai falhar.
      qrAvailable: qrModeAvailable(),
    });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await readJsonBody(request)) as {
      name?: unknown;
      provider?: unknown;
    };

    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new ValidationError('Nome da conexão é obrigatório', 'name');
    }
    if (body.name.trim().length > 60) {
      throw new ValidationError('Nome da conexão é muito longo', 'name');
    }
    if (body.provider !== 'qr' && body.provider !== 'meta_cloud') {
      throw new ValidationError(
        "provider deve ser 'qr' ou 'meta_cloud'",
        'provider'
      );
    }

    // Falha cedo: criar a linha e só descobrir na hora de parear que
    // o serviço não existe deixaria uma conexão órfã na tela.
    if (body.provider === 'qr') requireQrProvider();

    // Limite do plano. A trigger do banco é a garantia real; esta
    // checagem existe para a mensagem dizer o número em vez de
    // devolver o erro cru do Postgres.
    const { data: usoAtual } = await ctx.supabase.rpc(
      'whatsapp_connection_usage',
      { p_account_id: ctx.accountId }
    );
    const uso = Array.isArray(usoAtual) ? usoAtual[0] : usoAtual;

    if (uso && uso.used >= uso.allowed) {
      throw new ValidationError(
        `Limite de ${uso.allowed} conexões atingido neste plano.`
      );
    }

    const { data, error } = await ctx.supabase
      .from('whatsapp_connections')
      .insert({
        account_id: ctx.accountId,
        provider: body.provider,
        name: body.name.trim(),
        created_by_user_id: ctx.userId,
        status: 'disconnected',
      })
      .select('id, provider, name, status')
      .single();

    if (error) throw new RepositoryError(error.message);

    // O identificador da sessão é derivado do id recém-criado, então
    // só pode ser gravado depois do insert.
    await ctx.supabase
      .from('whatsapp_connections')
      .update({ instance_identifier: instanceIdFor(data.id) })
      .eq('id', data.id)
      .eq('account_id', ctx.accountId);

    await ctx.supabase.rpc('write_audit_log', {
      p_account_id: ctx.accountId,
      p_action: 'whatsapp.connection_created',
      p_entity_type: 'whatsapp_connection',
      p_entity_id: data.id,
      p_metadata: { provider: body.provider, name: body.name.trim() },
    });

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
