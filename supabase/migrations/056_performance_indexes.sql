-- ============================================================
-- 056_performance_indexes.sql
--
-- Índices para as consultas que ficaram lentas.
--
-- O QUE ESTAVA ERRADO
-- -------------------
-- `resolve_whatsapp_contact` procura o contato assim:
--
--   WHERE account_id = ... AND RIGHT(normalize_phone(phone), 8) = ...
--
-- Função aplicada SOBRE a coluna impede o uso de qualquer índice
-- comum — o `idx_contacts_phone` que existe é inútil aqui. O
-- resultado é varredura completa de `contacts` A CADA MENSAGEM
-- RECEBIDA, e o custo cresce com a base.
--
-- A Inbox tem o mesmo padrão: filtra por conta e ordena por última
-- mensagem, com índices separados em cada coluna. O Postgres usa um
-- e ordena o resto na memória.
--
-- Só CREATE INDEX. Nenhum dado é alterado.
--
-- CONCURRENTLY é omitido de propósito: o Supabase roda migrations em
-- transação, e `CREATE INDEX CONCURRENTLY` não funciona dentro de
-- uma. As tabelas ainda são pequenas o bastante para o lock ser
-- imperceptível.
-- ============================================================

-- ============================================================
-- CONTATOS — busca por sufixo de telefone
--
-- Índice de EXPRESSÃO: indexa o resultado da função, que é
-- exatamente o que a consulta compara. Possível porque
-- `normalize_phone` é IMMUTABLE.
--
-- Este é o índice que mais importa aqui: transforma a varredura por
-- mensagem recebida numa busca direta.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_contacts_phone_suffix
  ON contacts (account_id, RIGHT(normalize_phone(phone), 8))
  WHERE phone IS NOT NULL;

-- Busca por nome na tela de clientes.
CREATE INDEX IF NOT EXISTS idx_contacts_account_name
  ON contacts (account_id, name);

-- ============================================================
-- CONVERSAS — lista da Inbox
--
-- Composto e com a ordenação embutida: `DESC NULLS LAST` casa com o
-- ORDER BY da lista, então o Postgres lê o índice na ordem certa e
-- não ordena nada.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_conversations_account_last_message
  ON conversations (account_id, last_message_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_conversations_account_status
  ON conversations (account_id, status, last_message_at DESC NULLS LAST);

-- Contador de não lidas. Parcial: a maioria das conversas tem zero,
-- e indexar zeros gastaria espaço sem servir a consulta.
CREATE INDEX IF NOT EXISTS idx_conversations_unread
  ON conversations (account_id)
  WHERE unread_count > 0;

-- ============================================================
-- MENSAGENS — thread de uma conversa
--
-- `idx_messages_conversation` existe, mas sem a data: para abrir uma
-- conversa o Postgres busca todas as mensagens dela e depois ordena.
-- Com a data no índice, ele lê já ordenado e para nas primeiras.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);

-- Métricas de atendimento por vendedor.
CREATE INDEX IF NOT EXISTS idx_messages_sender
  ON messages (sent_by_user_id, created_at DESC)
  WHERE sent_by_user_id IS NOT NULL;

-- ============================================================
-- WHATSAPP
-- ============================================================

-- Deduplicação: consultada a cada mensagem recebida.
CREATE INDEX IF NOT EXISTS idx_provider_msg_map_account
  ON provider_message_map (account_id, created_at DESC);

-- Log técnico, lido do mais recente para trás.
CREATE INDEX IF NOT EXISTS idx_wa_events_account_created
  ON whatsapp_events (account_id, created_at DESC);

-- ============================================================
-- PAGAMENTOS
-- ============================================================

-- Cobranças pendentes: consultadas ao abrir uma conversa. Parcial,
-- porque cobrança paga não precisa aparecer nessa busca.
CREATE INDEX IF NOT EXISTS idx_charges_pending
  ON payment_charges (account_id, created_at DESC)
  WHERE status = 'pending';

-- ============================================================
-- AUDITORIA
--
-- Cresce indefinidamente por ser append-only, e o painel admin lê
-- sempre as mais recentes.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_account_created
  ON audit_logs (account_id, created_at DESC)
  WHERE account_id IS NOT NULL;

-- ============================================================
-- ESTATÍSTICAS
--
-- O planejador escolhe o plano com base nelas. Depois de criar
-- índices novos, rodar ANALYZE evita que ele continue usando o plano
-- antigo até a próxima coleta automática.
-- ============================================================
ANALYZE contacts;
ANALYZE conversations;
ANALYZE messages;
ANALYZE orders;
ANALYZE payment_charges;
