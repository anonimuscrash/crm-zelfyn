import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';

/**
 * Estado dos pagamentos para o VENDEDOR.
 *
 * Booleanos e contagem. A tabela `payment_integrations` carrega
 * credenciais cifradas e é ilegível para quem não é master; esta
 * rota passa pela RPC, que devolve só o necessário para a interface
 * decidir o que mostrar.
 */
export async function GET() {
  try {
    const ctx = await requireRole('viewer');

    const { data, error } = await ctx.supabase.rpc('payment_status', {
      p_account_id: ctx.accountId,
    });

    if (error) throw new RepositoryError(error.message);

    const row = Array.isArray(data) ? data[0] : data;

    return NextResponse.json(
      row ?? {
        dotfy_enabled: false,
        dotfy_configured: false,
        environment: 'sandbox',
        pix_key_count: 0,
      }
    );
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
