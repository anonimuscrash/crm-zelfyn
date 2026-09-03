import { describe, expect, it } from 'vitest';

import type {
  CustomerStatsRow,
  DashboardMetricsRow,
  ExpenseBreakdownRow,
  ProductRankingRow,
  SellerPerformanceRow,
} from '@/lib/commerce/types';

import {
  buildReportModel,
  formatDate,
  periodLabel,
  reportFilename,
  type ReportSource,
} from './report-data';

const metrics: DashboardMetricsRow = {
  gross_cents: 1_000_00,
  discount_cents: 50_00,
  net_revenue_cents: 950_00,
  cogs_cents: 400_00,
  shipping_cents: 30_00,
  fees_cents: 20_00,
  other_costs_cents: 0,
  direct_costs_cents: 450_00,
  gross_profit_cents: 500_00,
  operating_expenses_cents: 200_00,
  operating_profit_cents: 300_00,
  order_count: 12,
  units_sold: 30,
  avg_ticket_cents: 79_17,
  customer_count: 9,
  status_awaiting_shipment: 2,
  status_shipped: 4,
  status_completed: 6,
} as DashboardMetricsRow;

const ranking: ProductRankingRow[] = [
  {
    product_id: 'p1',
    product_name: 'Camiseta',
    product_sku: 'CAM-01',
    units_sold: 10,
    order_count: 8,
    gross_cents: 500_00,
    discount_cents: 0,
    net_revenue_cents: 500_00,
    cogs_cents: 200_00,
    gross_profit_cents: 300_00,
    avg_ticket_cents: 62_50,
  },
];

const sellers: SellerPerformanceRow[] = [
  {
    seller_user_id: 'u1',
    seller_name: 'Ana Paula',
    order_count: 7,
    net_revenue_cents: 600_00,
    gross_profit_cents: 320_00,
    avg_ticket_cents: 85_71,
  },
];

const customers: CustomerStatsRow[] = [
  {
    contact_id: 'c0ffee00-1111-2222-3333-444444444444',
    order_count: 3,
    net_revenue_cents: 300_00,
    gross_profit_cents: 150_00,
    avg_ticket_cents: 100_00,
    first_order_at: '2026-03-01T12:00:00.000Z',
    last_order_at: '2026-03-20T12:00:00.000Z',
  },
];

const expenses: ExpenseBreakdownRow[] = [
  {
    category_id: 'e1',
    category_name: 'Aluguel',
    color: '#000',
    amount_cents: 200_00,
    entry_count: 1,
  },
];

const source: ReportSource = {
  period: { from: '2026-03-01T03:00:00.000Z', to: '2026-03-31T03:00:00.000Z' },
  metrics,
  ranking,
  sellers,
  customers,
  expenses,
};

const emitido = new Date('2026-04-01T15:30:00.000Z');

function textoInteiro(model: ReturnType<typeof buildReportModel>): string {
  const resumo = model.summary.map((i) => `${i.label} ${i.value}`).join(' ');
  const tabelas = model.tables
    .map(
      (t) =>
        `${t.title} ${t.columns.join(' ')} ` +
        t.rows.map((r) => r.map((c) => c.text).join(' ')).join(' '),
    )
    .join(' ');
  return `${resumo} ${tabelas}`;
}

describe('relatório gerencial', () => {
  it('traz o resultado operacional e as quatro tabelas', () => {
    const model = buildReportModel(source, 'platform', {
      accountName: 'Loja da Kamila',
      generatedAt: emitido,
    });

    expect(model.subtitle).toBe('Loja da Kamila');
    expect(model.tables.map((t) => t.title)).toEqual([
      'Produtos vendidos',
      'Desempenho por atendente',
      'Principais clientes',
      'Despesas operacionais',
    ]);

    const resultado = model.summary.find((i) => i.label === 'Resultado operacional');
    expect(resultado?.strong).toBe(true);
    expect(resultado?.value).toContain('300,00');
  });

  it('calcula a margem operacional sobre a receita líquida', () => {
    const model = buildReportModel(source, 'platform', {
      accountName: 'Loja',
      generatedAt: emitido,
    });
    // 300 / 950 = 31,6%
    expect(
      model.summary.find((i) => i.label === 'Margem operacional')?.value,
    ).toBe('31,6%');
  });

  it('não divide por zero quando não houve receita', () => {
    const zerado: ReportSource = {
      ...source,
      metrics: { ...metrics, net_revenue_cents: 0, operating_profit_cents: 0 },
    };
    const model = buildReportModel(zerado, 'platform', {
      accountName: 'Loja',
      generatedAt: emitido,
    });
    expect(
      model.summary.find((i) => i.label === 'Margem operacional')?.value,
    ).toBe('—');
  });
});

describe('relatório do atendente', () => {
  // A regra combinada com o cliente: o atendente vê o que vendeu,
  // não o resultado. Estes dois testes existem para que ninguém
  // reintroduza custo no relatório dele por engano.
  it('não expõe custo, lucro nem despesa em lugar nenhum', () => {
    const model = buildReportModel(source, 'seller', {
      accountName: 'Loja',
      sellerName: 'Ana Paula',
      generatedAt: emitido,
    });

    const texto = textoInteiro(model).toLowerCase();
    for (const proibido of ['cmv', 'lucro', 'margem', 'despesa', 'custo']) {
      expect(texto).not.toContain(proibido);
    }
  });

  it('não mostra a tabela de desempenho dos colegas', () => {
    const model = buildReportModel(source, 'seller', {
      accountName: 'Loja',
      sellerName: 'Ana Paula',
      generatedAt: emitido,
    });
    expect(model.tables.map((t) => t.title)).toEqual([
      'Produtos vendidos',
      'Principais clientes',
    ]);
  });

  it('destaca o faturamento e nomeia o atendente', () => {
    const model = buildReportModel(source, 'seller', {
      accountName: 'Loja',
      sellerName: 'Ana Paula',
      generatedAt: emitido,
    });
    expect(model.subtitle).toBe('Ana Paula');
    expect(model.summary[0]).toMatchObject({ label: 'Faturamento', strong: true });
  });

  it('cai para um rótulo genérico quando o nome vem vazio', () => {
    const model = buildReportModel(source, 'seller', {
      accountName: 'Loja',
      sellerName: '   ',
      generatedAt: emitido,
    });
    expect(model.subtitle).toBe('Atendente');
  });
});

describe('nome do cliente', () => {
  it('usa o nome resolvido quando existe', () => {
    const model = buildReportModel(source, 'platform', {
      accountName: 'Loja',
      generatedAt: emitido,
      customerNames: { 'c0ffee00-1111-2222-3333-444444444444': 'Maria Silva' },
    });
    const tabela = model.tables.find((t) => t.title === 'Principais clientes')!;
    expect(tabela.rows[0][0].text).toBe('Maria Silva');
  });

  it('cai para o fragmento do id quando o contato sumiu', () => {
    const model = buildReportModel(source, 'platform', {
      accountName: 'Loja',
      generatedAt: emitido,
    });
    const tabela = model.tables.find((t) => t.title === 'Principais clientes')!;
    expect(tabela.rows[0][0].text).toBe('Contato c0ffee00');
  });
});

describe('datas', () => {
  it('imprime no fuso de São Paulo, não em UTC', () => {
    // 31/03 21:00 em Brasília é 01/04 00:00 UTC. Sem o timeZone
    // fixo o relatório diria que cobre até 01/04.
    expect(formatDate('2026-04-01T00:00:00.000Z')).toBe('31/03/2026');
  });

  it('monta o intervalo do período', () => {
    expect(periodLabel(source.period)).toBe('01/03/2026 a 31/03/2026');
  });

  it('devolve travessão para data inválida em vez de "Invalid Date"', () => {
    expect(formatDate('nada disso')).toBe('—');
  });
});

describe('nome do arquivo', () => {
  it('remove acento e espaço do nome do atendente', () => {
    const model = buildReportModel(source, 'seller', {
      accountName: 'Loja',
      sellerName: 'João da Conceição',
      generatedAt: emitido,
    });
    expect(reportFilename(model, source.period)).toBe(
      'relatorio-atendente-joao-da-conceicao_2026-03-01_2026-03-31.pdf',
    );
  });

  it('usa o prefixo gerencial quando é da conta inteira', () => {
    const model = buildReportModel(source, 'platform', {
      accountName: 'Loja',
      generatedAt: emitido,
    });
    expect(reportFilename(model, source.period)).toBe(
      'relatorio-gerencial_2026-03-01_2026-03-31.pdf',
    );
  });
});
