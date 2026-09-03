# Operza — evolução para plataforma SaaS

Estado da entrega desta sessão. Base: wacrm 0.8.0 já com o módulo comercial (migrations 040–044).

## Verificação

```
typecheck   0 erros
lint        0 erros (37 warnings, todos pré-existentes)
test        85 arquivos · 957 testes passando
build       compila, todas as rotas geradas
```

O build no sandbox só falha ao baixar a fonte Inter do Google Fonts (domínio fora da allowlist). Com a fonte stubada, completa. Na sua VPS não ocorre.

---

## 1. Branding Operza — COMPLETO

**Assets derivados da logo oficial**, não redesenhados. Extraí o símbolo pelo canal alfa e gerei os ícones por reamostragem Lanczos do original:

```
public/branding/
  operza-logo.png        2040×582  original recortado
  operza-logo@2x.png      560×160  sidebar e login
  operza-symbol.png       308×329  símbolo isolado
  favicon.ico                      multi-resolução 16/32/48/64
  favicon-16x16.png
  favicon-32x32.png
  apple-touch-icon.png    180×180  fundo branco (iOS ignora alfa)
  icon-192.png
  icon-512.png
```

**`src/lib/branding.ts`** — ponto único de verdade. Nome, template de título, caminhos de asset, proporções nativas e cores. As cores foram **amostradas do PNG** (`#21272D` grafite, `#2A6EB8` azul), não escolhidas de memória — um azul "parecido" ao lado da logo real fica visivelmente errado.

**Aplicado em:** sidebar (logo, sem texto duplicado ao lado do wordmark), login, tela de carregamento, conta bloqueada, favicon, metadata, Open Graph, themeColor.

Sem filtro CSS no dark mode. O grafite já tem contraste sobre o fundo escuro, e `invert()` viraria o azul institucional em laranja.

**Catálogos:** 14 referências a "wacrm" e "CRM Template for WhatsApp" substituídas em `en.json` e `pt-BR.json`.

Ficaram intencionalmente: `wacrm.theme` e `wacrm.mode` (localStorage — renomear invalidaria o tema salvo de todos os usuários) e o prefixo `wacrm_live_` de API keys (quebraria chaves já emitidas).

---

## 2. Fundação SaaS — migration 045

### Decisão: reaproveitar `accounts`, não criar `workspaces`

O briefing sugere criar workspaces. **Não criei, de propósito.**

A tabela `accounts` já É o workspace: tem `owner_user_id`, `profiles.account_id` liga membros, `profiles.account_role` guarda o papel, e `is_account_member()` gateia as 40+ policies existentes.

Criar `workspaces` ao lado significaria dois conceitos de tenant convivendo, duas fontes de verdade para "de quem é este pedido", e a certeza de que uma delas seria esquecida numa policy futura. Isso não é economia de trabalho — é a diferença entre um isolamento que se sustenta e um que vaza no primeiro recurso novo.

### Mapeamento de papéis

| Produto | Banco |
|---|---|
| `platform_admin` | tabela `platform_admins` (fora de accounts) |
| `master` | `profiles.account_role IN ('owner','admin')` |
| `seller` | `profiles.account_role = 'agent'` |

Sem coluna de papel duplicada.

`platform_admins` fica **fora** de `accounts` porque um admin da plataforma não pertence a tenant nenhum. Se fosse uma linha em `profiles` com papel especial, toda policy que testa `is_account_member()` passaria a ter um bypass implícito — e bypass implícito espalhado por 40 policies é como vazamento entre tenants acontece.

### Tabelas novas

- `platform_admins` — promoção só por SQL Editor, sem endpoint
- `account_settings` — feature flags, plano, visibilidade de clientes
- `audit_logs` — **append-only por construção** (existe policy de INSERT e SELECT, nenhuma de UPDATE/DELETE)

### Colunas novas em `accounts`

`status` (`active`/`suspended`/`blocked`), `status_reason`, `status_changed_at`, `status_changed_by`. Via `ADD COLUMN IF NOT EXISTS`, que no Postgres 11+ não reescreve a tabela.

### Isolamento por vendedor — a parte crítica

As policies de 040 liberavam SELECT para qualquer membro. Foram **substituídas** por versões que adicionam a condição de vendedor:

- `orders` — master vê tudo do workspace; seller vê só `seller_user_id = auth.uid()`
- `order_items` — **mesma regra**. Sem isso o isolamento vazaria pela porta dos fundos: um vendedor listaria os itens de todo o workspace e reconstruiria o faturamento dos colegas somando as linhas
- `order_costs` — idem
- `products` — só master cria e edita. Um vendedor que pudesse baixar o custo cadastrado inflaria o próprio lucro em todos os relatórios
- `operational_expenses` — só master lê e escreve

Toda policy de **escrita** exige `account_is_active()`. Uma conta bloqueada para de gravar pela API, não só pela interface.

Um vendedor também **não escolhe o próprio `seller_id`**: a policy de INSERT exige `seller_user_id = auth.uid()` para quem não é master.

### RPC `session_context()`

Uma chamada devolve papel, status da conta e todas as flags. Substitui três round trips no caminho crítico do login.

---

## 3. Aplicação

**`src/lib/auth/permissions.ts`** — predicados de papel e permissões. Cada `can*()` tem policy RLS correspondente. Se alguém remover a checagem do frontend, o pior caso é um 403 feio; se remover a policy, vaza dado. Por isso a policy é a verdade.

**22 testes** cobrindo o que o vendedor não pode fazer, o comportamento de conta bloqueada e o roteamento por papel.

**Login com roteamento por papel:** `platform_admin` → `/admin`, conta bloqueada → `/account-blocked`, resto → `/dashboard`. Se a RPC falhar, cai em `/dashboard` — o shell e as policies reavaliam de qualquer forma, então o pior caso é um salto a mais, nunca acesso indevido.

**`/account-blocked`** — deliberadamente pobre em informação: não distingue suspenso de bloqueado, não diz quem bloqueou nem por quê. Quem chega ali pode não ser o titular. Diz explicitamente que os dados foram preservados, porque é a primeira dúvida de quem vê a tela.

---

## Como aplicar

1. Supabase → SQL Editor → cole `045_saas_foundation.sql` → Run
2. Commit e push do código
3. Redeploy no Coolify

Nenhuma variável de ambiente nova.

### Promovendo um platform admin

Só por SQL, de propósito — não existe endpoint que crie essa linha:

```sql
insert into platform_admins (user_id, note)
select id, 'fundador' from auth.users where email = 'seu@email.com';
```

### Ativando modo equipe

```sql
update account_settings set team_enabled = true
where account_id = (select account_id from profiles where user_id = auth.uid());
```

Contas que já tinham mais de um membro receberam `team_enabled = true` automaticamente no backfill.

---

## O que NÃO foi feito

Sou explícito porque o briefing tem 97 seções e esta sessão cobriu duas.

- **Painel `/admin`** — a rota não existe ainda. O papel, a RPC e as permissões estão prontos; falta a interface (dashboard de métricas da plataforma, lista de clientes, bloqueio pela UI).
- **Gestão de equipe** — criar/desativar vendedor, painel de equipe, ranking de vendedores, detalhe do vendedor.
- **Seletor de vendedor no dashboard** — `canFilterBySeller()` existe; falta o dropdown e o parâmetro nas RPCs de analytics.
- **Integração Dotfy** — **não implementei nada, por decisão.** Nenhuma documentação da API foi fornecida, e o próprio briefing diz "NÃO invente rotas da Dotfy". Inventar endpoints daria a impressão de funcionalidade pronta que quebraria na primeira chamada real. Me mande a documentação e eu construo.
- **Sistema de impressão** — fila, configuração, layout, print agent.
- **Estoque com ledger** — movimentações, decremento atômico, estorno.
- **Comissões** — só o campo de flag existe.
- **Kanban editável** — colunas ainda são fixas no código.
- **Onboarding "individual ou equipe"** — a flag existe, a tela não.
- **Testes de RLS multi-tenant** (§73/74) — exigem um Postgres real com dois tenants; os testes atuais cobrem a camada de permissões em TypeScript, não as policies.

O que está entregue é a fundação de que todo o resto depende: sem papéis e isolamento corretos, construir admin, equipe e comissões em cima seria construir sobre areia.
