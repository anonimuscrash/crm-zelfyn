import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { ValidationError } from '@/lib/commerce/validation';

/**
 * Configurações do workspace (feature flags).
 *
 * Somente master. A policy "Masters write settings" de 045 já recusa
 * escrita de qualquer outro papel — esta rota existe para dar a
 * mensagem certa e para validar o corpo antes de chegar ao banco.
 */

const FLAGS = [
  'team_enabled',
  'inventory_enabled',
  'printing_enabled',
  'commissions_enabled',
  'payments_enabled',
] as const;

const COLUNAS =
  'account_id, team_enabled, inventory_enabled, printing_enabled, commissions_enabled, payments_enabled, customer_visibility, plan, max_sellers, onboarding_completed_at';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');

    // Semeia a linha na primeira leitura: contas criadas antes de 045
    // não têm settings, e a ausência não deve virar tela de erro.
    await ctx.supabase.rpc('ensure_account_settings', {
      p_account_id: ctx.accountId,
    });

    const { data, error } = await ctx.supabase
      .from('account_settings')
      .select(COLUNAS)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return NextResponse.json(data ?? {});
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await readJsonBody(request)) as Record<string, unknown>;

    const patch: Record<string, unknown> = {};

    for (const flag of FLAGS) {
      if (flag in body) {
        if (typeof body[flag] !== 'boolean') {
          throw new ValidationError(`${flag} deve ser true ou false`, flag);
        }
        patch[flag] = body[flag];
      }
    }

    if ('customer_visibility' in body) {
      if (
        body.customer_visibility !== 'shared' &&
        body.customer_visibility !== 'per_seller'
      ) {
        throw new ValidationError(
          "customer_visibility deve ser 'shared' ou 'per_seller'",
          'customer_visibility'
        );
      }
      patch.customer_visibility = body.customer_visibility;
    }

    if ('onboarding_completed' in body && body.onboarding_completed === true) {
      patch.onboarding_completed_at = new Date().toISOString();
    }

    if (Object.keys(patch).length === 0) {
      throw new ValidationError('Nada para atualizar');
    }

    await ctx.supabase.rpc('ensure_account_settings', {
      p_account_id: ctx.accountId,
    });

    const { data, error } = await ctx.supabase
      .from('account_settings')
      .update(patch)
      .eq('account_id', ctx.accountId)
      .select(COLUNAS)
      .maybeSingle();

    if (error) throw new Error(error.message);

    // Trilha de auditoria (§48): ligar equipe muda quem enxerga o
    // quê, então precisa ficar registrado quem fez e quando.
    await ctx.supabase.rpc('write_audit_log', {
      p_account_id: ctx.accountId,
      p_action: 'settings.updated',
      p_entity_type: 'account_settings',
      p_entity_id: ctx.accountId,
      p_metadata: patch,
    });

    return NextResponse.json(data ?? {});
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
