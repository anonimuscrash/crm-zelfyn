import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';
import { ValidationError } from '@/lib/commerce/validation';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import {
  DotfyProvider,
  environmentFromKey,
  isValidApiKey,
  PaymentError,
} from '@/services/payments/dotfy';

const COLUNAS =
  'provider, is_enabled, environment, api_key_hint, default_expires_in';

export async function GET() {
  try {
    const ctx = await requireRole('admin');

    const { data, error } = await ctx.supabase
      .from('payment_integrations')
      .select(COLUNAS)
      .eq('account_id', ctx.accountId)
      .eq('provider', 'dotfy')
      .maybeSingle();

    if (error) throw new RepositoryError(error.message);

    return NextResponse.json(
      data ?? {
        provider: 'dotfy',
        is_enabled: false,
        environment: 'sandbox',
        api_key_hint: null,
        default_expires_in: 3600,
      }
    );
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await readJsonBody(request)) as Record<string, unknown>;

    const patch: Record<string, unknown> = {
      account_id: ctx.accountId,
      provider: 'dotfy',
    };

    if ('is_enabled' in body) patch.is_enabled = Boolean(body.is_enabled);

    if ('default_expires_in' in body) {
      const n = Number(body.default_expires_in);
      if (!Number.isInteger(n) || n < 60 || n > 86_400) {
        throw new ValidationError(
          'Expiração deve estar entre 60 e 86400 segundos',
          'default_expires_in'
        );
      }
      patch.default_expires_in = n;
    }

    // Chave só é regravada quando vem preenchida. Um PATCH que muda
    // só a expiração não pode apagar a credencial — e é o que
    // aconteceria se o campo vazio do formulário sobrescrevesse.
    if (typeof body.api_key === 'string' && body.api_key.trim()) {
      const chave = body.api_key.trim();

      if (!isValidApiKey(chave)) {
        throw new ValidationError(
          'Chave inválida. Deve começar com vk_live_ ou vk_test_.',
          'api_key'
        );
      }

      // Valida contra a Dotfy ANTES de salvar. Guardar uma chave que
      // não funciona só adia a descoberta para o momento em que o
      // vendedor precisa cobrar um cliente.
      await new DotfyProvider(chave).verifyKey();

      patch.encrypted_api_key = encrypt(chave);
      patch.api_key_hint = chave.slice(-4);
      // Ambiente derivado da chave, não escolhido: evita a conta
      // marcada como produção rodando com credencial de teste.
      patch.environment = environmentFromKey(chave);
    }

    if (typeof body.webhook_secret === 'string' && body.webhook_secret.trim()) {
      patch.encrypted_webhook_secret = encrypt(body.webhook_secret.trim());
    }

    const { error } = await ctx.supabase
      .from('payment_integrations')
      .upsert(patch, { onConflict: 'account_id,provider' });

    if (error) throw new RepositoryError(error.message);

    await ctx.supabase.rpc('write_audit_log', {
      p_account_id: ctx.accountId,
      p_action: 'payments.settings_updated',
      p_entity_type: 'payment_integration',
      p_entity_id: null,
      p_metadata: {
        enabled: patch.is_enabled ?? null,
        environment: patch.environment ?? null,
        key_changed: Boolean(patch.encrypted_api_key),
      },
    });

    const { data } = await ctx.supabase
      .from('payment_integrations')
      .select(COLUNAS)
      .eq('account_id', ctx.accountId)
      .eq('provider', 'dotfy')
      .maybeSingle();

    return NextResponse.json(data ?? {});
  } catch (err) {
    if (err instanceof PaymentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return commerceErrorResponse(err);
  }
}

/** Testa a chave salva sem alterá-la. */
export async function POST() {
  try {
    const ctx = await requireRole('admin');

    const { data } = await ctx.supabase
      .from('payment_integrations')
      .select('encrypted_api_key')
      .eq('account_id', ctx.accountId)
      .eq('provider', 'dotfy')
      .maybeSingle();

    if (!data?.encrypted_api_key) {
      throw new ValidationError('Nenhuma chave configurada');
    }

    await new DotfyProvider(decrypt(data.encrypted_api_key)).verifyKey();
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PaymentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return commerceErrorResponse(err);
  }
}
