import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';
import { ValidationError } from '@/lib/commerce/validation';
import { encrypt } from '@/lib/whatsapp/encryption';
import { isValidPostalCode, normalizePostalCode } from '@/services/shipping/superfrete';

/**
 * Configuração da integração de frete. Somente master (§6 do
 * briefing de WhatsApp, mesma regra aqui).
 *
 * O token NUNCA volta ao frontend — nem em GET, nem depois de
 * salvar. A tela confirma qual credencial está em uso pelos últimos
 * quatro caracteres (`token_hint`), que é informação suficiente para
 * o operador reconhecer sem ser suficiente para alguém usar.
 */

const COLUNAS =
  'provider, is_enabled, environment, token_hint, contact_email, origin_postal_code, default_height_cm, default_width_cm, default_length_cm, default_weight_kg, services';

export async function GET() {
  try {
    const ctx = await requireRole('admin');

    const { data, error } = await ctx.supabase
      .from('shipping_integrations')
      .select(COLUNAS)
      .eq('account_id', ctx.accountId)
      .eq('provider', 'superfrete')
      .maybeSingle();

    if (error) throw new RepositoryError(error.message);

    return NextResponse.json(
      data ?? {
        provider: 'superfrete',
        is_enabled: false,
        environment: 'sandbox',
        token_hint: null,
        contact_email: null,
        origin_postal_code: null,
        default_height_cm: 4,
        default_width_cm: 12,
        default_length_cm: 17,
        default_weight_kg: 0.3,
        services: null,
      }
    );
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

function medida(valor: unknown, campo: string, max: number): number {
  const n = typeof valor === 'string' ? Number(valor.replace(',', '.')) : valor;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`${campo} deve ser maior que zero`, campo);
  }
  if (n > max) {
    throw new ValidationError(`${campo} excede o máximo de ${max}`, campo);
  }
  return n;
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await readJsonBody(request)) as Record<string, unknown>;

    const patch: Record<string, unknown> = {
      account_id: ctx.accountId,
      provider: 'superfrete',
    };

    if ('is_enabled' in body) {
      patch.is_enabled = Boolean(body.is_enabled);
    }

    if ('environment' in body) {
      if (body.environment !== 'sandbox' && body.environment !== 'production') {
        throw new ValidationError(
          "environment deve ser 'sandbox' ou 'production'",
          'environment'
        );
      }
      patch.environment = body.environment;
    }

    // Token só é regravado quando vem preenchido. Um PATCH que salva
    // apenas o CEP não pode apagar a credencial — e é exatamente o
    // que aconteceria se o campo vazio do formulário sobrescrevesse.
    if (typeof body.token === 'string' && body.token.trim()) {
      const token = body.token.trim();
      if (token.length < 20) {
        throw new ValidationError('Token parece incompleto', 'token');
      }
      patch.encrypted_token = encrypt(token);
      patch.token_hint = token.slice(-4);
    }

    if ('contact_email' in body) {
      const email = String(body.contact_email ?? '').trim();
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new ValidationError('E-mail de contato inválido', 'contact_email');
      }
      patch.contact_email = email || null;
    }

    if ('origin_postal_code' in body) {
      const cep = normalizePostalCode(String(body.origin_postal_code ?? ''));
      if (cep && !isValidPostalCode(cep)) {
        throw new ValidationError(
          'CEP de origem deve ter 8 dígitos',
          'origin_postal_code'
        );
      }
      patch.origin_postal_code = cep || null;
    }

    if ('services' in body) {
      const bruto = String(body.services ?? '').trim();
      if (bruto && !/^[0-9]+(\s*,\s*[0-9]+)*$/.test(bruto)) {
        throw new ValidationError(
          'Serviços devem ser IDs numéricos separados por vírgula (ex: 1,2,17)',
          'services'
        );
      }
      patch.services = bruto ? bruto.replace(/\s+/g, '') : null;
    }

    if ('default_height_cm' in body) {
      patch.default_height_cm = medida(body.default_height_cm, 'altura', 200);
    }
    if ('default_width_cm' in body) {
      patch.default_width_cm = medida(body.default_width_cm, 'largura', 200);
    }
    if ('default_length_cm' in body) {
      patch.default_length_cm = medida(body.default_length_cm, 'comprimento', 200);
    }
    if ('default_weight_kg' in body) {
      patch.default_weight_kg = medida(body.default_weight_kg, 'peso', 100);
    }

    const { error } = await ctx.supabase
      .from('shipping_integrations')
      .upsert(patch, { onConflict: 'account_id,provider' });

    if (error) throw new RepositoryError(error.message);

    await ctx.supabase.rpc('write_audit_log', {
      p_account_id: ctx.accountId,
      p_action: 'shipping.settings_updated',
      p_entity_type: 'shipping_integration',
      p_entity_id: null,
      // Sem token, sem hint. Um log de auditoria é lido por gente que
      // não precisa da credencial.
      p_metadata: {
        provider: 'superfrete',
        enabled: patch.is_enabled ?? null,
        environment: patch.environment ?? null,
        token_changed: Boolean(patch.encrypted_token),
      },
    });

    const { data } = await ctx.supabase
      .from('shipping_integrations')
      .select(COLUNAS)
      .eq('account_id', ctx.accountId)
      .eq('provider', 'superfrete')
      .maybeSingle();

    return NextResponse.json(data ?? {});
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
