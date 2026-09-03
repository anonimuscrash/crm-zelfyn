-- ============================================================
-- 058_connection_isolation.sql
--
-- FALHA DE ISOLAMENTO: vendedor não atribuído a uma conexão via e
-- respondia as conversas dela.
--
-- O QUE ESTAVA ERRADO
-- -------------------
-- `can_use_whatsapp_connection()` existe desde a 048 e é aplicada em
-- `whatsapp_connections_for_user` — a listagem de CONEXÕES. Mas a
-- policy de `conversations` só checava pertencimento à conta:
--
--   USING (is_account_member(account_id))
--
-- Resultado: a conexão sumia da tela de configurações, mas as
-- conversas dela continuavam na Inbox de todo mundo, com envio
-- liberado. A regra existia num lugar e faltava no que importa.
--
-- Corrigir na POLICY, não na tela: é o único ponto por onde todo
-- caminho de leitura passa — Inbox, busca, API, relatório futuro.
-- Uma checagem na interface protegeria só a tela que eu lembrei de
-- proteger.
--
-- CONVERSAS SEM CONEXÃO CONTINUAM VISÍVEIS
-- ----------------------------------------
-- `whatsapp_connection_id IS NULL` cobre as conversas anteriores à
-- integração e as da Meta Cloud API. Escondê-las faria histórico
-- desaparecer da tela de quem sempre teve acesso — um "conserto"
-- pior que o problema.
--
-- Só policies. Nenhuma tabela, coluna ou dado é alterado.
-- ============================================================

-- ============================================================
-- CONVERSAS
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;

CREATE POLICY conversations_select ON conversations FOR SELECT
USING (
  is_account_member(account_id)
  AND (
    -- Sem conexão associada: visível a todos da conta.
    whatsapp_connection_id IS NULL
    -- Com conexão: só quem pode atender nela.
    OR can_use_whatsapp_connection(whatsapp_connection_id)
  )
);

CREATE POLICY conversations_update ON conversations FOR UPDATE
USING (
  is_account_member(account_id, 'agent')
  AND (
    whatsapp_connection_id IS NULL
    OR can_use_whatsapp_connection(whatsapp_connection_id)
  )
);

-- INSERT e DELETE seguem como estavam: criar conversa é operação do
-- webhook (service role) e apagar já exigia 'agent'. Mexer neles
-- aqui seria alterar comportamento que ninguém pediu.

-- ============================================================
-- MENSAGENS
--
-- Herdam da conversa. Com a policy acima corrigida, um vendedor sem
-- acesso à conexão deixa de ver a conversa E as mensagens dela —
-- porque o `EXISTS` sobre `conversations` passa a não encontrar a
-- linha.
--
-- Recriadas mesmo assim, explicitando a intenção: depender do efeito
-- colateral de outra policy é o tipo de coisa que se perde numa
-- refatoração futura.
-- ============================================================
DROP POLICY IF EXISTS messages_select ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;

CREATE POLICY messages_select ON messages FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id)
      AND (
        c.whatsapp_connection_id IS NULL
        OR can_use_whatsapp_connection(c.whatsapp_connection_id)
      )
  )
);

CREATE POLICY messages_modify ON messages FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND (
        c.whatsapp_connection_id IS NULL
        OR can_use_whatsapp_connection(c.whatsapp_connection_id)
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND (
        c.whatsapp_connection_id IS NULL
        OR can_use_whatsapp_connection(c.whatsapp_connection_id)
      )
  )
);

-- ============================================================
-- ÍNDICE PARA A CHECAGEM
--
-- `can_use_whatsapp_connection` roda uma vez por linha avaliada pela
-- policy. Sem índice em `(user_id, connection_id)`, cada verificação
-- varre a tabela de membros — e a lista de conversas faz isso para
-- toda conversa exibida.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_wa_conn_members_lookup
  ON whatsapp_connection_members (user_id, connection_id);

-- ============================================================
-- CONFIRMAÇÃO DE ACESSO PARA O ENVIO
--
-- O envio grava em `messages`, e a policy acima já o barra. Mas o
-- erro que chegaria seria de RLS — genérico e sem explicação.
--
-- Esta função permite à rota recusar antes, com uma frase que diz o
-- que aconteceu.
-- ============================================================
CREATE OR REPLACE FUNCTION can_reply_to_conversation(p_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_connection UUID;
BEGIN
  SELECT c.account_id, c.whatsapp_connection_id
  INTO v_account, v_connection
  FROM conversations c WHERE c.id = p_conversation_id;

  IF v_account IS NULL THEN
    RETURN FALSE;
  END IF;
  IF NOT is_account_member(v_account, 'agent') THEN
    RETURN FALSE;
  END IF;
  IF v_connection IS NULL THEN
    RETURN TRUE;
  END IF;

  RETURN can_use_whatsapp_connection(v_connection);
END;
$$;

ALTER FUNCTION can_reply_to_conversation(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_reply_to_conversation(UUID)
  TO authenticated, service_role;
