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
  'provider, is_enabled, environment, api_key_hint, default_expires_in, webhook_enabled, base_url';

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
        webhook_enabled: false,
        base_url: null,
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

    // Aviso sobre a validação, devolvido junto com a configuração
    // salva. Não bloqueia.
    let aviso: string | null = null;

    // Chave só é regravada quando vem preenchida. Um PATCH que muda
    // só a expiração não pode apagar a credencial — e é o que
    // aconteceria se o campo vazio do formulário sobrescrevesse.
    if (typeof body.api_key === 'string' && body.api_key.trim()) {
      const chave = body.api_key.trim();

      if (chave.length < 12) {
        throw new ValidationError('Chave parece incompleta', 'api_key');
      }

      // O FORMATO É AVISO, NÃO BLOQUEIO.
      //
      // Recusar por regex significa que uma mudança no formato da
      // chave — que está fora do nosso controle — trava a
      // configuração inteira. Melhor salvar e apontar a estranheza.
      if (!isValidApiKey(chave)) {
        aviso =
          'A chave não tem o formato vk_live_ ou vk_test_ esperado. Ela foi salva mesmo assim — use "Testar chave" para confirmar.';
      }

      // A VALIDAÇÃO CONTRA A DOTFY TAMBÉM NÃO BLOQUEIA.
      //
      // Antes eu chamava a API antes de gravar. Qualquer instabilidade
      // do lado deles, um timeout de rede ou uma diferença no formato
      // da resposta impedia o operador de sequer salvar a
      // configuração — que é exatamente o pior momento para falhar,
      // porque ele fica sem saída.
      //
      // Agora salva primeiro e testa depois, reportando o resultado.
      // O botão "Testar chave" continua disponível para reconferir.
      try {
        await new DotfyProvider(
          chave,
          // Usa a base do mesmo PATCH quando ela vem junto: testar
          // contra o endereço antigo enquanto se troca os dois daria
          // um "falhou" enganoso.
          (patch.base_url as string | undefined) ?? undefined
        ).verifyKey();
      } catch (e) {
        aviso =
          e instanceof PaymentError
            ? `Chave salva, mas o teste falhou: ${e.message}`
            : 'Chave salva, mas não foi possível testá-la agora.';
      }

      patch.encrypted_api_key = encrypt(chave);
      patch.api_key_hint = chave.slice(-4);
      // Ambiente derivado da chave, não escolhido: evita a conta
      // marcada como produção rodando com credencial de teste.
      patch.environment = environmentFromKey(chave);
    }

    if ('base_url' in body) {
      const bruto = String(body.base_url ?? '').trim().replace(/\/+$/, '');
      if (bruto && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(bruto)) {
        throw new ValidationError(
          'Endereço deve ser uma URL https sem caminho, ex: https://app.dotfy.com.br',
          'base_url'
        );
      }
      patch.base_url = bruto || null;
    }

    if ('webhook_enabled' in body) {
      patch.webhook_enabled = Boolean(body.webhook_enabled);
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

    return NextResponse.json({ ...(data ?? {}), warning: aviso });
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
      .select('encrypted_api_key, base_url')
      .eq('account_id', ctx.accountId)
      .eq('provider', 'dotfy')
      .maybeSingle();

    if (!data?.encrypted_api_key) {
      throw new ValidationError('Nenhuma chave configurada');
    }

    const resultado = await new DotfyProvider(
      decrypt(data.encrypted_api_key),
      data.base_url
    ).verifyKey();

    return NextResponse.json({ ok: true, seller: resultado.seller ?? null });
  } catch (err) {
    if (err instanceof PaymentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return commerceErrorResponse(err);
  }
}
