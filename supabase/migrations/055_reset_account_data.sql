-- ============================================================
-- 055_reset_account_data.sql
--
-- Limpeza de dados operacionais pelo painel.
--
-- ESTA É A FUNÇÃO MAIS PERIGOSA DO SISTEMA
-- ----------------------------------------
-- Apaga dados de verdade e não tem desfazer. Por isso:
--
--   * SÓ master, verificado no banco — não na rota;
--   * SÓ a própria conta. Todo DELETE filtra por account_id, e o
--     account_id vem de `auth.uid()`, nunca de parâmetro;
--   * escopo por partes, não tudo-ou-nada: quem quer limpar
--     conversas raramente quer perder o histórico de vendas;
--   * nunca toca em produtos, credenciais, configurações,
--     usuários ou trilha de auditoria;
--   * registra o que apagou, com as contagens, ANTES de apagar.
--
-- Retorna o que foi removido para a tela confirmar — um "pronto"
-- sem números deixa a dúvida de se algo aconteceu.
-- ============================================================

/**
 * Contagem do que existe hoje. Alimenta a prévia antes de apagar.
 *
 * Separada da exclusão de propósito: a tela mostra números reais
 * antes de qualquer decisão, e ver "3 pedidos" é diferente de ver
 * "apagar pedidos".
 */
CREATE OR REPLACE FUNCTION account_data_summary(p_account_id UUID)
RETURNS TABLE (
  contacts BIGINT,
  conversations BIGINT,
  messages BIGINT,
  orders BIGINT,
  charges BIGINT,
  expenses BIGINT,
  products BIGINT,
  lid_contacts BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM assert_account_access(p_account_id, 'admin');

  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM contacts c WHERE c.account_id = p_account_id)::BIGINT,
    (SELECT COUNT(*) FROM conversations cv WHERE cv.account_id = p_account_id)::BIGINT,
    (SELECT COUNT(*) FROM messages m
      JOIN conversations cv ON cv.id = m.conversation_id
     WHERE cv.account_id = p_account_id)::BIGINT,
    (SELECT COUNT(*) FROM orders o WHERE o.account_id = p_account_id)::BIGINT,
    (SELECT COUNT(*) FROM payment_charges pc WHERE pc.account_id = p_account_id)::BIGINT,
    (SELECT COUNT(*) FROM operational_expenses e WHERE e.account_id = p_account_id)::BIGINT,
    (SELECT COUNT(*) FROM products p WHERE p.account_id = p_account_id)::BIGINT,
    -- Contatos cujo "telefone" é longo demais para ser telefone:
    -- identificadores internos do WhatsApp que viraram cadastro.
    (SELECT COUNT(*) FROM contacts c
      WHERE c.account_id = p_account_id
        AND length(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) > 13
    )::BIGINT;
END;
$$;

ALTER FUNCTION account_data_summary(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION account_data_summary(UUID) TO authenticated, service_role;

/**
 * Apaga dados operacionais da conta.
 *
 * Cada escopo é independente e opcional. A ordem interna respeita as
 * dependências: o que referencia sai antes do que é referenciado.
 *
 * `p_lid_contacts_only` limita a exclusão de contatos aos que têm
 * identificador em vez de telefone — a limpeza cirúrgica de quem já
 * tem cliente de verdade na base.
 */
CREATE OR REPLACE FUNCTION reset_account_data(
  p_account_id UUID,
  p_conversations BOOLEAN DEFAULT FALSE,
  p_orders BOOLEAN DEFAULT FALSE,
  p_contacts BOOLEAN DEFAULT FALSE,
  p_expenses BOOLEAN DEFAULT FALSE,
  p_lid_contacts_only BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  deleted_conversations BIGINT,
  deleted_messages BIGINT,
  deleted_orders BIGINT,
  deleted_charges BIGINT,
  deleted_contacts BIGINT,
  deleted_expenses BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_conversas BIGINT := 0;
  n_mensagens BIGINT := 0;
  n_pedidos BIGINT := 0;
  n_cobrancas BIGINT := 0;
  n_contatos BIGINT := 0;
  n_despesas BIGINT := 0;
BEGIN
  -- Master, verificado no BANCO. A rota também checa, mas a rota
  -- pode ser reescrita; esta linha não sai do caminho.
  PERFORM assert_account_access(p_account_id, 'admin');

  -- Conta inativa não apaga nada: uma conta suspensa em disputa não
  -- deve conseguir destruir o próprio histórico.
  IF NOT account_is_active(p_account_id) THEN
    RAISE EXCEPTION 'Conta inativa não pode apagar dados'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Contagens ANTES de apagar. Depois não há como saber.
  SELECT COUNT(*) INTO n_mensagens
  FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
  WHERE cv.account_id = p_account_id;

  -- ---------- Pedidos ----------
  IF p_orders THEN
    SELECT COUNT(*) INTO n_pedidos FROM orders WHERE account_id = p_account_id;
    SELECT COUNT(*) INTO n_cobrancas
      FROM payment_charges WHERE account_id = p_account_id;

    DELETE FROM payment_charges WHERE account_id = p_account_id;
    DELETE FROM order_costs WHERE account_id = p_account_id;
    DELETE FROM order_items WHERE account_id = p_account_id;
    DELETE FROM orders WHERE account_id = p_account_id;

    -- Zera a numeração. Sem isto o próximo pedido sai como #11 numa
    -- base vazia — parece defeito.
    DELETE FROM order_counters WHERE account_id = p_account_id;
  END IF;

  -- ---------- Conversas ----------
  IF p_conversations THEN
    SELECT COUNT(*) INTO n_conversas
      FROM conversations WHERE account_id = p_account_id;

    DELETE FROM provider_message_map WHERE account_id = p_account_id;

    DELETE FROM messages m
     USING conversations cv
     WHERE cv.id = m.conversation_id
       AND cv.account_id = p_account_id;

    DELETE FROM conversations WHERE account_id = p_account_id;
  ELSE
    n_mensagens := 0;
  END IF;

  -- ---------- Contatos ----------
  --
  -- Por último: pedidos e conversas apontam para eles. E NUNCA apaga
  -- contato com venda registrada — histórico financeiro não some
  -- numa limpeza, mesmo pedida.
  IF p_contacts THEN
    WITH alvo AS (
      SELECT c.id
      FROM contacts c
      WHERE c.account_id = p_account_id
        AND (
          NOT p_lid_contacts_only
          OR length(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) > 13
        )
        AND NOT EXISTS (
          SELECT 1 FROM orders o WHERE o.contact_id = c.id
        )
    ),
    apagadas AS (
      DELETE FROM conversations
       WHERE account_id = p_account_id
         AND contact_id IN (SELECT id FROM alvo)
      RETURNING 1
    ),
    removidos AS (
      DELETE FROM contacts
       WHERE account_id = p_account_id
         AND id IN (SELECT id FROM alvo)
      RETURNING 1
    )
    SELECT COUNT(*) INTO n_contatos FROM removidos;
  END IF;

  -- ---------- Despesas ----------
  IF p_expenses THEN
    SELECT COUNT(*) INTO n_despesas
      FROM operational_expenses WHERE account_id = p_account_id;
    DELETE FROM operational_expenses WHERE account_id = p_account_id;
  END IF;

  -- Trilha de auditoria. É append-only e sobrevive à limpeza — é
  -- justamente o registro de que ela aconteceu.
  PERFORM write_audit_log(
    p_account_id,
    'account.data_reset',
    'account',
    p_account_id,
    jsonb_build_object(
      'conversations', n_conversas,
      'messages', n_mensagens,
      'orders', n_pedidos,
      'charges', n_cobrancas,
      'contacts', n_contatos,
      'expenses', n_despesas,
      'lid_only', p_lid_contacts_only
    )
  );

  RETURN QUERY SELECT
    n_conversas, n_mensagens, n_pedidos,
    n_cobrancas, n_contatos, n_despesas;
END;
$$;

ALTER FUNCTION reset_account_data(UUID, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN)
  OWNER TO postgres;
GRANT EXECUTE ON FUNCTION reset_account_data(UUID, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN)
  TO authenticated, service_role;
