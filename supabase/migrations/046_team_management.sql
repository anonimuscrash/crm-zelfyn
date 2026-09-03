-- ============================================================
-- 046_team_management.sql
--
-- Gestão de equipe: métricas recortadas por vendedor, painel de
-- equipe e ranking.
--
-- DECISÃO: parâmetro opcional, não funções paralelas
-- --------------------------------------------------
-- As RPCs de analytics ganham `p_seller_id UUID DEFAULT NULL`. NULL
-- significa "toda a conta" — exatamente o comportamento de hoje.
-- Duplicar cada função numa versão "_by_seller" dobraria a
-- superfície de manutenção e garantiria que uma correção futura
-- fosse aplicada só numa das cópias.
--
-- A CHAMADA NÃO É CONFIÁVEL
-- -------------------------
-- Um vendedor pode passar o seller_id de um colega no corpo da
-- requisição. Por isso cada função abaixo IGNORA `p_seller_id` e o
-- força para `auth.uid()` quando o chamador não é master. Não é a
-- rota que decide isso — é o banco, porque a rota pode ser
-- reescrita e a policy não.
--
-- Só CREATE OR REPLACE FUNCTION. Nenhuma tabela, coluna, índice,
-- policy ou dado é tocado.
-- ============================================================

/**
 * Resolve qual vendedor as métricas devem cobrir.
 *
 * Master: respeita o pedido (NULL = conta inteira, uuid = aquele
 * vendedor). Qualquer outro papel: sempre o próprio usuário,
 * independentemente do que veio na requisição.
 */
CREATE OR REPLACE FUNCTION resolve_seller_scope(
  p_account_id UUID,
  p_seller_id UUID
)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN can_see_all_orders(p_account_id) THEN p_seller_id
    ELSE auth.uid()
  END;
$$;

ALTER FUNCTION resolve_seller_scope(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION resolve_seller_scope(UUID, UUID) TO authenticated, service_role;

-- ============================================================
-- DASHBOARD METRICS — com recorte de vendedor
--
-- Despesas operacionais NÃO são rateadas por vendedor (§38). Quando
-- o recorte é de um vendedor, `operating_expenses_cents` vem zero e
-- o lucro operacional iguala o lucro bruto. Ratear marketing e
-- aluguel entre vendedores exigiria uma política de alocação que é
-- decisão de negócio, e escolher uma em silêncio produziria um
-- "lucro do João" que ninguém consegue auditar.
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_dashboard_metrics(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_seller_id UUID DEFAULT NULL
)
RETURNS TABLE (
  gross_cents BIGINT,
  discount_cents BIGINT,
  net_revenue_cents BIGINT,
  cogs_cents BIGINT,
  shipping_cents BIGINT,
  fees_cents BIGINT,
  other_costs_cents BIGINT,
  direct_costs_cents BIGINT,
  gross_profit_cents BIGINT,
  operating_expenses_cents BIGINT,
  operating_profit_cents BIGINT,
  order_count BIGINT,
  units_sold BIGINT,
  avg_ticket_cents BIGINT,
  customer_count BIGINT,
  status_awaiting_shipment BIGINT,
  status_shipped BIGINT,
  status_completed BIGINT,
  status_cancelled BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expenses BIGINT := 0;
  v_seller UUID;
BEGIN
  PERFORM assert_account_access(p_account_id);
  v_seller := resolve_seller_scope(p_account_id, p_seller_id);

  -- Só a visão consolidada carrega overhead.
  IF v_seller IS NULL THEN
    SELECT COALESCE(SUM(e.amount_cents), 0)
    INTO v_expenses
    FROM operational_expenses e
    WHERE e.account_id = p_account_id
      AND e.incurred_on >= p_from::date
      AND e.incurred_on <= p_to::date;
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT o.*
    FROM orders o
    WHERE o.account_id = p_account_id
      AND o.ordered_at >= p_from
      AND o.ordered_at < p_to
      AND (v_seller IS NULL OR o.seller_user_id = v_seller)
  ),
  revenue AS (
    SELECT * FROM scoped WHERE order_status_is_revenue(status)
  ),
  agg AS (
    SELECT
      COALESCE(SUM(r.gross_cents), 0)          AS gross,
      COALESCE(SUM(r.discount_total_cents), 0) AS disc,
      COALESCE(SUM(r.net_revenue_cents), 0)    AS net,
      COALESCE(SUM(r.cogs_cents), 0)           AS cogs,
      COALESCE(SUM(r.shipping_cost_cents), 0)  AS ship,
      COALESCE(SUM(r.payment_fee_cents), 0)    AS fees,
      COALESCE(SUM(r.other_costs_cents), 0)    AS other,
      COALESCE(SUM(r.direct_costs_cents), 0)   AS direct,
      COALESCE(SUM(r.gross_profit_cents), 0)   AS profit,
      COUNT(*)                                  AS orders,
      COALESCE(SUM(r.item_count), 0)           AS units,
      COUNT(DISTINCT r.contact_id)             AS customers
    FROM revenue r
  )
  SELECT
    agg.gross::BIGINT,
    agg.disc::BIGINT,
    agg.net::BIGINT,
    agg.cogs::BIGINT,
    agg.ship::BIGINT,
    agg.fees::BIGINT,
    agg.other::BIGINT,
    agg.direct::BIGINT,
    agg.profit::BIGINT,
    v_expenses,
    (agg.profit - v_expenses)::BIGINT,
    agg.orders::BIGINT,
    agg.units::BIGINT,
    CASE WHEN agg.orders > 0
         THEN ROUND(agg.net::NUMERIC / agg.orders)
         ELSE 0 END::BIGINT,
    agg.customers::BIGINT,
    (SELECT COUNT(*) FROM scoped WHERE status IN ('new','paid','preparing','awaiting_shipment'))::BIGINT,
    (SELECT COUNT(*) FROM scoped WHERE status = 'shipped')::BIGINT,
    (SELECT COUNT(*) FROM scoped WHERE status IN ('delivered','completed'))::BIGINT,
    (SELECT COUNT(*) FROM scoped WHERE status IN ('cancelled','refunded'))::BIGINT
  FROM agg;
END;
$$;

ALTER FUNCTION commerce_dashboard_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_dashboard_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID)
  TO authenticated, service_role;

-- ============================================================
-- SALES SERIES — com recorte de vendedor
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_sales_series(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_bucket TEXT DEFAULT 'day',
  p_timezone TEXT DEFAULT 'UTC',
  p_seller_id UUID DEFAULT NULL
)
RETURNS TABLE (
  bucket_start TIMESTAMPTZ,
  net_revenue_cents BIGINT,
  gross_profit_cents BIGINT,
  direct_costs_cents BIGINT,
  order_count BIGINT,
  units_sold BIGINT,
  avg_ticket_cents BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket TEXT;
  v_tz TEXT;
  v_seller UUID;
BEGIN
  PERFORM assert_account_access(p_account_id);
  v_seller := resolve_seller_scope(p_account_id, p_seller_id);

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
  rows_in_window AS (
    SELECT
      date_trunc(v_bucket, o.ordered_at AT TIME ZONE v_tz) AS r_bucket,
      o.net_revenue_cents  AS r_net,
      o.gross_profit_cents AS r_profit,
      o.direct_costs_cents AS r_costs,
      o.item_count         AS r_units
    FROM orders o
    WHERE o.account_id = p_account_id
      AND o.ordered_at >= p_from
      AND o.ordered_at < p_to
      AND order_status_is_revenue(o.status)
      AND (v_seller IS NULL OR o.seller_user_id = v_seller)
  ),
  agg AS (
    SELECT
      w.r_bucket      AS a_bucket,
      SUM(w.r_net)    AS a_net,
      SUM(w.r_profit) AS a_profit,
      SUM(w.r_costs)  AS a_costs,
      COUNT(*)        AS a_orders,
      SUM(w.r_units)  AS a_units
    FROM rows_in_window w
    GROUP BY w.r_bucket
  )
  SELECT
    (grid.g_bucket AT TIME ZONE v_tz)::TIMESTAMPTZ,
    COALESCE(agg.a_net, 0)::BIGINT,
    COALESCE(agg.a_profit, 0)::BIGINT,
    COALESCE(agg.a_costs, 0)::BIGINT,
    COALESCE(agg.a_orders, 0)::BIGINT,
    COALESCE(agg.a_units, 0)::BIGINT,
    CASE WHEN COALESCE(agg.a_orders, 0) > 0
         THEN ROUND(agg.a_net::NUMERIC / agg.a_orders)
         ELSE 0 END::BIGINT
  FROM grid
  LEFT JOIN agg ON agg.a_bucket = grid.g_bucket
  ORDER BY grid.g_bucket;
END;
$$;

ALTER FUNCTION commerce_sales_series(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_sales_series(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID)
  TO authenticated, service_role;

-- ============================================================
-- PRODUCT RANKING — com recorte de vendedor (§45)
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_product_ranking(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0,
  p_seller_id UUID DEFAULT NULL
)
RETURNS TABLE (
  product_id UUID,
  product_name TEXT,
  product_sku TEXT,
  units_sold BIGINT,
  order_count BIGINT,
  gross_cents BIGINT,
  discount_cents BIGINT,
  net_revenue_cents BIGINT,
  cogs_cents BIGINT,
  gross_profit_cents BIGINT,
  avg_ticket_cents BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seller UUID;
BEGIN
  PERFORM assert_account_access(p_account_id);
  v_seller := resolve_seller_scope(p_account_id, p_seller_id);

  RETURN QUERY
  WITH lines AS (
    SELECT
      oi.product_id,
      oi.product_name,
      oi.product_sku,
      oi.order_id,
      oi.quantity,
      oi.unit_price_cents * oi.quantity AS line_gross,
      oi.discount_cents                 AS line_discount,
      oi.unit_cost_cents * oi.quantity  AS line_cogs
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.account_id = p_account_id
      AND o.ordered_at >= p_from
      AND o.ordered_at < p_to
      AND order_status_is_revenue(o.status)
      AND (v_seller IS NULL OR o.seller_user_id = v_seller)
  ),
  grouped AS (
    SELECT
      l.product_id,
      MIN(l.product_name) AS product_name,
      MIN(l.product_sku)  AS product_sku,
      SUM(l.quantity)                     AS units,
      COUNT(DISTINCT l.order_id)          AS orders,
      SUM(l.line_gross)                   AS gross,
      SUM(l.line_discount)                AS discount,
      SUM(l.line_gross - l.line_discount) AS net,
      SUM(l.line_cogs)                    AS cogs
    FROM lines l
    GROUP BY l.product_id, CASE WHEN l.product_id IS NULL THEN l.product_name ELSE '' END
  )
  SELECT
    g.product_id,
    g.product_name::TEXT,
    g.product_sku::TEXT,
    g.units::BIGINT,
    g.orders::BIGINT,
    g.gross::BIGINT,
    g.discount::BIGINT,
    g.net::BIGINT,
    g.cogs::BIGINT,
    (g.net - g.cogs)::BIGINT,
    CASE WHEN g.orders > 0
         THEN ROUND(g.net::NUMERIC / g.orders)
         ELSE 0 END::BIGINT
  FROM grouped g
  ORDER BY g.net DESC
  LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

ALTER FUNCTION commerce_product_ranking(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_product_ranking(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, UUID)
  TO authenticated, service_role;

-- ============================================================
-- PAINEL DE EQUIPE (§46)
--
-- Um retrato de cada membro: quem é, se está ativo, e como vendeu
-- na janela pedida. Somente master — a função levanta exceção para
-- qualquer outro papel, então um vendedor que chamasse a RPC
-- diretamente recebe erro, não a lista dos colegas.
--
-- Inclui membros SEM venda no período (LEFT JOIN): um vendedor que
-- não vendeu é justamente a linha que o dono precisa ver.
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_team_overview(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  email TEXT,
  avatar_url TEXT,
  account_role TEXT,
  joined_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  order_count BIGINT,
  net_revenue_cents BIGINT,
  gross_profit_cents BIGINT,
  avg_ticket_cents BIGINT,
  units_sold BIGINT,
  discount_cents BIGINT,
  today_order_count BIGINT,
  today_net_revenue_cents BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 'admin' = master. Um seller aqui recebe insufficient_privilege.
  PERFORM assert_account_access(p_account_id, 'admin');

  RETURN QUERY
  WITH membros AS (
    SELECT p.user_id, p.full_name, p.email, p.avatar_url,
           p.account_role::TEXT AS papel, p.created_at
    FROM profiles p
    WHERE p.account_id = p_account_id
  ),
  vendas AS (
    SELECT
      o.seller_user_id AS uid,
      COUNT(*)                          AS n,
      SUM(o.net_revenue_cents)          AS net,
      SUM(o.gross_profit_cents)         AS profit,
      SUM(o.item_count)                 AS units,
      SUM(o.discount_total_cents)       AS disc
    FROM orders o
    WHERE o.account_id = p_account_id
      AND o.ordered_at >= p_from
      AND o.ordered_at < p_to
      AND order_status_is_revenue(o.status)
    GROUP BY o.seller_user_id
  ),
  hoje AS (
    SELECT
      o.seller_user_id AS uid,
      COUNT(*)                 AS n,
      SUM(o.net_revenue_cents) AS net
    FROM orders o
    WHERE o.account_id = p_account_id
      AND o.ordered_at >= date_trunc('day', NOW())
      AND order_status_is_revenue(o.status)
    GROUP BY o.seller_user_id
  )
  SELECT
    m.user_id,
    COALESCE(m.full_name, '')::TEXT,
    COALESCE(m.email, '')::TEXT,
    m.avatar_url::TEXT,
    m.papel,
    m.created_at,
    -- Última atividade = última venda registrada. Presença de sessão
    -- vive noutra tabela e mede outra coisa (aba aberta), que não é
    -- o que o dono quer saber ao olhar este painel.
    (SELECT MAX(o.created_at) FROM orders o
      WHERE o.account_id = p_account_id AND o.seller_user_id = m.user_id),
    COALESCE(v.n, 0)::BIGINT,
    COALESCE(v.net, 0)::BIGINT,
    COALESCE(v.profit, 0)::BIGINT,
    CASE WHEN COALESCE(v.n, 0) > 0
         THEN ROUND(v.net::NUMERIC / v.n)
         ELSE 0 END::BIGINT,
    COALESCE(v.units, 0)::BIGINT,
    COALESCE(v.disc, 0)::BIGINT,
    COALESCE(h.n, 0)::BIGINT,
    COALESCE(h.net, 0)::BIGINT
  FROM membros m
  LEFT JOIN vendas v ON v.uid = m.user_id
  LEFT JOIN hoje h ON h.uid = m.user_id
  ORDER BY COALESCE(v.net, 0) DESC, m.created_at ASC;
END;
$$;

ALTER FUNCTION commerce_team_overview(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_team_overview(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated, service_role;

-- ============================================================
-- LISTA DE VENDEDORES PARA O SELETOR
--
-- Enxuta de propósito: só id e nome. O dropdown do dashboard não
-- precisa de e-mail nem de faturamento, e não expor o que não é
-- necessário é a postura certa mesmo dentro de um painel de master.
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_seller_options(p_account_id UUID)
RETURNS TABLE (user_id UUID, full_name TEXT, account_role TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM assert_account_access(p_account_id, 'admin');

  RETURN QUERY
  SELECT p.user_id,
         COALESCE(NULLIF(p.full_name, ''), p.email, 'Sem nome')::TEXT,
         p.account_role::TEXT
  FROM profiles p
  WHERE p.account_id = p_account_id
  ORDER BY p.account_role, p.full_name;
END;
$$;

ALTER FUNCTION commerce_seller_options(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_seller_options(UUID) TO authenticated, service_role;
