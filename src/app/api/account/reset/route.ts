import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';
import { ValidationError } from '@/lib/commerce/validation';

/**
 * Limpeza de dados operacionais da conta.
 *
 * A verificação de master e o escopo por conta vivem na RPC, não
 * aqui — esta rota pode ser reescrita, a função do banco continua
 * recusando. O que a rota acrescenta é a confirmação digitada, que é
 * assunto de interface.
 */

/** Prévia: o que existe hoje. */
export async function GET() {
  try {
    const ctx = await requireRole('admin');

    const { data, error } = await ctx.supabase.rpc('account_data_summary', {
      p_account_id: ctx.accountId,
    });

    if (error) throw new RepositoryError(error.message);

    const row = Array.isArray(data) ? data[0] : data;
    return NextResponse.json(row ?? {});
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await readJsonBody(request)) as Record<string, unknown>;

    // Confirmação digitada.
    //
    // Um clique em "Apagar" é rápido demais para uma operação sem
    // desfazer. Digitar a palavra obriga a parar e ler o que está
    // prestes a acontecer — é o custo cognitivo certo aqui.
    if (String(body.confirmation ?? '').trim().toUpperCase() !== 'APAGAR') {
      throw new ValidationError(
        'Digite APAGAR para confirmar',
        'confirmation'
      );
    }

    const escopos = {
      p_conversations: Boolean(body.conversations),
      p_orders: Boolean(body.orders),
      p_contacts: Boolean(body.contacts),
      p_expenses: Boolean(body.expenses),
      p_lid_contacts_only: Boolean(body.lid_contacts_only),
    };

    if (!Object.values(escopos).some(Boolean)) {
      throw new ValidationError('Selecione ao menos um item para apagar');
    }

    const { data, error } = await ctx.supabase.rpc('reset_account_data', {
      p_account_id: ctx.accountId,
      ...escopos,
    });

    if (error) throw new RepositoryError(error.message);

    const row = Array.isArray(data) ? data[0] : data;
    return NextResponse.json(row ?? {});
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
