import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyDotfySignature } from '@/services/payments/dotfy';

/**
 * Webhook da Dotfy.
 *
 * SUPERFÍCIE PÚBLICA QUE MARCA PAGAMENTO COMO RECEBIDO. É a mais
 * sensível do sistema: um POST forjado aqui faz um pedido constar
 * como pago sem dinheiro nenhum ter entrado.
 *
 * Quatro travas:
 *
 *   1. HMAC-SHA256 sobre `timestamp + "." + corpo cru`, no formato
 *      documentado `t=...,v1=...`;
 *   2. janela de 5 minutos — sem ela, uma assinatura capturada
 *      valeria para sempre;
 *   3. a cobrança é encontrada por `correlationID`, que a Dotfy
 *      gerou; o corpo não escolhe conta;
 *   4. `confirm_payment` é idempotente e a única função autorizada a
 *      mudar o status.
 *
 * Como cada conta tem seu próprio segredo, e o corpo não diz de qual
 * conta é, procuramos a cobrança primeiro e validamos a assinatura
 * com o segredo DELA.
 */
export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  // Corpo cru: reserializar o JSON reordena chaves e a assinatura
  // deixa de bater por um motivo indepurável.
  const raw = await request.text();
  const assinatura = request.headers.get('x-webhook-signature');

  let payload: {
    event?: string;
    data?: {
      correlationId?: string;
      correlationID?: string;
      externalId?: string;
      id?: string;
      status?: string;
      paidAt?: string | null;
    };
  };

  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const correlationId =
    payload.data?.correlationId ?? payload.data?.correlationID ?? null;

  if (!correlationId) {
    // Sem id de conciliação não há o que fazer. 200 para a Dotfy não
    // reentregar indefinidamente algo que nunca vamos processar.
    return NextResponse.json({ ok: true, ignored: 'sem correlationID' });
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: cobranca } = await db
    .from('payment_charges')
    .select('id, account_id, status')
    .eq('correlation_id', correlationId)
    .maybeSingle();

  if (!cobranca) {
    console.warn('[dotfy-webhook] cobrança desconhecida', { correlationId });
    return NextResponse.json({ ok: true, ignored: 'cobrança desconhecida' });
  }

  const { data: config } = await db
    .from('payment_integrations')
    .select('encrypted_webhook_secret, webhook_enabled')
    .eq('account_id', cobranca.account_id)
    .eq('provider', 'dotfy')
    .maybeSingle();

  // Confirmação automática desligada: a conta escolheu conferir
  // manualmente. Responde 200 para a Dotfy não reentregar
  // indefinidamente um evento que nunca vamos processar.
  if (!config?.webhook_enabled) {
    return NextResponse.json({ ok: true, ignored: 'webhook desativado' });
  }

  if (!config.encrypted_webhook_secret) {
    // Confirmação LIGADA mas sem segredo: aí é configuração pela
    // metade, e aceitar sem verificar deixaria qualquer POST marcar
    // pagamentos como recebidos.
    console.warn('[dotfy-webhook] confirmação ligada sem segredo', {
      account: cobranca.account_id,
    });
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  const segredo = decrypt(config.encrypted_webhook_secret);

  if (!verifyDotfySignature(raw, assinatura, segredo)) {
    console.warn('[dotfy-webhook] assinatura recusada', {
      correlationId,
      temAssinatura: Boolean(assinatura),
    });
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  const evento = payload.event ?? '';
  const status = String(payload.data?.status ?? '').toUpperCase();

  try {
    if (evento === 'EVENT:CHARGE_PAID' || status === 'PAID') {
      const { data: confirmada } = await db.rpc('confirm_payment', {
        p_account_id: cobranca.account_id,
        p_correlation_id: correlationId,
        p_paid_at: payload.data?.paidAt ?? new Date().toISOString(),
      });

      await db.from('audit_logs').insert({
        account_id: cobranca.account_id,
        action: 'payments.charge_paid',
        entity_type: 'payment_charge',
        entity_id: cobranca.id,
        // Sem dados do pagador: o webhook traz nome e CPF mascarados,
        // e log de auditoria não é lugar para eles.
        metadata: { correlation_id: correlationId },
      });

      return NextResponse.json({
        ok: true,
        // `already` quando a cobrança já estava paga — a Dotfy
        // reentrega, e reprocessar moveria o pedido de status de novo.
        already: cobranca.status === 'paid',
        confirmed: confirmada !== null,
      });
    }

    if (evento === 'EVENT:CHARGE_EXPIRED' || status === 'EXPIRED') {
      // Só expira o que ainda está pendente: uma cobrança paga que
      // recebe evento de expiração atrasado não pode ser desfeita.
      await db
        .from('payment_charges')
        .update({ status: 'expired' })
        .eq('id', cobranca.id)
        .eq('status', 'pending');

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true, ignored: evento });
  } catch (err) {
    console.error('[dotfy-webhook]', {
      correlationId,
      error: err instanceof Error ? err.message : 'erro desconhecido',
    });
    // 500 faz a Dotfy reentregar — comportamento certo para falha
    // transitória de banco.
    return NextResponse.json({ error: 'processing failed' }, { status: 500 });
  }
}
