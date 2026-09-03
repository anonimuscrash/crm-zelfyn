# Painel Platform Admin

## Verificação

```
typecheck   0 erros
lint        0 erros (39 warnings pré-existentes)
test        87 arquivos · 973 testes passando
build       compila; /admin, /admin/customers e as 3 rotas de API geradas
```

---

## Aplicar

SQL Editor → `047_platform_admin.sql`

Depois, promova seu usuário — **só por SQL, de propósito**. Não existe endpoint que crie essa linha:

```sql
insert into platform_admins (user_id, note)
select id, 'fundador' from auth.users where email = 'kauam1024@gmail.com';
```

Faça logout e login de novo. Você cai direto em `/admin`.

Para voltar ao CRM: link "Voltar ao app" no topo. E a sidebar do CRM ganha um item "Operza Admin" no rodapé, visível só para você.

---

## A superfície mais perigosa do sistema

Todas as RPCs de 041–046 gateiam por pertencimento a **um** tenant. As funções de 047 são as **únicas** que leem através de tenants.

Um erro aqui não vaza dado de um vendedor para outro — vaza de um cliente inteiro para outro. Por isso:

- `assert_platform_admin()` é a **primeira linha** de cada corpo, sem exceção. A auditoria automática verifica isso.
- As funções devolvem **agregados**, nunca linhas de pedido. O admin vê que um cliente processou 340 pedidos e R$ 88 mil; não vê o que foi vendido, para quem, nem por qual produto (§53).
- Nenhuma função aceita `p_account_id` para "espiar" um tenant específico.

O guard da API retorna **404, não 403**: para quem não é admin, a área administrativa não deve nem confirmar que existe.

---

## Bloqueio de contas

`platform_set_account_status()` troca uma coluna. **Não apaga nada.** Registra quem, quando, o status anterior e o motivo, e grava em `audit_logs`.

Duas travas contra o admin se trancar para fora:

- Não é possível bloquear a própria conta
- Não é possível bloquear a conta de outro platform admin

Ambas ficam na RPC, não na rota — uma rota pode ser reescrita, a função do banco continua recusando.

O log de bloqueio grava `account_id = NULL`: é ação **da plataforma sobre** um tenant, não dentro dele. Assim o master não lê no próprio log que foi bloqueado e por quem.

### O que o cliente vê

Master e vendedores de conta bloqueada caem em `/account-blocked`. As policies de 045 já recusavam escrita de conta inativa, então a API também para — não é bloqueio só de tela.

---

## Telas

**`/admin`** — contas (total, ativas, suspensas, bloqueadas, novas), usuários (total, vendedores, novos, ativos), volume e pedidos no período e acumulado, gráfico de crescimento com quatro séries alternáveis, e atividade recente do audit log.

"Usuário ativo" = registrou ao menos uma venda no período. Presença de sessão mede aba aberta, que não é sinal de uso.

**`/admin/customers`** — lista de contas Master com titular, tamanho, uso, volume, última atividade e status. Busca com debounce, filtro por status, paginação, e o diálogo de mudança de status.

---

## Decisões de gráfico

O crescimento usa **barras, não linha**: é contagem por período, e uma linha ligando contagens discretas sugere continuidade que não existe entre um dia e o outro.

As quatro séries **alternam** em vez de sobrepor. Contas novas (unidades) e volume (reais) no mesmo eixo produziriam uma linha colada no zero e outra no topo. Eixo duplo resolveria, mas é notoriamente fácil de ler errado.

---

## O que falta

- **Detalhe do cliente** ao clicar na linha — histórico de status, membros, evolução
- **Filtro de período** na lista de clientes (hoje o volume é acumulado)
- Impressão, estoque, comissões, Kanban editável, Dotfy
