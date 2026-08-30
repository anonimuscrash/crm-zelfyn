import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  fetchSellerOptions,
  fetchTeamOverview,
} from '@/lib/commerce/analytics.repo';
import {
  commerceErrorResponse,
  periodFromSearchParams,
} from '@/lib/commerce/http';
import { previousPeriod } from '@/lib/commerce/periods';

/**
 * GET /api/commerce/team
 *
 * Painel de equipe (§46). Exige master — `requireRole('admin')` na
 * rota E `assert_account_access(..., 'admin')` dentro da RPC. As duas
 * checagens são propositais: a rota dá a mensagem de erro certa, a
 * RPC garante que nenhum caminho futuro contorne a regra.
 *
 * `?options=1` devolve só a lista enxuta para o seletor do dashboard.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const params = new URL(request.url).searchParams;

    if (params.get('options') === '1') {
      const sellers = await fetchSellerOptions(ctx.supabase, ctx.accountId);
      return NextResponse.json({ sellers });
    }

    const period = periodFromSearchParams(params);

    // Período anterior no mesmo payload: sem ele, a coluna de
    // variação exigiria uma segunda chamada e as duas poderiam
    // resolver janelas diferentes se o filtro mudasse no meio.
    const [team, previous] = await Promise.all([
      fetchTeamOverview(ctx.supabase, ctx.accountId, period),
      fetchTeamOverview(ctx.supabase, ctx.accountId, previousPeriod(period)),
    ]);

    return NextResponse.json({
      period: {
        preset: period.preset,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      },
      team,
      previous,
    });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
