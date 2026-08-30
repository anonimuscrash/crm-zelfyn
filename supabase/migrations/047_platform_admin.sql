-- ============================================================
-- 047_platform_admin.sql
--
-- Painel de administração da plataforma (§5, §6, §7, §53).
--
-- DIFERENÇA CRÍTICA EM RELAÇÃO A TODAS AS RPCs ANTERIORES
-- -------------------------------------------------------
-- Todas as funções de 041–046 gateiam por `assert_account_access()`
-- — pertencimento a UM tenant. As funções deste arquivo são as
-- únicas do sistema que leem ATRAVÉS de tenants, e por isso gateiam
-- por `is_platform_admin()`.
--
-- Isso as torna a superfície mais perigosa do banco: um erro aqui
-- não vaza dado de um vendedor para outro, vaza de um cliente
-- inteiro para outro. Por isso:
--
--   * `assert_platform_admin()` é a PRIMEIRA linha de cada corpo,
--     sem exceção;
--   * as funções devolvem AGREGADOS, não linhas de pedido. O admin
--     precisa saber quantas vendas um cliente processou, não o que
--     foi vendido nem para quem (§53);
--   * nenhuma função aceita `p_account_id` do chamador para
--     "espiar" um tenant — a lista de clientes é sempre completa e
--     agregada.
--
-- Só CREATE. Nenhuma tabela, coluna, índice, policy ou dado
-- existente é alterado.
-- ============================================================

/**
 * Guarda de admin de plataforma.
 *
 * Levanta exceção em vez de retornar FALSE: uma função que devolve
 * lista vazia para não-admin é indistinguível de uma plataforma sem
 * clientes, e esconde a falha de permissão em vez de expô-la.
 */
CREATE OR REPLACE FUNCTION assert_platform_admin()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin access required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

ALTER FUNCTION assert_platform_admin() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION assert_platform_admin() TO authenticated, service_role;

-- ============================================================
-- MÉTRICAS DA PLATAFORMA (§5, §53)
--
-- Uso do SaaS, não conteúdo dos clientes. Volume financeiro
-- agregado entra porque é a métrica de saúde do negócio; nenhum
-- detalhe de pedido, produto ou cliente final sai daqui.
-- ============================================================
CREATE OR REPLACE FUNCTION platform_metrics(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS TABLE (
  total_accounts BIGINT,
  active_accounts BIGINT,
  suspended_accounts BIGINT,
  blocked_accounts BIGINT,
  new_accounts BIGINT,
  team_accounts BIGINT,
  solo_accounts BIGINT,
  total_users BIGINT,
  total_sellers BIGINT,
  new_users BIGINT,
  active_users BIGINT,
  total_orders BIGINT,
  orders_in_period BIGINT,
  volume_cents BIGINT,
  volume_all_time_cents BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM assert_platform_admin();

  RETURN QUERY
  WITH contas AS (
    SELECT a.id, a.status, a.created_at,
           COALESCE(s.team_enabled, FALSE) AS tem_equipe
    FROM accounts a
    LEFT JOIN account_settings s ON s.account_id = a.id
  ),
  usuarios AS (
    SELECT p.user_id, p.account_role, p.created_at
    FROM profiles p
  ),
  pedidos_periodo AS (
    SELECT o.id, o.net_revenue_cents
    FROM orders o
    WHERE o.ordered_at >= p_from
      AND o.ordered_at < p_to
      AND order_status_is_revenue(o.status)
  )
  SELECT
    (SELECT COUNT(*) FROM contas)::BIGINT,
    (SELECT COUNT(*) FROM contas WHERE status = 'active')::BIGINT,
    (SELECT COUNT(*) FROM contas WHERE status = 'suspended')::BIGINT,
    (SELECT COUNT(*) FROM contas WHERE status = 'blocked')::BIGINT,
    (SELECT COUNT(*) FROM contas
      WHERE created_at >= p_from AND created_at < p_to)::BIGINT,
    (SELECT COUNT(*) FROM contas WHERE tem_equipe)::BIGINT,
    (SELECT COUNT(*) FROM contas WHERE NOT tem_equipe)::BIGINT,
    (SELECT COUNT(*) FROM usuarios)::BIGINT,
    (SELECT COUNT(*) FROM usuarios WHERE account_role = 'agent')::BIGINT,
    (SELECT COUNT(*) FROM usuarios
      WHERE created_at >= p_from AND created_at < p_to)::BIGINT,
    -- "Ativo" = registrou venda na janela. Presença de sessão mede
    -- aba aberta, que não é sinal de uso real da plataforma.
    (SELECT COUNT(DISTINCT o.seller_user_id) FROM orders o
      WHERE o.created_at >= p_from AND o.created_at < p_to
        AND o.seller_user_id IS NOT NULL)::BIGINT,
    (SELECT COUNT(*) FROM orders)::BIGINT,
    (SELECT COUNT(*) FROM pedidos_periodo)::BIGINT,
    (SELECT COALESCE(SUM(net_revenue_cents), 0) FROM pedidos_periodo)::BIGINT,
    (SELECT COALESCE(SUM(o.net_revenue_cents), 0) FROM orders o
      WHERE order_status_is_revenue(o.status))::BIGINT;
END;
$$;

ALTER FUNCTION platform_metrics(TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION platform_metrics(TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated, service_role;

-- ============================================================
-- SÉRIE DE CRESCIMENTO
--
-- Contas e usuários criados por bucket. Serve ao gráfico de
-- evolução do uso da plataforma.
-- ============================================================
CREATE OR REPLACE FUNCTION platform_growth_series(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_bucket TEXT DEFAULT 'day',
  p_timezone TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  bucket_start TIMESTAMPTZ,
  new_accounts BIGINT,
  new_users BIGINT,
  order_count BIGINT,
  volume_cents BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket TEXT;
  v_tz TEXT;
BEGIN
  PERFORM assert_platform_admin();

  IF p_bucket NOT IN ('hour', 'day', 'week', 'month') THEN
    RAISE EXCEPTION 'Invalid bucket: %', p_bucket
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_bucket := p_bucket;

  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    v_tz := 'UTC';
  ELSE
    v_tz := p_timezone;
  END IF;

  RETURN QUERY
  WITH grid AS (
    SELECT generate_series(
      date_trunc(v_bucket, p_from AT TIME ZONE v_tz),
      date_trunc(v_bucket, (p_to - INTERVAL '1 microsecond') AT TIME ZONE v_tz),
      ('1 ' || v_bucket)::INTERVAL
    ) AS g_bucket
  ),
  ac AS (
    SELECT date_trunc(v_bucket, a.created_at AT TIME ZONE v_tz) AS b,
           COUNT(*) AS n
    FROM accounts a
    WHERE a.created_at >= p_from AND a.created_at < p_to
    GROUP BY 1
  ),
  us AS (
    SELECT date_trunc(v_bucket, p.created_at AT TIME ZONE v_tz) AS b,
           COUNT(*) AS n
    FROM profiles p
    WHERE p.created_at >= p_from AND p.created_at < p_to
    GROUP BY 1
  ),
  od AS (
    SELECT date_trunc(v_bucket, o.ordered_at AT TIME ZONE v_tz) AS b,
           COUNT(*) AS n,
           SUM(o.net_revenue_cents) AS vol
    FROM orders o
    WHERE o.ordered_at >= p_from AND o.ordered_at < p_to
      AND order_status_is_revenue(o.status)
    GROUP BY 1
  )
  SELECT
    (grid.g_bucket AT TIME ZONE v_tz)::TIMESTAMPTZ,
    COALESCE(ac.n, 0)::BIGINT,
    COALESCE(us.n, 0)::BIGINT,
    COALESCE(od.n, 0)::BIGINT,
    COALESCE(od.vol, 0)::BIGINT
  FROM grid
  LEFT JOIN ac ON ac.b = grid.g_bucket
  LEFT JOIN us ON us.b = grid.g_bucket
  LEFT JOIN od ON od.b = grid.g_bucket
  ORDER BY grid.g_bucket;
END;
$$;

ALTER FUNCTION platform_growth_series(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION platform_growth_series(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  TO authenticated, service_role;

-- ============================================================
-- LISTA DE CLIENTES (§6)
--
-- Um registro por conta Master. Inclui o e-mail do dono porque
-- administrar a plataforma exige poder contatar o titular — mas
-- NADA além disso sobre a operação interna: nem nomes de clientes
-- finais, nem produtos, nem pedidos individuais (§53).
-- ============================================================
CREATE OR REPLACE FUNCTION platform_customers(
  p_search TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  account_id UUID,
  account_name TEXT,
  status TEXT,
  status_reason TEXT,
  status_changed_at TIMESTAMPTZ,
  owner_name TEXT,
  owner_email TEXT,
  plan TEXT,
  team_enabled BOOLEAN,
  member_count BIGINT,
  seller_count BIGINT,
  order_count BIGINT,
  volume_cents BIGINT,
  created_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_termo TEXT;
BEGIN
  PERFORM assert_platform_admin();

  -- Escapa curingas do LIKE: um cliente chamado "50%" não deve
  -- casar com todos os outros.
  v_termo := CASE
    WHEN COALESCE(TRIM(p_search), '') = '' THEN NULL
    ELSE '%' || REPLACE(REPLACE(TRIM(p_search), '%', '\%'), '_', '\_') || '%'
  END;

  IF p_status IS NOT NULL
     AND p_status NOT IN ('active', 'suspended', 'blocked') THEN
    RAISE EXCEPTION 'Invalid status filter: %', p_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      a.id,
      a.name,
      COALESCE(a.status, 'active') AS st,
      a.status_reason,
      a.status_changed_at,
      a.created_at,
      COALESCE(s.plan, 'free') AS plano,
      COALESCE(s.team_enabled, FALSE) AS equipe,
      dono.full_name AS dono_nome,
      dono.email AS dono_email
    FROM accounts a
    LEFT JOIN account_settings s ON s.account_id = a.id
    LEFT JOIN profiles dono ON dono.user_id = a.owner_user_id
  ),
  filtrada AS (
    SELECT b.* FROM base b
    WHERE (p_status IS NULL OR b.st = p_status)
      AND (
        v_termo IS NULL
        OR b.name ILIKE v_termo
        OR b.dono_nome ILIKE v_termo
        OR b.dono_email ILIKE v_termo
      )
  ),
  contagens AS (
    SELECT
      f.id,
      (SELECT COUNT(*) FROM profiles p WHERE p.account_id = f.id) AS membros,
      (SELECT COUNT(*) FROM profiles p
        WHERE p.account_id = f.id AND p.account_role = 'agent') AS vendedores,
      (SELECT COUNT(*) FROM orders o WHERE o.account_id = f.id) AS pedidos,
      (SELECT COALESCE(SUM(o.net_revenue_cents), 0) FROM orders o
        WHERE o.account_id = f.id AND order_status_is_revenue(o.status)) AS volume,
      (SELECT MAX(o.created_at) FROM orders o WHERE o.account_id = f.id) AS ultima
    FROM filtrada f
  )
  SELECT
    f.id,
    COALESCE(f.name, 'Sem nome')::TEXT,
    f.st::TEXT,
    f.status_reason::TEXT,
    f.status_changed_at,
    COALESCE(f.dono_nome, '')::TEXT,
    COALESCE(f.dono_email, '')::TEXT,
    f.plano::TEXT,
    f.equipe,
    c.membros::BIGINT,
    c.vendedores::BIGINT,
    c.pedidos::BIGINT,
    c.volume::BIGINT,
    f.created_at,
    c.ultima,
    (SELECT COUNT(*) FROM filtrada)::BIGINT
  FROM filtrada f
  JOIN contagens c ON c.id = f.id
  ORDER BY c.volume DESC, f.created_at DESC
  LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

ALTER FUNCTION platform_customers(TEXT, TEXT, INTEGER, INTEGER) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION platform_customers(TEXT, TEXT, INTEGER, INTEGER)
  TO authenticated, service_role;

-- ============================================================
-- MUDAR STATUS DE UMA CONTA (§7)
--
-- Bloquear NÃO apaga nada. Só troca uma coluna, registra quem fez,
-- quando e por quê, e grava no audit log. Os dados do cliente
-- continuam intactos e voltam inteiros quando reativado.
--
-- Duas travas contra o admin se trancar para fora:
--   * não é possível bloquear a própria conta;
--   * não é possível bloquear a conta de outro platform admin.
-- ============================================================
CREATE OR REPLACE FUNCTION platform_set_account_status(
  p_account_id UUID,
  p_status TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS TABLE (account_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_minha_conta UUID;
  v_dono UUID;
  v_antes TEXT;
BEGIN
  PERFORM assert_platform_admin();

  IF p_status NOT IN ('active', 'suspended', 'blocked') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT p.account_id INTO v_minha_conta
  FROM profiles p WHERE p.user_id = auth.uid();

  IF p_account_id = v_minha_conta AND p_status <> 'active' THEN
    RAISE EXCEPTION 'Cannot block your own account'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT a.owner_user_id, COALESCE(a.status, 'active')
  INTO v_dono, v_antes
  FROM accounts a WHERE a.id = p_account_id;

  IF v_dono IS NULL AND v_antes IS NULL THEN
    RAISE EXCEPTION 'Account not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF p_status <> 'active'
     AND v_dono IS NOT NULL
     AND is_platform_admin(v_dono) THEN
    RAISE EXCEPTION 'Cannot block another platform admin'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE accounts a SET
    status = p_status,
    status_reason = NULLIF(TRIM(COALESCE(p_reason, '')), ''),
    status_changed_at = NOW(),
    status_changed_by = auth.uid()
  WHERE a.id = p_account_id;

  -- account_id NULL no log: é ação DA PLATAFORMA sobre um tenant,
  -- não uma ação dentro dele. Assim o histórico não some se a conta
  -- for removida um dia, e o master não lê no próprio log que foi
  -- bloqueado e por quem.
  PERFORM write_audit_log(
    NULL,
    'platform.account_status_changed',
    'account',
    p_account_id,
    jsonb_build_object(
      'from', v_antes,
      'to', p_status,
      'reason', NULLIF(TRIM(COALESCE(p_reason, '')), '')
    )
  );

  RETURN QUERY SELECT p_account_id, p_status;
END;
$$;

ALTER FUNCTION platform_set_account_status(UUID, TEXT, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION platform_set_account_status(UUID, TEXT, TEXT)
  TO authenticated, service_role;

-- ============================================================
-- ATIVIDADE RECENTE (§52)
-- ============================================================
CREATE OR REPLACE FUNCTION platform_recent_activity(
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  action TEXT,
  entity_type TEXT,
  entity_id UUID,
  actor_label TEXT,
  account_name TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM assert_platform_admin();

  RETURN QUERY
  SELECT
    l.id,
    l.action::TEXT,
    l.entity_type::TEXT,
    l.entity_id,
    COALESCE(l.actor_label, '')::TEXT,
    COALESCE(a.name, '')::TEXT,
    l.metadata,
    l.created_at
  FROM audit_logs l
  LEFT JOIN accounts a
    ON a.id = COALESCE(l.account_id, l.entity_id)
  ORDER BY l.created_at DESC
  LIMIT GREATEST(COALESCE(p_limit, 50), 1);
END;
$$;

ALTER FUNCTION platform_recent_activity(INTEGER) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION platform_recent_activity(INTEGER)
  TO authenticated, service_role;
