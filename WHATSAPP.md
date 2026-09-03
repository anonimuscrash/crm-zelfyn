# Conexão WhatsApp por QR Code

```
typecheck   0 erros
lint        0 erros (39 warnings pré-existentes)
test        88 arquivos · 995 testes (22 novos)
build       compila; rotas de conexão e webhook geradas
```

---

## Por que WAHA e não Evolution API

Os dois são self-hosted, Docker-first e construídos sobre Baileys. A diferença que decidiu não é técnica:

**O Evolution API é Apache-2.0 com cláusulas de proteção de marca** — exige preservar logo e copyright e notificar o uso. Para um SaaS comercial white-label como a Operza, isso é um problema jurídico, não estético.

O WAHA é Apache-2.0 limpo, expõe REST + Swagger e permite trocar o motor (NOWEB/WEBJS/GOWS) sem mexer em quem o consome.

### Limite que você precisa saber agora

**O WAHA gratuito é de sessão única.** Múltiplos números na mesma instância exigem WAHA Plus (pago). A arquitetura aqui já suporta várias conexões — mas para usar de fato, ou você assina o Plus, ou sobe uma instância por número.

### Risco de banimento

A conexão QR usa o protocolo do WhatsApp Web, fora dos termos de uso da Meta. O risco de banimento do número **aumentou em 2025**.

Mitiga muito: nada de disparo em massa, nada de bot, volume compatível com atendimento humano — que é exatamente a política deste módulo. Mas não zera. Para número crítico de negócio, a API oficial continua sendo a opção sem esse risco, e ela **continua funcionando** aqui (§34).

---

## Arquitetura

```
WhatsApp  →  WAHA (container próprio)  →  webhook  →  Operza  →  Inbox
```

O WAHA roda **separado** da Operza, de propósito:

1. A sessão precisa sobreviver a redeploy da aplicação (§18). Junto, todo deploy do frontend derrubaria a sessão e exigiria reescanear o QR.
2. Ele carrega o motor do WhatsApp Web — acoplar isso à imagem da Operza triplicaria build e tamanho.

### Abstração de provider

```
src/services/whatsapp/
  types.ts          contrato comum
  waha-provider.ts  ÚNICO arquivo que conhece o WAHA
  webhook-auth.ts   HMAC-SHA256
  index.ts          fábrica + variáveis de ambiente
```

O contrato é **deliberadamente pobre**: só o que os dois provedores realmente fazem. Um contrato que promete mais do que o provedor entrega vira `throw new Error('not supported')` espalhado pela aplicação.

Trocar o WAHA por outro serviço = escrever um adapter novo. Inbox, mensagens e contatos não mudam.

---

## Migration 048

Reaproveita `conversations` e `messages`, que já são multi-tenant por `account_id` desde a 017. Não criei tabelas paralelas de conversa — duas fontes de verdade para "qual foi a última mensagem" é como a Inbox começa a divergir de si mesma.

`whatsapp_config` (Meta Cloud) **não foi tocada**.

Novas: `whatsapp_connections`, `whatsapp_connection_members`, `provider_message_map`, `whatsapp_events`.

### Decisões que valem explicação

**Deduplicação por `(connection_id, external_id)`**, não por id global. Dois workspaces podem receber mensagens com o mesmo id se usarem instâncias distintas, e a unicidade global rejeitaria a segunda como duplicata.

**Contato por sufixo de 8 dígitos.** No Brasil o nono dígito e o código do país aparecem de forma inconsistente conforme a origem do evento. Exigir igualdade exata criaria exatamente a duplicata que a função existe para evitar.

**`ON DELETE SET NULL` nas conversas.** Remover uma conexão não apaga conversa, cliente, pedido nem histórico (§20). Só interrompe a sincronização futura.

**Push name não sobrescreve nome digitado.** O nome que o operador escreveu vale mais que o que o cliente pôs no próprio perfil.

**Restrição de vendedor por ausência.** Sem linhas em `whatsapp_connection_members`, todo mundo atende. Exigir uma linha por vendedor faria um master individual precisar cadastrar a si mesmo antes de usar o próprio WhatsApp.

---

## Segurança do webhook

Superfície **pública, sem sessão**, que grava no banco de um cliente. Três travas:

1. **HMAC sobre o corpo cru**, antes de qualquer parse. Reserializar o JSON reordena chaves e a assinatura deixa de bater por um motivo indepurável.
2. **A conexão vem do `instance_identifier` do payload**, nunca de um `account_id` enviado pelo chamador. É isso que amarra o evento ao workspace certo.
3. **Comparação em tempo constante.** `===` sai no primeiro byte diferente, e a diferença permite adivinhar a assinatura byte a byte.

Sem `WAHA_WEBHOOK_SECRET`, o endpoint responde 503 e recusa tudo.

---

## Deploy

### 1. Subir o WAHA no Coolify

Novo recurso → **Docker Compose** → cole `docker-compose.waha.yml`.

Variável: `WAHA_API_KEY` (gere com `openssl rand -hex 32`).

**Não publique a porta 3000.** Quem tiver a URL e a chave lê as conversas de todos os workspaces. O compose usa `expose`, não `ports` — a Operza alcança pela rede interna.

Se a Operza estiver em outro projeto do Coolify, conecte os dois à mesma rede Docker.

### 2. Variáveis na Operza

| Variável | Tipo | Valor |
|---|---|---|
| `WAHA_BASE_URL` | runtime | `http://operza-waha:3000` |
| `WAHA_API_KEY` | runtime · secret | a mesma do compose |
| `WAHA_WEBHOOK_URL` | runtime | `https://seu-dominio/api/integrations/whatsapp/qr/webhook` |
| `WAHA_WEBHOOK_SECRET` | runtime · secret | `openssl rand -hex 32` |

Nenhuma é buildtime. Deixar todas em branco desabilita o modo QR e a interface some com a opção, em vez de oferecer um botão que falharia.

### 3. Migration e deploy

SQL Editor → `048_whatsapp_connections.sql` → push → Redeploy.

### 4. Conectar

Configurações → WhatsApp → nome da conexão → **Adicionar conexão** → **Conectar WhatsApp** → escaneie.

---

## O que NÃO foi feito

Sou explícito porque o briefing tem 48 seções e esta entrega cobre a fundação, não a Inbox.

**Não implementado:**

- **Inbox de três colunas** (§9, §13, §14) — a atual continua funcionando com a Meta Cloud API. O layout Conversas / Chat / Cliente com ações comerciais não existe.
- **Envio pela Inbox** (§11) — `sendMessage` está pronto no provider e testado, mas nenhuma tela o chama ainda.
- **Realtime** (§38) — hoje é polling adaptativo na tela de conexão. A Inbox precisará de Supabase Realtime.
- **Painel de vendedores por conexão** (§7) — tabela, RPC e regra prontas; falta a interface de marcar quem atende.
- **Transferência de conversa** (§31), **contador não lido consistente** (§39), **paginação de histórico** (§37).
- **Dotfy na conversa** (§16) — depende do módulo Dotfy, que não existe por falta de documentação da API.
- **Status na sidebar** (§33).

**O que funciona ponta a ponta agora:** criar conexão, gerar QR real, parear, receber mensagens com deduplicação, criar contato sem duplicar, criar conversa, atualizar a lista de conversas, desconectar e reconectar.

Ou seja: as mensagens **chegam** e ficam no banco corretamente. Falta a tela que as mostra do jeito que você desenhou.
