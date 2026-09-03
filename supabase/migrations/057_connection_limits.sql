-- ============================================================
-- 057_connection_limits.sql
--
-- Limite de conexões de WhatsApp por plano.
--
-- POR QUE NO BANCO, NÃO NA ROTA
-- -----------------------------
-- O limite é regra de negócio do SaaS: é o que separa o plano free
-- do pago. Uma checagem só na rota some no dia em que alguém criar
-- outro caminho de criação — e aí um cliente free acorda com 10
-- conexões.
--
-- `max_whatsapp_connections` NULL significa "usar o padrão do
-- plano". Preenchido, vence — permite liberar um cliente específico
-- sem inventar um plano novo.
--
-- Apenas ADD COLUMN e CREATE FUNCTION.
-- ============================================================

ALTER TABLE account_settings
  ADD COLUMN IF NOT EXISTS max_whatsapp_connections INTEGER;

COMMENT ON COLUMN account_settings.max_whatsapp_connections IS
  'Teto de conexões de WhatsApp. NULL usa o padrão do plano: '
  '3 no free, 10 nos pagos.';

/**
 * Teto efetivo de conexões da conta.
 *
 * A regra vive aqui e em mais lugar nenhum. Espalhá-la pela rota e
 * pela tela garantiria que as três divergissem com o tempo.
 */
CREATE OR REPLACE FUNCTION whatsapp_connection_limit(p_account_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan TEXT;
  v_override INTEGER;
BEGIN
  SELECT s.plan, s.max_whatsapp_connections
  INTO v_plan, v_override
  FROM account_settings s
  WHERE s.account_id = p_account_id;

  -- Valor explícito vence o plano.
  IF v_override IS NOT NULL THEN
    RETURN GREATEST(v_override, 0);
  END IF;

  -- Conta sem settings ainda: trata como free. O padrão seguro é o
  -- menor, não o maior — liberar por engano custa mais que restringir.
  RETURN CASE
    WHEN COALESCE(v_plan, 'free') = 'free' THEN 3
    ELSE 10
  END;
END;
$$;

ALTER FUNCTION whatsapp_connection_limit(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION whatsapp_connection_limit(UUID)
  TO authenticated, service_role;

/**
 * Uso atual e teto, para a tela mostrar "2 de 3".
 */
CREATE OR REPLACE FUNCTION whatsapp_connection_usage(p_account_id UUID)
RETURNS TABLE (used INTEGER, allowed INTEGER, plan TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM assert_account_access(p_account_id);

  RETURN QUERY
  SELECT
    (SELECT COUNT(*)::INTEGER FROM whatsapp_connections c
      WHERE c.account_id = p_account_id),
    whatsapp_connection_limit(p_account_id),
    COALESCE(
      (SELECT s.plan FROM account_settings s WHERE s.account_id = p_account_id),
      'free'
    )::TEXT;
END;
$$;

ALTER FUNCTION whatsapp_connection_usage(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION whatsapp_connection_usage(UUID)
  TO authenticated, service_role;

-- ============================================================
-- TRIGGER: o banco recusa passar do teto
--
-- É a garantia real. A rota valida para dar mensagem decente; esta
-- trigger existe para o caso de alguém inserir por outro caminho.
-- ============================================================
CREATE OR REPLACE FUNCTION enforce_connection_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_atual INTEGER;
  v_teto INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_atual
  FROM whatsapp_connections
  WHERE account_id = NEW.account_id;

  v_teto := whatsapp_connection_limit(NEW.account_id);

  IF v_atual >= v_teto THEN
    RAISE EXCEPTION
      'Limite de % conexões de WhatsApp atingido neste plano', v_teto
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION enforce_connection_limit() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_connection_limit ON whatsapp_connections;
CREATE TRIGGER trg_connection_limit
  BEFORE INSERT ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION enforce_connection_limit();

-- ============================================================
-- ATENDENTES DE UMA CONEXÃO
--
-- A tabela `whatsapp_connection_members` já existe desde a 048. O
-- que faltava era como ler e escrever isso pela interface.
-- ============================================================
CREATE OR REPLACE FUNCTION whatsapp_connection_agents(p_connection_id UUID)
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  account_role TEXT,
  assigned BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
BEGIN
  SELECT c.account_id INTO v_account
  FROM whatsapp_connections c WHERE c.id = p_connection_id;

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Conexão não encontrada' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM assert_account_access(v_account, 'admin');

  RETURN QUERY
  SELECT
    p.user_id,
    COALESCE(NULLIF(p.full_name, ''), p.email, 'Sem nome')::TEXT,
    p.account_role::TEXT,
    EXISTS (
      SELECT 1 FROM whatsapp_connection_members m
      WHERE m.connection_id = p_connection_id AND m.user_id = p.user_id
    )
  FROM profiles p
  WHERE p.account_id = v_account
  ORDER BY p.account_role, p.full_name;
END;
$$;

ALTER FUNCTION whatsapp_connection_agents(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION whatsapp_connection_agents(UUID)
  TO authenticated, service_role;

/**
 * Define quem atende numa conexão.
 *
 * Lista VAZIA = todo mundo atende. É diferente de "ninguém atende",
 * que deixaria a conexão inútil — e é a leitura que o operador faz
 * ao desmarcar todos.
 */
CREATE OR REPLACE FUNCTION set_whatsapp_connection_agents(
  p_connection_id UUID,
  p_user_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
BEGIN
  SELECT c.account_id INTO v_account
  FROM whatsapp_connections c WHERE c.id = p_connection_id;

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Conexão não encontrada' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM assert_account_access(v_account, 'admin');

  DELETE FROM whatsapp_connection_members
   WHERE connection_id = p_connection_id;

  IF p_user_ids IS NOT NULL AND array_length(p_user_ids, 1) > 0 THEN
    INSERT INTO whatsapp_connection_members (connection_id, user_id, account_id)
    SELECT p_connection_id, u, v_account
    FROM unnest(p_user_ids) AS u
    -- Só quem é da conta. Sem isto, um id de outro workspace
    -- entraria na lista e ganharia acesso à Inbox daqui.
    WHERE EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = u AND p.account_id = v_account
    );
  END IF;

  PERFORM write_audit_log(
    v_account,
    'whatsapp.agents_changed',
    'whatsapp_connection',
    p_connection_id,
    jsonb_build_object('count', COALESCE(array_length(p_user_ids, 1), 0))
  );
END;
$$;

ALTER FUNCTION set_whatsapp_connection_agents(UUID, UUID[]) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION set_whatsapp_connection_agents(UUID, UUID[])
  TO authenticated, service_role;
