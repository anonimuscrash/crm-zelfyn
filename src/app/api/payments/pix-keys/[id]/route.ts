import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const body = (await readJsonBody(request)) as Record<string, unknown>;

    if (body.is_default === true) {
      await ctx.supabase
        .from('pix_keys')
        .update({ is_default: false })
        .eq('account_id', ctx.accountId)
        .eq('is_default', true);
    }

    const patch: Record<string, unknown> = {};
    if ('is_default' in body) patch.is_default = Boolean(body.is_default);
    if ('label' in body) {
      patch.label = String(body.label ?? '').trim().slice(0, 60);
    }
    if ('holder_name' in body) {
      patch.holder_name = String(body.holder_name ?? '').trim() || null;
    }

    const { error } = await ctx.supabase
      .from('pix_keys')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId);

    if (error) throw new RepositoryError(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

/**
 * Desativa em vez de apagar.
 *
 * Uma chave removida pode ter sido enviada a clientes que ainda vão
 * pagar. Manter a linha preserva o rastro de qual chave estava em
 * uso quando — informação que some para sempre num DELETE.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

    const { error } = await ctx.supabase
      .from('pix_keys')
      .update({ is_active: false, is_default: false })
      .eq('id', id)
      .eq('account_id', ctx.accountId);

    if (error) throw new RepositoryError(error.message);

    await ctx.supabase.rpc('write_audit_log', {
      p_account_id: ctx.accountId,
      p_action: 'payments.pix_key_removed',
      p_entity_type: 'pix_key',
      p_entity_id: id,
      p_metadata: {},
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
