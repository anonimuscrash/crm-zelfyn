# WACRM → Plataforma de gestão comercial

Resumo técnico da transformação. Base: wacrm 0.8.0 (Next 16 + Supabase).

## Verificação

```
npm run typecheck   # 0 erros
npm run lint        # 0 erros (37 warnings, todos pré-existentes)
npm test            # 84 arquivos, 935 testes passando
npm run build       # compila; todas as rotas geradas
```

> O build neste ambiente só falha ao baixar a fonte Inter do Google Fonts
> (sandbox sem acesso a `fonts.googleapis.com`). Com a fonte stubada, o build
> completa e emite todas as rotas novas: `/orders`, `/kanban`, `/products`,
> `/expenses`, `/reports`. Na sua VPS isso não ocorre.

## O que foi preservado

Nada do que já funcionava foi reescrito:

- Autenticação Supabase, `getCurrentAccount` / `requireRole`, hierarquia
  `owner > admin > agent > viewer`
- Tenancy por `accounts` + `profiles.account_id`, helper `is_account_member()`
- RLS de todas as tabelas existentes
- Contatos, tags, campos personalizados, notas — reaproveitados como clientes
- Inbox, presença, convites, membros, API keys, webhooks
- Todas as 39 migrations anteriores, intactas
- Sistema de temas (light/dark × 5 acentos) e primitivas `components/ui`

## O que saiu da interface (e só da interface)

Removidos da navegação: Broadcasts, Automations, Flows, AI Agents, Pipelines.

**As rotas e as tabelas continuam existindo.** Nenhum `DROP`, nenhum dado
apagado. Reativar qualquer um é uma linha em `navSections`
(`src/components/layout/sidebar.tsx`).

O `/inbox` permaneceu, renomeado para **Atendimento** — é onde o operador
conduz a conversa e registra a venda ao lado.

## Migrations novas

### `040_commerce_core.sql`
Tabelas: `products`, `orders`, `order_items`, `order_costs`,
`expense_categories`, `operational_expenses`, `order_counters`.

Três decisões estruturais:

1. **Dinheiro é `BIGINT` em centavos.** Sem float, sem `NUMERIC`, em nenhum
   ponto do caminho do dinheiro.
2. **Totais são derivados por trigger.** `recalculate_order_totals()` recomputa
   do zero a cada escrita em `order_items`, `order_costs` ou nos campos de
   entrada de `orders`. O cliente nunca envia total.
3. **Snapshot em `order_items`.** Preço, custo, nome e SKU congelados na venda.
   Alterar o preço de um produto reprecifica só vendas futuras.

Todas as políticas RLS usam `is_account_member(account_id, min_role)`.

### `041_commerce_analytics.sql`
RPCs: `commerce_dashboard_metrics`, `commerce_sales_series`,
`commerce_product_ranking`, `commerce_expense_breakdown`,
`commerce_seller_performance`, `commerce_customer_stats`,
`commerce_create_order`.

São `SECURITY DEFINER`, então `assert_account_access()` é a **primeira linha**
de cada corpo de função. Essa é exatamente a classe de bug do
GHSA-63cv-2c49-m5v3 deste repo (id vindo do caller + execução privilegiada) —
guardada explicitamente, não delegada à rota.

`commerce_create_order` grava cabeçalho + itens + custos numa transação só, e
aloca o número do pedido no servidor.

## Módulos novos

```
src/lib/commerce/
  money.ts             centavos, parsing pt-BR/en-US, formatação BRL
  calculations.ts      espelho exato do trigger SQL (preview ao vivo)
  periods.ts           presets de período, janelas semiabertas, comparação
  order-status.ts      vocabulário de status + metadados visuais
  validation.ts        validação server-side de todo valor monetário
  types.ts             tipos de linha e DTOs
  products.repo.ts | orders.repo.ts | expenses.repo.ts | analytics.repo.ts
  http.ts              mapeamento de erro e parsing de query

src/hooks/use-commerce.ts          fetch com abort, período, mutação
src/components/commerce/           primitivas, gráfico, drawers
```

## Rotas de API

```
GET|POST        /api/commerce/products
GET|PATCH|DELETE /api/commerce/products/[id]
GET|POST        /api/commerce/orders          (?view=board para o Kanban)
GET|PATCH|DELETE /api/commerce/orders/[id]
GET|POST        /api/commerce/expenses
PATCH|DELETE    /api/commerce/expenses/[id]
GET|POST        /api/commerce/expense-categories
GET             /api/commerce/metrics
GET             /api/commerce/reports
GET             /api/commerce/customers
```

## Telas

| Rota | Conteúdo |
|---|---|
| `/dashboard` | KPIs, DRE em dois estágios, gráfico, ranking, envio, despesas |
| `/orders` | Tabela com custo, lucro, margem, vendedor; filtros compostos |
| `/kanban` | 10 colunas, drag-and-drop que persiste status real |
| `/products` | Catálogo com coluna de margem; form com aviso de snapshot |
| `/expenses` | Despesas operacionais + aviso de escopo |
| `/reports` | 6 abas sobre a mesma janela |

Nova venda é um drawer global, acessível de `/dashboard`, `/orders` e `/kanban`.

## Cálculos

`calculateOrder` implementa, na mesma ordem do SQL:

```
subtotal = bruto − descontos de item
desconto do pedido incide sobre o SUBTOTAL (não sobre o bruto)
líquido = subtotal − desconto do pedido
custos diretos = CMV + frete + taxa + outros
lucro = líquido − custos diretos
```

O desconto de pedido sobre o subtotal já líquido é o ponto que impede
desconto duplo — é como a dashboard para de bater com a lista de pedidos.

DRE em dois estágios (`calculateProfitAndLoss`):

```
líquido − custos diretos       = lucro bruto
lucro bruto − despesas op.     = lucro operacional
```

## Testes

113 testes só na camada comercial. Dois merecem destaque:

- `order-status.test.ts` lê `040_commerce_core.sql` e falha se a lista de
  status em TypeScript divergir do CHECK constraint ou de
  `order_status_is_revenue()`.
- `validation.test.ts` garante que `parseOrderPatch` **recusa** qualquer
  tentativa de gravar total derivado. Ninguém lança margem fabricada pela API.

## i18n

`messages/pt-BR.json` criado e adicionado à paridade obrigatória
(`src/i18n/messages.test.ts` agora valida `ko` e `pt-BR`).

Os três catálogos são gerados de uma tabela única:

```bash
npm run i18n:build
```

Edite `scripts/build-i18n.mjs` — nunca os três JSON à mão.

Defina `NEXT_PUBLIC_APP_LOCALE=pt-BR` no ambiente.

## Deploy

Inalterado. Continua Next standalone em VPS/Coolify com Supabase.

```bash
npm install
npm run i18n:build
npm run build
npm start
```

Aplique `040` e `041` no Supabase **antes** de subir a build:

```bash
supabase db push
```

Nenhuma variável de ambiente nova além de `NEXT_PUBLIC_APP_LOCALE`.
`META_APP_SECRET` continua necessária só se você mantiver o webhook ativo.

## Não implementado

- **Wrapper Electron (§20/21).** A arquitetura web não impede — nada acoplou
  o app a um shell desktop. Mas o wrapper em si não foi escrito.
- **Busca global com atalho (§23).**
- **Exportação PDF de relatórios (§19)** — explicitamente adiada pelo próprio
  briefing em favor de informação correta primeiro.
- **Painel comercial dentro de `/contacts`.** O endpoint
  `/api/commerce/customers?contactId=` existe e retorna estatísticas, pedidos e
  produtos comprados; falta plugá-lo na tela de contatos.
- **Categorias de despesa personalizadas** têm endpoint, faltam na UI.
