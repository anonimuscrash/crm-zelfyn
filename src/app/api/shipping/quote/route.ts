import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';
import { ValidationError } from '@/lib/commerce/validation';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  buildShippingMessage,
  isValidPostalCode,
  normalizePostalCode,
  ShippingError,
  SuperFreteProvider,
  type ShippingEnvironment,
} from '@/services/shipping/superfrete';

/**
 * Cotação de frete.
 *
 * Acessível ao VENDEDOR (`agent`), não só ao master: cotar é parte
 * do atendimento. Mas a credencial é lida no servidor e nunca chega
 * ao navegador dele — é a mesma postura da integração de WhatsApp,
 * onde o vendedor usa a conexão sem ver o token (§27 do briefing
 * anterior).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await readJsonBody(request)) as Record<string, unknown>;

    const destino = normalizePostalCode(String(body.postal_code ?? ''));
    if (!isValidPostalCode(destino)) {
      throw new ValidationError('CEP do cliente deve ter 8 dígitos', 'postal_code');
    }

    // Cliente com service role NÃO é usado aqui: a RLS de
    // `shipping_integrations` já restringe a leitura ao master, e
    // esta rota roda com o contexto do usuário. Como o vendedor não
    // pode ler a tabela, a busca precisa passar pela RPC... mas a
    // RPC não devolve o token. Então lemos com o cliente do próprio
    // servidor, que carrega a service key apenas nesta função.
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      throw new RepositoryError('Servidor não configurado', 503);
    }

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    // O account_id vem do CONTEXTO AUTENTICADO, nunca do corpo da
    // requisição. É o que impede um vendedor de cotar usando a
    // credencial de outro workspace.
    const { data: config } = await admin
      .from('shipping_integrations')
      .select(
        'is_enabled, environment, encrypted_token, contact_email, origin_postal_code, default_height_cm, default_width_cm, default_length_cm, default_weight_kg, services'
      )
      .eq('account_id', ctx.accountId)
      .eq('provider', 'superfrete')
      .maybeSingle();

    if (!config || !config.is_enabled) {
      throw new ShippingError(
        'A integração de frete não está ativada nesta conta',
        400
      );
    }
    if (!config.encrypted_token || !config.contact_email) {
      throw new ShippingError(
        'A integração de frete está incompleta. Configure em Configurações.',
        400
      );
    }

    const origem = normalizePostalCode(
      String(body.origin_postal_code ?? config.origin_postal_code ?? '')
    );
    if (!isValidPostalCode(origem)) {
      throw new ShippingError(
        'CEP de origem não configurado. Defina em Configurações.',
        400
      );
    }

    const provider = new SuperFreteProvider({
      token: decrypt(config.encrypted_token),
      contactEmail: config.contact_email,
      environment: config.environment as ShippingEnvironment,
    });

    const num = (v: unknown, padrao: number) => {
      const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : padrao;
    };

    const opcoes = await provider.quote({
      originPostalCode: origem,
      destinationPostalCode: destino,
      heightCm: num(body.height_cm, Number(config.default_height_cm)),
      widthCm: num(body.width_cm, Number(config.default_width_cm)),
      lengthCm: num(body.length_cm, Number(config.default_length_cm)),
      weightKg: num(body.weight_kg, Number(config.default_weight_kg)),
      insuranceCents:
        typeof body.insurance_cents === 'number' ? body.insurance_cents : 0,
      services:
        typeof body.services === 'string' && body.services.trim()
          ? body.services
          : ((config.services as string | null) ?? null),
    });

    // Guarda o CEP no contato para a próxima cotação não pedir de
    // novo. Melhor esforço: falhar aqui não pode derrubar a cotação
    // que o vendedor já tem em mãos.
    if (typeof body.contact_id === 'string' && body.contact_id) {
      await ctx.supabase
        .from('contacts')
        .update({ postal_code: destino })
        .eq('id', body.contact_id)
        .eq('account_id', ctx.accountId)
        .then(() => undefined, () => undefined);
    }

    return NextResponse.json({
      options: opcoes,
      message: buildShippingMessage(opcoes),
    });
  } catch (err) {
    if (err instanceof ShippingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return commerceErrorResponse(err);
  }
}
