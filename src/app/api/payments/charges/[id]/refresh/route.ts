import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';
import { decrypt } from '@/lib/whatsapp/encryption';
import { DotfyProvider, PaymentError } from '@/services/payments/dotfy';

/**
 * Consulta o status de uma cobrança direto na Dotfy.
 *
 * Existe para quem NÃO usa confirmação automática. Sem webhook, a
 * cobrança ficaria "aguardando pagamento" para sempre no nosso banco
 * mesmo depois de paga — o operador precisa de um jeito de perguntar.
 *
 * Também serve de rede para quem usa webhook: se um evento se perder,
 * isto reconcilia sem esperar intervenção.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;

    const { data: cobranca } = await ctx.supabase
      .from('payment_charges')
      .select('id, correlation_id, status')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (!cobranca) {
      throw new RepositoryError('Cobrança não encontrada', 404);
    }

    // Já paga: não há o que consultar, e uma chamada a mais ao
    // gateway não muda nada.
    if (cobranca.status === 'paid') {
      return NextResponse.json({ status: 'paid', changed: false });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      throw new RepositoryError('Servidor não configurado', 503);
    }

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    const { data: config } = await admin
      .from('payment_integrations')
      .select('encrypted_api_key, base_url')
      .eq('account_id', ctx.accountId)
      .eq('provider', 'dotfy')
      .maybeSingle();

    if (!config?.encrypted_api_key) {
      throw new PaymentError('Integração não configurada', 400);
    }

    const remoto = await new DotfyProvider(
      decrypt(config.encrypted_api_key),
      config.base_url
    ).getCharge(cobranca.correlation_id);

    if (remoto.status === 'PAID') {
      // Mesma função do webhook: idempotente, e a única autorizada a
      // marcar como pago. Duplicar a lógica aqui criaria dois
      // caminhos que poderiam divergir.
      await admin.rpc('confirm_payment', {
        p_account_id: ctx.accountId,
        p_correlation_id: cobranca.correlation_id,
        p_paid_at: remoto.paidAt ?? new Date().toISOString(),
      });

      return NextResponse.json({ status: 'paid', changed: true });
    }

    if (remoto.status === 'EXPIRED') {
      await admin
        .from('payment_charges')
        .update({ status: 'expired' })
        .eq('id', cobranca.id)
        .eq('status', 'pending');

      return NextResponse.json({ status: 'expired', changed: true });
    }

    return NextResponse.json({ status: 'pending', changed: false });
  } catch (err) {
    if (err instanceof PaymentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return commerceErrorResponse(err);
  }
}
