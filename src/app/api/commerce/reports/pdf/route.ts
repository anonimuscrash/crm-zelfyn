import { renderToBuffer } from '@react-pdf/renderer';
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  fetchCustomerStats,
  fetchDashboardMetrics,
  fetchExpenseBreakdown,
  fetchProductRanking,
  fetchSellerPerformance,
} from '@/lib/commerce/analytics.repo';
import {
  commerceErrorResponse,
  intParam,
  periodFromSearchParams,
} from '@/lib/commerce/http';
import {
  buildReportModel,
  reportFilename,
  type ReportScope,
} from '@/lib/reports/report-data';
import { ReportDocument } from '@/lib/reports/report-document';

/**
 * Relatório em PDF — gerencial (conta inteira) ou de um atendente.
 *
 * Mesma janela e mesmas RPCs de `/api/commerce/reports`; só a
 * apresentação muda. Reaproveitar as funções em vez de escrever
 * consultas próprias é o que garante que a tela e o papel nunca
 * discordem — um relatório impresso que não bate com o painel é
 * pior do que não ter relatório.
 *
 * PERMISSÃO
 * ---------
 * O recorte por atendente exige `admin`. O banco já força o
 * próprio uid quando o chamador não é master (`resolve_seller_scope`,
 * migration 046), então um vendedor pedindo o PDF de um colega
 * receberia os próprios números — tecnicamente seguro, mas com um
 * nome errado impresso na capa. A checagem aqui recusa antes de
 * chegar nesse ponto.
 *
 * A série temporal não é buscada: o PDF não desenha gráfico, e
 * `fetchSalesSeries` é a consulta mais cara do conjunto.
 */
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const sellerId = params.get('sellerId') || null;
    const scope: ReportScope = sellerId ? 'seller' : 'platform';

    const ctx = await requireRole(scope === 'seller' ? 'admin' : 'viewer');

    const period = periodFromSearchParams(params);
    const limit = intParam(params, 'limit', 25, { max: 100 });

    const [metrics, ranking, expenses, sellers, customers] = await Promise.all([
      fetchDashboardMetrics(ctx.supabase, ctx.accountId, period, sellerId),
      fetchProductRanking(ctx.supabase, ctx.accountId, period, { limit, sellerId }),
      fetchExpenseBreakdown(ctx.supabase, ctx.accountId, period),
      fetchSellerPerformance(ctx.supabase, ctx.accountId, period),
      fetchCustomerStats(ctx.supabase, ctx.accountId, { limit }),
    ]);

    // Nomes dos clientes. A RPC devolve só o id, e um PDF que
    // identifica o cliente por fragmento de UUID não serve para
    // reunião. Uma consulta, restrita aos ids que já vão ser
    // impressos.
    const customerNames: Record<string, string> = {};
    const ids = customers.map((c) => c.contact_id).filter(Boolean);
    if (ids.length > 0) {
      const { data: contatos } = await ctx.supabase
        .from('contacts')
        .select('id, name, phone')
        .in('id', ids);
      for (const c of contatos ?? []) {
        const linha = c as { id: string; name: string | null; phone: string | null };
        const rotulo = linha.name?.trim() || linha.phone?.trim();
        if (rotulo) customerNames[linha.id] = rotulo;
      }
    }

    // Nome do atendente, tirado do desempenho já carregado — evita
    // uma consulta a `profiles` só para a capa.
    const sellerName = sellerId
      ? sellers.find((s) => s.seller_user_id === sellerId)?.seller_name
      : undefined;

    const model = buildReportModel(
      {
        period: { from: period.from.toISOString(), to: period.to.toISOString() },
        metrics,
        ranking,
        expenses,
        sellers,
        customers,
      },
      scope,
      {
        accountName: ctx.account.name || 'Operza',
        sellerName,
        customerNames,
      },
    );

    const buffer = await renderToBuffer(ReportDocument({ model }));
    const filename = reportFilename(model, {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
    });

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
        // Relatório reflete dado que muda a cada pedido novo.
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
