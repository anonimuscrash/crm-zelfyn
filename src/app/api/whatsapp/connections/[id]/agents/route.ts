import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';
import { ValidationError } from '@/lib/commerce/validation';

/**
 * Quem atende numa conexão.
 *
 * Lista VAZIA significa "todo mundo atende" — não "ninguém atende".
 * A segunda leitura deixaria a conexão inútil, e é o que o operador
 * NÃO quis dizer ao desmarcar todos.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

    const { data, error } = await ctx.supabase.rpc(
      'whatsapp_connection_agents',
      { p_connection_id: id }
    );

    if (error) throw new RepositoryError(error.message);
    return NextResponse.json({ agents: data ?? [] });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const body = (await readJsonBody(request)) as { user_ids?: unknown };

    if (!Array.isArray(body.user_ids)) {
      throw new ValidationError('user_ids deve ser uma lista', 'user_ids');
    }

    const ids = body.user_ids.filter(
      (u): u is string =>
        typeof u === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u)
    );

    const { error } = await ctx.supabase.rpc(
      'set_whatsapp_connection_agents',
      { p_connection_id: id, p_user_ids: ids }
    );

    if (error) throw new RepositoryError(error.message);
    return NextResponse.json({ ok: true, count: ids.length });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
