# Operza — relatório de status

Mapeamento do que foi entregue contra os três briefings enviados: o comercial (43 seções), o SaaS (97 seções) e o de marca.

Data: 26/08/2026 · Migrations 040–047 · 973 testes passando

---

## Panorama

| Briefing | Concluído | Parcial | Não iniciado |
|---|---|---|---|
| Comercial (43 seções) | 34 | 4 | 5 |
| SaaS (97 seções) | 41 | 9 | 47 |
| Marca Operza | 12 | 1 | 0 |

O número do SaaS parece baixo, mas boa parte das 47 restantes são quatro módulos grandes (Dotfy, impressão, estoque, comissões) que se desdobram em muitas seções cada.

---

# PARTE 1 — Briefing comercial

## Concluído

### Banco (§2, §30, §31)
- Migrations 040–044, todas incrementais
- Zero `DROP`, `RENAME` ou `ALTER` em estrutura pré-existente
- Contatos reaproveitados como clientes, sem tabela paralela
- Tabelas novas: `products`, `orders`, `order_items`, `order_costs`, `expense_categories`, `operational_expenses`, `order_counters`

### Preservação (§3)
Autenticação, Supabase, tenancy por `accounts`, RLS, contatos, tags, campos personalizados, inbox, convites, membros, API keys, temas — tudo intacto.

### Limpeza de interface (§4)
Broadcasts, Automations, Flows, AI Agents e Pipelines saíram da navegação. **Rotas e tabelas continuam existindo** — reativar é uma linha em `navSections`.

### Navegação (§5)
Dashboard · Atendimento · Pedidos · Kanban · Produtos · Clientes · Despesas · Relatórios · Equipe · Configurações

### Dashboard (§6, §7, §8, §38)
Todos os 18 indicadores pedidos. Sete presets de período mais personalizado, todos resolvendo janela real no banco. Gráfico com cinco métricas alternáveis, granularidade adaptativa e comparação com período anterior.

### Produtos (§9)
Cadastro completo com coluna de margem. Snapshot de preço e custo na venda — alterar preço não reescreve histórico. Garantido pelo schema, não por disciplina.

### Venda e cálculos (§10, §11, §12)
Drawer rápido, múltiplos produtos, desconto fixo ou percentual, cálculo ao vivo antes de salvar.

Desconto de pedido incide sobre o subtotal **já líquido** dos descontos de item — errar isso é como a dashboard para de bater com a lista de pedidos.

### Kanban (§13)
Dez colunas, drag-and-drop que persiste status real, rollback visível se a escrita falhar.

### Pedidos, ranking, despesas, relatórios (§14–§19)
Tabela com filtros compostos no servidor. Ranking com seis ordenações. Despesas com categorias. Seis abas de relatório.

### Separação custo vs. despesa (§18)
DRE em dois estágios. Estrutural, não convencional: `operational_expenses` não tem relação com `orders`.

### Precisão financeira (§29, §36)
`BIGINT` em centavos. Nenhum float no caminho do dinheiro. 113 testes só no núcleo financeiro.

### Qualidade e segurança (§26, §27, §35)
Camadas separadas. Totais derivados por trigger — cliente nunca envia total. Validação server-side de todo valor monetário. RLS em todas as tabelas novas.

### Sem dados fictícios (§32, §33, §34)
Nenhum `Math.random()`, nenhuma métrica hardcoded. Estados vazios com orientação real.

## Parcial

| § | Item | Estado |
|---|---|---|
| 16 | Clientes | Endpoint `/api/commerce/customers?contactId=` pronto com estatísticas, pedidos e produtos comprados. **Falta plugar na tela de contatos.** |
| 19 | Relatórios | Seis abas funcionando. Sem exportação PDF — adiada pelo próprio briefing. |
| 23 | Busca global | Busca existe por tela. Sem busca unificada com atalho de teclado. |
| 25 | Responsividade | Desktop e notebook completos. Mobile funciona mas não foi testado em dispositivo real. |

## Não iniciado

| § | Item |
|---|---|
| 20, 21 | Wrapper Electron com WhatsApp lado a lado |
| 21 | Tela "Atendimento" própria (hoje é o `/inbox` renomeado) |
| 22 | Criar cliente sem sair do formulário de venda |

---

# PARTE 2 — Briefing SaaS

## Concluído

### Arquitetura de contas (§3, §50)
Três papéis. `platform_admin` numa tabela própria, fora de `accounts`; `master` = owner/admin; `seller` = agent.

**Não criei `workspaces`.** `accounts` já é o workspace. Duas tabelas de tenant significariam duas fontes de verdade para "de quem é este pedido", e a certeza de que uma seria esquecida numa policy futura.

### Login único e roteamento (§4, §51)
Um login. Consulta `session_context()` e roteia: platform_admin → `/admin`, conta bloqueada → `/account-blocked`, resto → `/dashboard`.

### Painel administrativo (§5, §6, §52, §53)
`/admin` com contas, usuários, volume, gráfico de crescimento e atividade recente. `/admin/customers` com busca, filtro, paginação e mudança de status.

Métricas são **agregadas**. O admin vê que um cliente processou 340 pedidos; não vê o que foi vendido nem para quem.

### Bloqueio de contas (§7)
Três status. Registra quem, quando, status anterior e motivo. Grava em `audit_logs`. **Não apaga nada.**

Duas travas na RPC: não bloqueia a própria conta, não bloqueia outro platform admin.

Conta bloqueada para de gravar **pela API**, não só pela tela.

### Multi-tenant e isolamento (§10, §16, §49)
Vendedor vê apenas as próprias vendas. Cobre `orders`, `order_items` **e** `order_costs` — sem os dois últimos, um vendedor listaria os itens do workspace e reconstruiria o faturamento dos colegas somando as linhas.

Vendedor não escolhe o próprio `seller_id`: a policy de INSERT exige `seller_user_id = auth.uid()` para quem não é master.

Produtos e despesas: só master.

### Dashboards e filtro por vendedor (§11, §12, §13, §14, §42)
Seletor "Visão: Geral / Meu desempenho / [vendedores]". Trocar refaz a consulta no banco com `seller_id`. Não é filtro visual.

O banco **ignora** o `seller_id` recebido e força `auth.uid()` quando o chamador não é master.

### Painel de equipe e ranking (§15, §46)
`/team` com ranking ordenável por faturamento, lucro, pedidos, ticket e margem, variação vs. período anterior. Inclui quem não vendeu.

### Feature flags (§55, §56, §57)
`team_enabled`, `inventory_enabled`, `printing_enabled`, `commissions_enabled`, `payments_enabled`. Modo individual esconde equipe, ranking e filtro por vendedor.

### Log de auditoria (§48)
`audit_logs` **append-only por construção**: existe policy de INSERT e SELECT, nenhuma de UPDATE ou DELETE.

### Estrutura de planos (§54)
Campos `plan` e `max_sellers` prontos. Sem cobrança — como pedido.

### Build e deploy (§87, §88, §89, §90)
Compila, Docker preservado, Coolify compatível, migrations só incrementais.

## Parcial

| § | Item | Estado |
|---|---|---|
| 8, 9 | Modo individual/equipe | Flag e comportamento prontos. **Falta a tela de onboarding** perguntando "como pretende utilizar". Hoje ativa-se em `/team`. |
| 10 | Contas de vendedor | Criação via convite (Settings → Members). Sem tela dedicada. |
| 37 | Visibilidade de clientes | Campo `customer_visibility` existe. **Regra não aplicada nas queries** — hoje é sempre compartilhado. |
| 47 | Detalhe do vendedor | Seletor do dashboard dá a visão individual. Linha do ranking não é clicável. |
| 58 | Permissões granulares | Papéis funcionam. Sem ACL por capacidade. |
| 59 | Master escolher vendedor na venda | Backend aceita `seller_user_id`. Falta o campo no drawer. |
| 73, 74 | Testes de segurança | 973 testes cobrem permissões em TypeScript. **RLS multi-tenant não tem teste automatizado** — exigiria Postgres real com dois tenants. |
| 43, 44 | Gráficos e comparação | Feitos no CRM e no admin. Falta gráfico por vendedor. |
| 65 | Logos | Aplicadas. Falta na impressão (módulo não existe). |

## Não iniciado

### Dotfy (§25–§29, §75, §76, §77)
**Nada implementado, por decisão.** Nenhuma documentação da API foi fornecida, e o briefing diz "NÃO invente rotas da Dotfy". Endpoints inventados dariam aparência de funcionalidade pronta que quebraria na primeira chamada real — e você descobriria em produção.

Falta: credenciais criptografadas, geração de cobrança, PIX/QR, webhook de status, tratamento de erro, UX de pagamento.

**Me mande a documentação e eu construo.**

### Impressão (§31–§35, §79)
Configuração, fila `print_jobs`, modelo de ficha, os três métodos (navegador, agente local, IPP).

### Estoque (§21, §23, §60, §62)
Ledger de movimentações, decremento atômico, estorno, histórico.

Existe apenas `products.stock_quantity` como número solto, sem histórico — que é justamente o que o §60 pede para evitar.

### Kanban editável (§18, §19)
Colunas fixas no código. Falta criar, renomear, reordenar, cor, coluna padrão, status final e cancelado por workspace.

### Comissões (§40)
Só a flag existe. Falta configuração e cálculo.

---

# PARTE 3 — Marca Operza

## Concluído

Assets derivados do PNG oficial por extração do canal alfa e reamostragem Lanczos. **Nada redesenhado.**

```
public/branding/
  operza-logo.png · operza-logo@2x.png · operza-symbol.png
  favicon.ico · favicon-16x16 · favicon-32x32
  apple-touch-icon · icon-192 · icon-512
```

`src/lib/branding.ts` como ponto único. Cores **amostradas do PNG** (`#21272D`, `#2A6EB8`), não escolhidas a olho.

Tema Operza registrado e definido como padrão — o azul convertido para `oklch(0.533 0.135 253)`.

Aplicado em: sidebar, login, carregamento, conta bloqueada, painel admin, favicon, metadata, Open Graph, themeColor.

Sem filtro CSS no dark mode: o grafite já tem contraste, e `invert()` viraria o azul institucional em laranja.

14 referências ao branding antigo substituídas nos catálogos.

## Ressalva deliberada

Duas strings mantêm o nome antigo e **não aparecem para o usuário**:

- `wacrm.theme` / `wacrm.mode` no localStorage — renomear invalidaria o tema salvo de todos
- Prefixo `wacrm_live_` de API keys — quebraria chaves já emitidas

---

# Estado técnico

```
migrations   040–047 (8 novas, todas incrementais)
tabelas      10 novas, nenhuma existente alterada
rotas        11 telas + 15 endpoints
testes       87 arquivos · 973 passando
typecheck    0 erros
lint         0 erros
build        compila
```

## Um ponto que merece atenção

**Não existe teste automatizado de RLS multi-tenant** (§73/74). Auditei as policies por leitura e por script, e a arquitetura foi desenhada para que o isolamento seja estrutural. Mas leitura não substitui execução.

Para testar de verdade seria preciso um Postgres com dois tenants reais, criando usuário A e B e verificando que A não lê nada de B. É trabalho de meio dia e a única forma de ter certeza. Recomendo fazer antes de colocar o segundo cliente na plataforma.

---

# Sugestão de ordem

1. **Impressão** — operacional, você usa todo dia, independe de terceiros
2. **Estoque com ledger** — o `stock_quantity` atual não tem histórico e vai virar problema
3. **Dotfy** — assim que tiver a documentação; destrava o fluxo de pagamento inteiro
4. **Testes de RLS** — antes do segundo cliente
5. Kanban editável, comissões, onboarding
