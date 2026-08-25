#!/usr/bin/env node
/**
 * Builds the commerce namespaces into every locale catalogue from a
 * single source table.
 *
 * The repo's messages.test.ts enforces exact key parity between
 * en.json and every translated locale — a key added to one file and
 * not the other renders as a raw keypath for those users and fails
 * the suite. Hand-editing three files in lockstep is how that drifts,
 * so the strings live here once as [en, pt, ko] triples and the
 * script writes all three.
 *
 * Idempotent: re-running merges over existing keys without touching
 * anything outside the namespaces declared below.
 *
 * Usage: node scripts/build-i18n.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'messages');
const LOCALES = ['en', 'pt-BR', 'ko'];
const IDX = { en: 0, 'pt-BR': 1, ko: 2 };

// [english, português, 한국어]
const T = {
  Sidebar: {
    dashboard: ['Dashboard', 'Dashboard', '대시보드'],
    sales: ['Sales', 'Vendas', '매출'],
    orders: ['Orders', 'Pedidos', '주문'],
    kanban: ['Kanban', 'Kanban', '칸반'],
    products: ['Products', 'Produtos', '상품'],
    customers: ['Customers', 'Clientes', '고객'],
    expenses: ['Expenses', 'Despesas', '비용'],
    reports: ['Reports', 'Relatórios', '리포트'],
    team: ['Team', 'Equipe', '팀'],
    support: ['Support desk', 'Atendimento', '상담'],
    sectionOperation: ['Operation', 'Operação', '운영'],
    sectionAnalysis: ['Analysis', 'Análise', '분석'],
    sectionAdmin: ['Admin', 'Administração', '관리'],
  },
  Commerce: {
    newSale: ['New sale', 'Nova venda', '새 판매'],
    save: ['Save', 'Salvar', '저장'],
    saving: ['Saving…', 'Salvando…', '저장 중…'],
    cancel: ['Cancel', 'Cancelar', '취소'],
    edit: ['Edit', 'Editar', '편집'],
    remove: ['Remove', 'Remover', '삭제'],
    archive: ['Archive', 'Arquivar', '보관'],
    add: ['Add', 'Adicionar', '추가'],
    close: ['Close', 'Fechar', '닫기'],
    search: ['Search', 'Buscar', '검색'],
    filters: ['Filters', 'Filtros', '필터'],
    clearFilters: ['Clear filters', 'Limpar filtros', '필터 지우기'],
    all: ['All', 'Todos', '전체'],
    none: ['None', 'Nenhum', '없음'],
    total: ['Total', 'Total', '합계'],
    loading: ['Loading…', 'Carregando…', '불러오는 중…'],
    loadError: ['Could not load the data', 'Não foi possível carregar os dados', '데이터를 불러오지 못했습니다'],
    retry: ['Try again', 'Tentar novamente', '다시 시도'],
    saved: ['Saved', 'Salvo', '저장됨'],
    previous: ['Previous', 'Anterior', '이전'],
    next: ['Next', 'Próxima', '다음'],
    pageOf: ['Page {page} of {pages}', 'Página {page} de {pages}', '{pages} 페이지 중 {page}'],
    resultCount: ['{count} results', '{count} resultados', '결과 {count}건'],
    readOnly: ['Read-only access', 'Acesso somente leitura', '읽기 전용 권한'],
    periodToday: ['Today', 'Hoje', '오늘'],
    periodLast7: ['7 days', '7 dias', '7일'],
    periodLast15: ['15 days', '15 dias', '15일'],
    periodLast30: ['30 days', '30 dias', '30일'],
    periodThisMonth: ['This month', 'Este mês', '이번 달'],
    periodLastMonth: ['Last month', 'Mês anterior', '지난달'],
    periodCustom: ['Custom', 'Personalizado', '사용자 지정'],
    periodFrom: ['From', 'De', '시작'],
    periodTo: ['To', 'Até', '종료'],
    periodApply: ['Apply', 'Aplicar', '적용'],
    vsPrevious: ['vs. previous period', 'vs. período anterior', '이전 기간 대비'],
    noBaseline: ['no baseline', 'sem base de comparação', '비교 기준 없음'],
  },
  Dash: {
    title: ['Overview', 'Visão geral', '개요'],
    grossRevenue: ['Gross revenue', 'Faturamento bruto', '총 매출'],
    discounts: ['Discounts given', 'Descontos concedidos', '할인액'],
    netRevenue: ['Net revenue', 'Faturamento líquido', '순매출'],
    cogs: ['Cost of goods sold', 'Custo dos produtos', '상품 원가'],
    shipping: ['Shipping cost', 'Custo de envio', '배송비'],
    fees: ['Payment fees', 'Taxas', '수수료'],
    otherCosts: ['Other direct costs', 'Outros custos diretos', '기타 직접비'],
    directCosts: ['Direct costs', 'Custos diretos', '직접비 합계'],
    grossProfit: ['Gross profit', 'Lucro bruto', '매출총이익'],
    opex: ['Operating expenses', 'Despesas operacionais', '운영비'],
    operatingProfit: ['Operating profit', 'Lucro operacional', '영업이익'],
    orderCount: ['Orders', 'Pedidos', '주문 수'],
    avgTicket: ['Average ticket', 'Ticket médio', '평균 객단가'],
    margin: ['Average margin', 'Margem média', '평균 마진'],
    unitsSold: ['Units sold', 'Produtos vendidos', '판매 수량'],
    customers: ['Customers served', 'Clientes atendidos', '고객 수'],
    statement: ['Result for the period', 'Resultado do período', '기간 손익'],
    fulfilment: ['Fulfilment', 'Operação de envio', '배송 현황'],
    awaiting: ['Awaiting shipment', 'Aguardando envio', '발송 대기'],
    shipped: ['Shipped', 'Enviados', '발송됨'],
    completed: ['Completed', 'Finalizados', '완료'],
    cancelled: ['Cancelled', 'Cancelados', '취소'],
    chartTitle: ['Sales trend', 'Evolução de vendas', '매출 추이'],
    chartRevenue: ['Revenue', 'Faturamento', '매출'],
    chartProfit: ['Profit', 'Lucro', '이익'],
    chartOrders: ['Orders', 'Vendas', '주문'],
    chartAvgTicket: ['Average ticket', 'Ticket médio', '객단가'],
    chartCosts: ['Costs', 'Custos', '비용'],
    compare: ['Compare with previous period', 'Comparar com período anterior', '이전 기간과 비교'],
    topProducts: ['Top products', 'Produtos', '주요 상품'],
    expenseBreakdown: ['Expenses by category', 'Despesas por categoria', '카테고리별 비용'],
    seeAll: ['See all', 'Ver tudo', '전체 보기'],
    emptyTitle: ['No sales in this period yet', 'Ainda não há vendas neste período', '이 기간에 판매가 없습니다'],
    emptyBody: [
      'Register a sale and the numbers on this screen start filling in.',
      'Registre uma venda e os números desta tela começam a ser preenchidos.',
      '판매를 등록하면 이 화면의 수치가 채워집니다.',
    ],
    setupTitle: ['Get started', 'Primeiros passos', '시작하기'],
    setupProducts: ['Register your products and their costs', 'Cadastre seus produtos e os custos', '상품과 원가를 등록하세요'],
    setupSale: ['Record your first sale', 'Registre sua primeira venda', '첫 판매를 기록하세요'],
    setupTrack: ['Track orders through the board', 'Acompanhe os pedidos no Kanban', '칸반에서 주문을 추적하세요'],
    setupExpenses: ['Add operating expenses to see real profit', 'Lance despesas para ver o lucro real', '운영비를 입력해 실제 이익을 확인하세요'],
  },
  Products: {
    title: ['Products', 'Produtos', '상품'],
    newProduct: ['New product', 'Novo produto', '새 상품'],
    editProduct: ['Edit product', 'Editar produto', '상품 편집'],
    name: ['Name', 'Nome', '이름'],
    sku: ['SKU', 'SKU', 'SKU'],
    description: ['Description', 'Descrição', '설명'],
    category: ['Category', 'Categoria', '카테고리'],
    unitCost: ['Unit cost', 'Custo unitário', '단위 원가'],
    unitPrice: ['Default price', 'Preço padrão', '기본 가격'],
    margin: ['Margin', 'Margem', '마진'],
    stock: ['Stock', 'Estoque', '재고'],
    stockUntracked: ['Not tracked', 'Não controlado', '미추적'],
    notes: ['Notes', 'Observações', '메모'],
    imageUrl: ['Image URL', 'URL da imagem', '이미지 URL'],
    active: ['Active', 'Ativo', '활성'],
    inactive: ['Inactive', 'Inativo', '비활성'],
    statusAll: ['All', 'Todos', '전체'],
    priceHint: [
      'Changing the price affects future sales only — past orders keep the price they were sold at.',
      'Alterar o preço afeta apenas vendas futuras — pedidos antigos mantêm o preço praticado.',
      '가격 변경은 향후 판매에만 적용되며 기존 주문은 판매 당시 가격을 유지합니다.',
    ],
    emptyTitle: ['No products yet', 'Nenhum produto cadastrado', '등록된 상품이 없습니다'],
    emptyBody: [
      'Products carry the cost that makes profit calculable on every sale.',
      'O produto carrega o custo que torna o lucro calculável em cada venda.',
      '상품에 등록된 원가로 판매별 이익을 계산합니다.',
    ],
    noResults: ['No product matches this search', 'Nenhum produto corresponde à busca', '검색 결과가 없습니다'],
    confirmArchive: ['Archive this product?', 'Arquivar este produto?', '이 상품을 보관할까요?'],
    archived: ['Product archived', 'Produto arquivado', '상품이 보관되었습니다'],
    created: ['Product created', 'Produto criado', '상품이 생성되었습니다'],
    updated: ['Product updated', 'Produto atualizado', '상품이 수정되었습니다'],
  },
  Orders: {
    title: ['Orders', 'Pedidos', '주문'],
    number: ['Order', 'Pedido', '주문번호'],
    customer: ['Customer', 'Cliente', '고객'],
    items: ['Products', 'Produtos', '상품'],
    grossValue: ['Gross', 'Bruto', '총액'],
    discount: ['Discount', 'Desconto', '할인'],
    netValue: ['Net', 'Líquido', '순액'],
    cost: ['Cost', 'Custo', '원가'],
    profit: ['Profit', 'Lucro', '이익'],
    margin: ['Margin', 'Margem', '마진'],
    status: ['Status', 'Status', '상태'],
    date: ['Date', 'Data', '날짜'],
    shipping: ['Shipping', 'Envio', '배송'],
    seller: ['Seller', 'Vendedor', '판매자'],
    trackingCode: ['Tracking code', 'Código de rastreio', '운송장 번호'],
    carrier: ['Carrier', 'Transportadora', '택배사'],
    notes: ['Notes', 'Observações', '메모'],
    detailTitle: ['Order {number}', 'Pedido {number}', '주문 {number}'],
    breakdown: ['Financial breakdown', 'Composição financeira', '금액 구성'],
    emptyTitle: ['No orders yet', 'Nenhum pedido registrado', '등록된 주문이 없습니다'],
    emptyBody: [
      'Every sale you close on WhatsApp gets recorded here.',
      'Toda venda fechada no WhatsApp é registrada aqui.',
      '왓츠앱에서 성사된 모든 판매가 여기에 기록됩니다.',
    ],
    noResults: ['No order matches these filters', 'Nenhum pedido corresponde aos filtros', '조건에 맞는 주문이 없습니다'],
    filterStatus: ['Status', 'Status', '상태'],
    filterSeller: ['Seller', 'Vendedor', '판매자'],
    filterProduct: ['Product', 'Produto', '상품'],
    created: ['Sale recorded', 'Venda registrada', '판매가 기록되었습니다'],
    statusUpdated: ['Status updated', 'Status atualizado', '상태가 변경되었습니다'],
    statusNew: ['New order', 'Novo pedido', '신규 주문'],
    statusPaid: ['Paid', 'Pago', '결제완료'],
    statusPreparing: ['Preparing', 'Preparar pedido', '준비중'],
    statusAwaitingShipment: ['Awaiting shipment', 'Aguardando envio', '발송 대기'],
    statusShipped: ['Shipped', 'Enviado', '발송됨'],
    statusDelivered: ['Delivered', 'Entregue', '배송완료'],
    statusCompleted: ['Completed', 'Finalizado', '완료'],
    statusProblem: ['Problem', 'Problema', '문제'],
    statusCancelled: ['Cancelled', 'Cancelado', '취소됨'],
    statusRefunded: ['Refunded', 'Reembolsado', '환불됨'],
  },
  Kanban: {
    title: ['Order board', 'Kanban de pedidos', '주문 보드'],
    emptyColumn: ['Nothing here', 'Nada aqui', '항목 없음'],
    moveError: ['Could not move the order', 'Não foi possível mover o pedido', '주문을 이동하지 못했습니다'],
    cardsHidden: ['+{count} more', 'mais {count}', '외 {count}건'],
  },
  Expenses: {
    title: ['Operating expenses', 'Despesas operacionais', '운영비'],
    newExpense: ['New expense', 'Nova despesa', '새 비용'],
    description: ['Description', 'Descrição', '설명'],
    amount: ['Amount', 'Valor', '금액'],
    category: ['Category', 'Categoria', '카테고리'],
    date: ['Date', 'Data', '날짜'],
    supplier: ['Supplier', 'Fornecedor', '거래처'],
    paymentMethod: ['Payment method', 'Forma de pagamento', '결제 수단'],
    notes: ['Notes', 'Observações', '메모'],
    recurring: ['Recurring', 'Recorrente', '반복'],
    recurrenceMonthly: ['Monthly', 'Mensal', '매월'],
    recurrenceWeekly: ['Weekly', 'Semanal', '매주'],
    recurrenceYearly: ['Yearly', 'Anual', '매년'],
    newCategory: ['New category', 'Nova categoria', '새 카테고리'],
    scopeNote: [
      'Operating expenses are not tied to an order. Per-order costs (product cost, shipping, fees) belong on the sale itself.',
      'Despesas operacionais não pertencem a um pedido. Custos por venda (custo do produto, frete, taxas) ficam na própria venda.',
      '운영비는 개별 주문과 무관합니다. 주문별 비용(원가·배송비·수수료)은 판매에 입력하세요.',
    ],
    emptyTitle: ['No expenses in this period', 'Nenhuma despesa neste período', '이 기간에 비용이 없습니다'],
    emptyBody: [
      'Without operating expenses, operating profit equals gross profit.',
      'Sem despesas operacionais, o lucro operacional é igual ao lucro bruto.',
      '운영비가 없으면 영업이익은 매출총이익과 같습니다.',
    ],
    created: ['Expense recorded', 'Despesa lançada', '비용이 기록되었습니다'],
    deleted: ['Expense removed', 'Despesa removida', '비용이 삭제되었습니다'],
  },
  Reports: {
    title: ['Reports', 'Relatórios', '리포트'],
    tabResult: ['Result', 'Resultado', '손익'],
    tabProducts: ['Products', 'Produtos', '상품'],
    tabSellers: ['Sellers', 'Vendedores', '판매자'],
    tabCustomers: ['Customers', 'Clientes', '고객'],
    tabExpenses: ['Expenses', 'Despesas', '비용'],
    tabStatus: ['Order status', 'Status dos pedidos', '주문 상태'],
    sortUnits: ['Most sold', 'Mais vendido', '판매량순'],
    sortRevenue: ['Highest revenue', 'Maior faturamento', '매출순'],
    sortProfit: ['Highest profit', 'Maior lucro', '이익순'],
    sortMargin: ['Highest margin', 'Maior margem', '마진 높은 순'],
    sortMarginAsc: ['Lowest margin', 'Menor margem', '마진 낮은 순'],
    sortDiscount: ['Most discounted', 'Maior desconto', '할인 많은 순'],
    units: ['Units', 'Unidades', '수량'],
    orderCount: ['Orders', 'Pedidos', '주문'],
    firstOrder: ['First purchase', 'Primeira compra', '첫 구매'],
    lastOrder: ['Last purchase', 'Última compra', '최근 구매'],
    totalSpent: ['Total spent', 'Total gasto', '총 구매액'],
    empty: ['Nothing to report for this period', 'Nada a reportar neste período', '이 기간에 표시할 내용이 없습니다'],
  },
  NewSale: {
    title: ['New sale', 'Nova venda', '새 판매'],
    customer: ['Customer', 'Cliente', '고객'],
    searchCustomer: ['Search by name or phone', 'Buscar por nome ou telefone', '이름 또는 전화번호로 검색'],
    createCustomer: ['Create "{name}"', 'Criar "{name}"', '"{name}" 생성'],
    noCustomer: ['Walk-in (no customer)', 'Sem cliente vinculado', '고객 미지정'],
    products: ['Products', 'Produtos', '상품'],
    searchProduct: ['Search a product', 'Buscar um produto', '상품 검색'],
    addLine: ['Add product', 'Adicionar produto', '상품 추가'],
    quantity: ['Qty', 'Qtd', '수량'],
    unitPrice: ['Unit price', 'Preço unitário', '단가'],
    lineDiscount: ['Discount', 'Desconto', '할인'],
    orderDiscount: ['Order discount', 'Desconto no pedido', '주문 할인'],
    shippingCost: ['Shipping cost', 'Frete', '배송비'],
    paymentFee: ['Payment fee', 'Taxa de pagamento', '결제 수수료'],
    extraCosts: ['Other costs', 'Outros custos', '기타 비용'],
    costLabel: ['Description', 'Descrição', '설명'],
    status: ['Status', 'Status', '상태'],
    notes: ['Notes', 'Observações', '메모'],
    summary: ['Summary', 'Resumo', '요약'],
    subtotal: ['Subtotal', 'Subtotal', '소계'],
    saveSale: ['Record sale', 'Registrar venda', '판매 등록'],
    needsItem: ['Add at least one product', 'Adicione ao menos um produto', '상품을 하나 이상 추가하세요'],
    discountFixed: ['R$', 'R$', '원'],
    discountPercent: ['%', '%', '%'],
    profitPreview: ['Profit on this sale', 'Lucro desta venda', '이 판매의 이익'],
  },
  Customers: {
    title: ['Customers', 'Clientes', '고객'],
    orderCount: ['Orders', 'Pedidos', '주문 수'],
    totalSpent: ['Total spent', 'Total gasto', '총 구매액'],
    avgTicket: ['Average ticket', 'Ticket médio', '평균 객단가'],
    profitGenerated: ['Profit generated', 'Lucro gerado', '창출 이익'],
    firstOrder: ['First purchase', 'Primeira compra', '첫 구매'],
    lastOrder: ['Last purchase', 'Última compra', '최근 구매'],
    productsBought: ['Products bought', 'Produtos comprados', '구매 상품'],
    orderHistory: ['Order history', 'Histórico de pedidos', '주문 내역'],
    noOrders: ['This customer has no orders yet', 'Este cliente ainda não comprou', '아직 주문이 없습니다'],
  },
};

function setDeep(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

let written = 0;

for (const locale of LOCALES) {
  const file = join(DIR, `${locale}.json`);
  // pt-BR starts as a full clone of en so every pre-existing key
  // resolves; the loop below then overwrites the commerce surface
  // with real Portuguese. Screens dropped from navigation keep their
  // English strings, which nobody sees.
  const base = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : JSON.parse(readFileSync(join(DIR, 'en.json'), 'utf8'));

  for (const [ns, keys] of Object.entries(T)) {
    for (const [key, triple] of Object.entries(keys)) {
      setDeep(base, `${ns}.${key}`, triple[IDX[locale]]);
    }
  }

  writeFileSync(file, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  written += 1;
  console.log(`wrote messages/${locale}.json`);
}

console.log(`\n${written} catalogues updated.`);
