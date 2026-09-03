// ============================================================
// Preparação dos dados do relatório em PDF.
//
// Tudo aqui é puro: entra o payload que a rota /reports já
// devolve, sai a estrutura que o documento renderiza. O motivo de
// separar isso do componente é teste — o React-PDF só roda num
// ambiente com yoga carregado, e não dá para asseverar sobre um
// buffer binário. As decisões de conteúdo ficam aqui, testáveis
// linha a linha; o componente só desenha.
//
// ESCOPO DO RELATÓRIO POR ATENDENTE
// ---------------------------------
// O relatório de um vendedor mostra as VENDAS dele, e não o
// resultado. Nada de CMV, lucro, margem ou despesa operacional.
//
// Não é só privacidade: despesa operacional não é atribuível a um
// vendedor. Aluguel e folha não pertencem a ninguém do time em
// particular, então um "lucro por vendedor" seria um número
// inventado — e números inventados em relatório impresso viram
// discussão de comissão depois.
// ============================================================

import { formatCents } from '@/lib/commerce/money';
import type {
  CustomerStatsRow,
  DashboardMetricsRow,
  ExpenseBreakdownRow,
  ProductRankingRow,
  SellerPerformanceRow,
} from '@/lib/commerce/types';

export type ReportScope = 'platform' | 'seller';

export interface ReportPeriod {
  from: string;
  to: string;
}

/** O payload de /api/commerce/reports, na parte que o PDF usa. */
export interface ReportSource {
  period: ReportPeriod;
  metrics: DashboardMetricsRow;
  ranking: ProductRankingRow[];
  expenses: ExpenseBreakdownRow[];
  sellers: SellerPerformanceRow[];
  customers: CustomerStatsRow[];
}

export interface ReportCell {
  text: string;
  /** Alinhamento à direita para colunas numéricas. */
  numeric?: boolean;
}

export interface ReportTable {
  title: string;
  columns: string[];
  /** Larguras relativas, uma por coluna. Somam qualquer coisa. */
  widths: number[];
  rows: ReportCell[][];
  /** Mostrado no lugar da tabela quando não há linhas. */
  emptyText: string;
}

export interface ReportSummaryItem {
  label: string;
  value: string;
  /** Destaque visual — usado no resultado operacional. */
  strong?: boolean;
}

export interface ReportModel {
  scope: ReportScope;
  title: string;
  subtitle: string;
  periodLabel: string;
  generatedLabel: string;
  summary: ReportSummaryItem[];
  tables: ReportTable[];
}

const TZ = 'America/Sao_Paulo';

function money(cents: number): string {
  return formatCents(cents);
}

function integer(value: number): string {
  return new Intl.NumberFormat('pt-BR').format(value ?? 0);
}

/**
 * Data no formato dd/mm/aaaa, fixada no fuso de São Paulo.
 *
 * Sem o timeZone explícito o Node do container renderiza em UTC, e
 * um período que termina 31/03 23:00 em Brasília sairia impresso
 * como 01/04 — o relatório pareceria cobrir um dia a mais do que
 * cobre.
 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function periodLabel(period: ReportPeriod): string {
  return `${formatDate(period.from)} a ${formatDate(period.to)}`;
}

/** Margem em % a partir de lucro e receita, tolerante a receita zero. */
function marginLabel(profitCents: number, revenueCents: number): string {
  if (!revenueCents) return '—';
  const pct = (profitCents / revenueCents) * 100;
  return `${pct.toFixed(1).replace('.', ',')}%`;
}

// ---------- Tabelas ----------

function productTable(rows: ProductRankingRow[], scope: ReportScope): ReportTable {
  // No relatório do vendedor a tabela perde CMV e lucro: ele vê o
  // que vendeu e por quanto, não o custo da mercadoria.
  const completo = scope === 'platform';

  return {
    title: 'Produtos vendidos',
    columns: completo
      ? ['Produto', 'SKU', 'Un.', 'Faturamento', 'CMV', 'Lucro', 'Margem']
      : ['Produto', 'SKU', 'Un.', 'Pedidos', 'Faturamento'],
    widths: completo ? [26, 13, 8, 15, 13, 13, 12] : [38, 18, 10, 12, 22],
    rows: rows.map((r) =>
      completo
        ? [
            { text: r.product_name },
            { text: r.product_sku || '—' },
            { text: integer(r.units_sold), numeric: true },
            { text: money(r.net_revenue_cents), numeric: true },
            { text: money(r.cogs_cents), numeric: true },
            { text: money(r.gross_profit_cents), numeric: true },
            {
              text: marginLabel(r.gross_profit_cents, r.net_revenue_cents),
              numeric: true,
            },
          ]
        : [
            { text: r.product_name },
            { text: r.product_sku || '—' },
            { text: integer(r.units_sold), numeric: true },
            { text: integer(r.order_count), numeric: true },
            { text: money(r.net_revenue_cents), numeric: true },
          ],
    ),
    emptyText: 'Nenhum produto vendido no período.',
  };
}

function sellerTable(rows: SellerPerformanceRow[]): ReportTable {
  return {
    title: 'Desempenho por atendente',
    columns: ['Atendente', 'Pedidos', 'Faturamento', 'Ticket médio', 'Lucro bruto'],
    widths: [32, 12, 20, 18, 18],
    rows: rows.map((r) => [
      { text: r.seller_name },
      { text: integer(r.order_count), numeric: true },
      { text: money(r.net_revenue_cents), numeric: true },
      { text: money(r.avg_ticket_cents), numeric: true },
      { text: money(r.gross_profit_cents), numeric: true },
    ]),
    emptyText: 'Nenhuma venda atribuída a atendentes no período.',
  };
}

/**
 * Nome do cliente para impressão.
 *
 * A RPC de estatísticas devolve só o `contact_id`, e a tela exibe
 * os 8 primeiros caracteres do UUID. Isso passa numa tabela que
 * você inspeciona ao vivo, mas num PDF que vai para reunião ou
 * e-mail "a3f9c1b2" não é informação. A rota resolve os nomes
 * antes de montar o modelo; quando o contato foi apagado, o
 * fragmento do id volta como último recurso.
 */
function customerLabel(
  contactId: string,
  names: Record<string, string> | undefined,
): string {
  const nome = names?.[contactId]?.trim();
  return nome || `Contato ${contactId.slice(0, 8)}`;
}

function customerTable(
  rows: CustomerStatsRow[],
  scope: ReportScope,
  names?: Record<string, string>,
): ReportTable {
  const completo = scope === 'platform';
  return {
    title: 'Principais clientes',
    columns: completo
      ? ['Cliente', 'Pedidos', 'Total gasto', 'Ticket médio', 'Última compra']
      : ['Cliente', 'Pedidos', 'Total gasto', 'Última compra'],
    widths: completo ? [30, 12, 20, 18, 20] : [38, 14, 24, 24],
    rows: rows.map((r) => {
      const base: ReportCell[] = [
        { text: customerLabel(r.contact_id, names) },
        { text: integer(r.order_count), numeric: true },
        { text: money(r.net_revenue_cents), numeric: true },
      ];
      if (completo) base.push({ text: money(r.avg_ticket_cents), numeric: true });
      base.push({ text: formatDate(r.last_order_at), numeric: true });
      return base;
    }),
    emptyText: 'Nenhum cliente com compras no período.',
  };
}

function expenseTable(rows: ExpenseBreakdownRow[]): ReportTable {
  return {
    title: 'Despesas operacionais',
    columns: ['Categoria', 'Lançamentos', 'Valor'],
    widths: [56, 20, 24],
    rows: rows.map((r) => [
      { text: r.category_name },
      { text: integer(r.entry_count), numeric: true },
      { text: money(r.amount_cents), numeric: true },
    ]),
    emptyText: 'Nenhuma despesa lançada no período.',
  };
}

// ---------- Resumo ----------

function platformSummary(m: DashboardMetricsRow): ReportSummaryItem[] {
  return [
    { label: 'Faturamento bruto', value: money(m.gross_cents) },
    { label: 'Descontos', value: money(m.discount_cents) },
    { label: 'Receita líquida', value: money(m.net_revenue_cents) },
    { label: 'CMV', value: money(m.cogs_cents) },
    { label: 'Frete', value: money(m.shipping_cents) },
    { label: 'Taxas', value: money(m.fees_cents) },
    { label: 'Lucro bruto', value: money(m.gross_profit_cents) },
    { label: 'Despesas operacionais', value: money(m.operating_expenses_cents) },
    { label: 'Resultado operacional', value: money(m.operating_profit_cents), strong: true },
    { label: 'Margem operacional', value: marginLabel(m.operating_profit_cents, m.net_revenue_cents) },
    { label: 'Pedidos', value: integer(m.order_count) },
    { label: 'Ticket médio', value: money(m.avg_ticket_cents) },
    { label: 'Unidades vendidas', value: integer(m.units_sold) },
    { label: 'Clientes atendidos', value: integer(m.customer_count) },
  ];
}

function sellerSummary(m: DashboardMetricsRow): ReportSummaryItem[] {
  return [
    { label: 'Faturamento', value: money(m.net_revenue_cents), strong: true },
    { label: 'Pedidos', value: integer(m.order_count) },
    { label: 'Ticket médio', value: money(m.avg_ticket_cents) },
    { label: 'Unidades vendidas', value: integer(m.units_sold) },
    { label: 'Clientes atendidos', value: integer(m.customer_count) },
    { label: 'Descontos concedidos', value: money(m.discount_cents) },
    { label: 'Aguardando envio', value: integer(m.status_awaiting_shipment) },
    { label: 'Enviados', value: integer(m.status_shipped) },
    { label: 'Concluídos', value: integer(m.status_completed) },
  ];
}

// ---------- Montagem ----------

export interface BuildOptions {
  accountName: string;
  /** Nome do atendente. Presente só quando scope === 'seller'. */
  sellerName?: string;
  /** Instante da emissão. Injetável para o teste não depender do relógio. */
  generatedAt?: Date;
  /** contact_id → nome, resolvido pela rota. */
  customerNames?: Record<string, string>;
}

export function buildReportModel(
  source: ReportSource,
  scope: ReportScope,
  options: BuildOptions,
): ReportModel {
  const emitido = options.generatedAt ?? new Date();

  if (scope === 'seller') {
    return {
      scope,
      title: 'Relatório de vendas',
      subtitle: options.sellerName?.trim() || 'Atendente',
      periodLabel: periodLabel(source.period),
      generatedLabel: `${options.accountName} · emitido em ${formatDateTime(emitido.toISOString())}`,
      summary: sellerSummary(source.metrics),
      tables: [
        productTable(source.ranking, scope),
        customerTable(source.customers, scope, options.customerNames),
      ],
    };
  }

  return {
    scope,
    title: 'Relatório gerencial',
    subtitle: options.accountName,
    periodLabel: periodLabel(source.period),
    generatedLabel: `Emitido em ${formatDateTime(emitido.toISOString())}`,
    summary: platformSummary(source.metrics),
    tables: [
      productTable(source.ranking, scope),
      sellerTable(source.sellers),
      customerTable(source.customers, scope, options.customerNames),
      expenseTable(source.expenses),
    ],
  };
}

/**
 * Nome do arquivo baixado. Sem acento e sem espaço — alguns
 * clientes de e-mail e o Windows Explorer tratam mal `Content-
 * Disposition` com caractere fora de ASCII, e o anexo chega com
 * nome corrompido.
 */
export function reportFilename(model: ReportModel, period: ReportPeriod): string {
  const base = model.scope === 'seller' ? 'relatorio-atendente' : 'relatorio-gerencial';
  const quem =
    model.scope === 'seller'
      ? '-' +
        model.subtitle
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-zA-Z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .toLowerCase()
      : '';
  const de = period.from.slice(0, 10);
  const ate = period.to.slice(0, 10);
  return `${base}${quem}_${de}_${ate}.pdf`;
}
