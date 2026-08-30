import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  commerceErrorResponse,
  intParam,
  readJsonBody,
} from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';
import { requiredCents, ValidationError } from '@/lib/commerce/validation';
import { decrypt } from '@/lib/whatsapp/encryption';
import { DotfyProvider, PaymentError } from '@/services/payments/dotfy';

const COLUNAS =
  'id, correlation_id, amount_cents, status, description, qr_code, qr_code_image, payment_link, expires_at, paid_at, created_at, contact_id, order_id';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const params = new URL(request.url).searchParams;

    let query = ctx.supabase
      .from('payment_charges')
      .select(COLUNAS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(intParam(params, 'limit', 20, { max: 100 }));

    const contactId = params.get('contactId');
    if (contactId) query = query.eq('contact_id', contactId);

    const { data, error } = await query;
    if (error) throw new RepositoryError(error.message);

    return NextResponse.json({ charges: data ?? [] });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

/**
 * Gera uma cobrança PIX na Dotfy.
 *
 * ORDEM: cria na Dotfy primeiro, grava depois.
 *
 * O inverso deixaria uma cobrança "pendente" no banco que não existe
 * no gateway — e ela apareceria na Inbox como se o cliente pudesse
 * pagar. O contrário (existir lá e não aqui) é recuperável: o
 * webhook chega, não acha a linha, e devolve 200 sem estragar nada.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await readJsonBody(request)) as Record<string, unknown>;

    const valor = requiredCents(body.amount_cents, 'amount_cents');
    if (valor <= 0) {
      throw new ValidationError('Valor deve ser maior que zero', 'amount_cents');
    }

    // Credenciais lidas com service role: a RLS de
    // `payment_integrations` restringe a master, e cobrar é operação
    // de vendedor. O account_id vem do CONTEXTO AUTENTICADO, nunca do
    // corpo — é o que impede cobrar usando a chave de outro
    // workspace.
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
      .select('is_enabled, encrypted_api_key, default_expires_in')
      .eq('account_id', ctx.accountId)
      .eq('provider', 'dotfy')
      .maybeSingle();

    if (!config?.is_enabled || !config.encrypted_api_key) {
      throw new PaymentError(
        'A cobrança automática não está configurada nesta conta',
        400
      );
    }

    // Dados do cliente, quando a cobrança nasce de uma conversa.
    let contato: {
      id: string;
      name: string | null;
      phone: string | null;
      email: string | null;
    } | null = null;

    if (typeof body.contact_id === 'string' && body.contact_id) {
      const { data } = await ctx.supabase
        .from('contacts')
        .select('id, name, phone, email')
        .eq('id', body.contact_id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();

      if (!data) {
        throw new ValidationError('Contato não encontrado', 'contact_id');
      }
      contato = data;
    }

    const provider = new DotfyProvider(decrypt(config.encrypted_api_key));

    const origem = new URL(request.url).origin;

    const cobranca = await provider.createCharge({
      amountCents: valor,
      description:
        typeof body.description === 'string' ? body.description : null,
      expiresIn: Number(config.default_expires_in) || 3600,
      customer: contato
        ? {
            name: contato.name,
            phone: contato.phone,
            email: contato.email,
          }
        : undefined,
      webhookUrl: `${origem}/api/integrations/dotfy/webhook`,
    });

    const { data: linha, error } = await ctx.supabase
      .from('payment_charges')
      .insert({
        account_id: ctx.accountId,
        order_id: (body.order_id as string) ?? null,
        contact_id: contato?.id ?? null,
        conversation_id: (body.conversation_id as string) ?? null,
        created_by_user_id: ctx.userId,
        correlation_id: cobranca.correlationId,
        external_id: cobranca.externalId,
        amount_cents: cobranca.amountCents,
        description:
          typeof body.description === 'string' ? body.description : null,
        qr_code: cobranca.qrCode,
        qr_code_image: cobranca.qrCodeImage,
        payment_link: cobranca.paymentLink,
        expires_at: cobranca.expiresAt,
      })
      .select(COLUNAS)
      .single();

    if (error) {
      // A cobrança EXISTE na Dotfy. Dizer que falhou faria o operador
      // gerar outra, e o cliente receberia dois QR codes.
      throw new RepositoryError(
        `Cobrança criada (${cobranca.correlationId}), mas não foi possível registrá-la. Consulte o painel da Dotfy antes de gerar outra.`,
        500
      );
    }

    await ctx.supabase.rpc('write_audit_log', {
      p_account_id: ctx.accountId,
      p_action: 'payments.charge_created',
      p_entity_type: 'payment_charge',
      p_entity_id: linha.id,
      p_metadata: {
        amount_cents: valor,
        correlation_id: cobranca.correlationId,
      },
    });

    return NextResponse.json(linha, { status: 201 });
  } catch (err) {
    if (err instanceof PaymentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return commerceErrorResponse(err);
  }
}
