# Gestão de equipe + tema Operza

## Verificação

```
typecheck   0 erros
lint        0 erros (38 warnings pré-existentes)
test        86 arquivos · 969 testes passando
build       compila; /team e /api/commerce/team gerados
```

---

## Migrations a aplicar (nesta ordem)

1. `045_saas_foundation.sql` — se ainda não aplicou
2. `046_team_management.sql`

Ambas só criam ou substituem funções. Nada existente é alterado.

---

## Tema Operza

O rosa vinha do seletor de acento do wacrm. Em vez de forçar cor no CSS, criei um tema próprio:

- `#2A6EB8` — o pixel exato da logo — convertido para OKLCH: `oklch(0.533 0.135 253)`
- Registrado em `THEME_IDS` e definido como `DEFAULT_THEME`
- Segunda série do gráfico usa o mesmo matiz mais claro, não uma cor concorrente

**Quem já escolheu um acento mantém a escolha** — o valor em `localStorage` vence o default. Para trocar: Settings → aparência → Operza.

---

## Recorte por vendedor

As RPCs de analytics ganharam `p_seller_id UUID DEFAULT NULL`. `NULL` = conta inteira.

**Parâmetro opcional, não funções paralelas.** Duplicar cada função numa versão `_by_seller` dobraria a manutenção e garantiria que uma correção futura fosse aplicada só numa das cópias.

**A chamada não é confiável.** Cada função passa por `resolve_seller_scope()`, que ignora o `p_seller_id` recebido e força `auth.uid()` quando o chamador não é master. Um vendedor que edite a query string recebe os próprios números, não os do colega. A decisão é do banco, não da rota — a rota pode ser reescrita, a policy não.

### Despesas não são rateadas

Na visão de um vendedor, `operating_expenses_cents` vem zero e o lucro operacional iguala o bruto. Ratear marketing e aluguel entre vendedores exigiria uma política de alocação que é decisão de negócio; escolher uma em silêncio produziria um "lucro do João" que ninguém consegue auditar.

A interface reflete isso: no modo individual o card muda para **Lucro bruto** e o segundo estágio do DRE some. Rotular igual nos dois modos faria o número parecer comparável quando não é.

---

## Painel de equipe — `/team`

`commerce_team_overview()` devolve, por membro: papel, entrada, última venda, e no período — pedidos, faturamento, lucro, ticket, unidades, descontos — mais um recorte de hoje.

**Inclui quem não vendeu** (LEFT JOIN). Um vendedor com zero vendas é justamente a linha que o dono precisa ver.

Ranking ordenável por faturamento, lucro, pedidos, ticket e margem. Coluna de variação vs. período anterior.

Três estados tratados:

| Situação | Comportamento |
|---|---|
| Vendedor abre `/team` | Redirect silencioso para `/dashboard` |
| Master sem modo equipe | Tela de ativação, não tabela vazia |
| Master com equipe | O painel |

O item na sidebar só aparece para master com `team_enabled`. Isso é higiene de interface, não segurança — a rota redireciona e a RPC recusa de qualquer forma.

---

## Seletor no dashboard

Dropdown "Visão: Geral / Meu desempenho / [vendedores]". Renderiza **nada** quando não faz sentido — vendedor não tem escolha, e master sem equipe teria um dropdown de um item.

Trocar o valor refaz a consulta no banco com o `seller_id`. Não é filtro visual.

---

## Configurações do workspace

`PATCH /api/commerce/settings` com as feature flags. Só master. Toda alteração grava em `audit_logs` — ligar o modo equipe muda quem enxerga o quê, então precisa de registro.

Para ativar por SQL, se preferir:

```sql
update account_settings set team_enabled = true
where account_id = (select account_id from profiles where user_id = auth.uid());
```

---

## Como adicionar um vendedor

Reaproveita o sistema de convites que já existia — não construí um paralelo.

**Settings → Members → Invite**, com papel **agent**. A pessoa recebe o link, define a própria senha e entra já isolada: vê só as próprias vendas, não edita produto nem preço, não acessa despesas.

O botão "Adicionar vendedor" em `/team` leva direto para lá.

---

## i18n

Namespace `Team` com 33 chaves nos três catálogos. Também corrigi "Notifications" e "Settings", que tinham ficado em inglês na sidebar.

Lembre: os catálogos são gerados de `scripts/build-i18n.mjs`. Editar os JSON à mão quebra o teste de paridade.

---

## O que ainda falta

- **Detalhe do vendedor** (§47) — clicar numa linha e abrir o perfil com histórico próprio. Hoje a linha não é clicável; o seletor do dashboard já dá a visão individual.
- **Desativar vendedor pelo painel** — hoje é via Settings → Members.
- **Comissões** — só a flag existe.
- **Painel `/admin`**, impressão, estoque, Kanban editável, Dotfy.
