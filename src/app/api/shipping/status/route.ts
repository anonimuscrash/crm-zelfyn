import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';

/**
 * Estado da integração de frete para o VENDEDOR.
 *
 * Devolve só booleanos. A tabela `shipping_integrations` guarda o
 * token cifrado e é ilegível para quem não é master; esta rota passa
 * pela RPC `shipping_status`, que expõe exatamente o que a interface
 * precisa para decidir se mostra o painel de cotação — e nada além.
 */
export async function GET() {
  try {
    const ctx = await requireRole('viewer');

    const { data, error } = await ctx.supabase.rpc('shipping_status', {
      p_account_id: ctx.accountId,
    });

    if (error) throw new RepositoryError(error.message);

    const row = Array.isArray(data) ? data[0] : data;

    return NextResponse.json(
      row ?? {
        provider: 'superfrete',
        is_enabled: false,
        is_configured: false,
        has_origin: false,
        environment: 'sandbox',
      }
    );
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
