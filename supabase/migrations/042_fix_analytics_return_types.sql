-- ============================================================
-- 042_fix_analytics_return_types.sql
--
-- Corrige o erro 42804 ("structure of query does not match
-- function result type") em commerce_dashboard_metrics.
--
-- CAUSA
-- -----
-- Em Postgres, SUM() sobre uma coluna BIGINT retorna NUMERIC, não
-- BIGINT — a promoção existe para evitar overflow ao somar muitas
-- linhas. Como as colunas de RETURNS TABLE foram declaradas BIGINT
-- e o SELECT devolvia NUMERIC sem cast, a função falhava na primeira
-- chamada. As demais funções de 041 já traziam o cast; esta não.
--
-- CORREÇÃO SECUNDÁRIA: ticket médio
-- ----------------------------------
-- A fórmula anterior, (soma * 2 + n) / (n * 2), dependia da divisão
-- INTEIRA do Postgres truncar o resultado para produzir um
-- arredondamento half-up. Com operandos NUMERIC a divisão passa a
-- ser exata, e o cast final arredondava de novo — dois
-- arredondamentos encadeados, que erram por um centavo em alguns
-- valores. Trocada por ROUND(soma / n), que arredonda half-up uma
-- única vez e espelha exatamente `averageCents` em
-- src/lib/commerce/money.ts.
--
-- Só CREATE OR REPLACE FUNCTION. Nenhuma tabela, coluna, índice,
-- policy ou dado é tocado.
-- ============================================================

-- ============================================================
-- DASHBOARD METRICS
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_dashboard_metrics(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
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
BEGIN
  PERFORM assert_account_access(p_account_id);

  SELECT COALESCE(SUM(e.amount_cents), 0)
  INTO v_expenses
  FROM operational_expenses e
  WHERE e.account_id = p_account_id
    AND e.incurred_on >= p_from::date
    AND e.incurred_on <= p_to::date;

  RETURN QUERY
  WITH scoped AS (
    SELECT o.*
    FROM orders o
    WHERE o.account_id = p_account_id
      AND o.ordered_at >= p_from
      AND o.ordered_at < p_to
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
    (SELECT COUNT(*) FROM scoped WHERE status IN ('new', 'paid', 'preparing', 'awaiting_shipment'))::BIGINT,
    (SELECT COUNT(*) FROM scoped WHERE status = 'shipped')::BIGINT,
    (SELECT COUNT(*) FROM scoped WHERE status IN ('delivered', 'completed'))::BIGINT,
    (SELECT COUNT(*) FROM scoped WHERE status IN ('cancelled', 'refunded'))::BIGINT
  FROM agg;
END;
$$;

ALTER FUNCTION commerce_dashboard_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_dashboard_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated, service_role;

-- ============================================================
-- SALES SERIES — mesmo ajuste de arredondamento no ticket médio
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_sales_series(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_bucket TEXT DEFAULT 'day',
  p_timezone TEXT DEFAULT 'UTC'
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
BEGIN
  PERFORM assert_account_access(p_account_id);

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
    ) AS b
  ),
  rows_in_window AS (
    SELECT
      date_trunc(v_bucket, o.ordered_at AT TIME ZONE v_tz) AS b,
      o.net_revenue_cents,
      o.gross_profit_cents,
      o.direct_costs_cents,
      o.item_count
    FROM orders o
    WHERE o.account_id = p_account_id
      AND o.ordered_at >= p_from
      AND o.ordered_at < p_to
      AND order_status_is_revenue(o.status)
  ),
  agg AS (
    SELECT
      b,
      SUM(net_revenue_cents)  AS net,
      SUM(gross_profit_cents) AS profit,
      SUM(direct_costs_cents) AS costs,
      COUNT(*)                AS orders,
      SUM(item_count)         AS units
    FROM rows_in_window
    GROUP BY b
  )
  SELECT
    (grid.b AT TIME ZONE v_tz)::TIMESTAMPTZ,
    COALESCE(agg.net, 0)::BIGINT,
    COALESCE(agg.profit, 0)::BIGINT,
    COALESCE(agg.costs, 0)::BIGINT,
    COALESCE(agg.orders, 0)::BIGINT,
    COALESCE(agg.units, 0)::BIGINT,
    CASE WHEN COALESCE(agg.orders, 0) > 0
         THEN ROUND(agg.net::NUMERIC / agg.orders)
         ELSE 0 END::BIGINT
  FROM grid
  LEFT JOIN agg ON agg.b = grid.b
  ORDER BY grid.b;
END;
$$;

ALTER FUNCTION commerce_sales_series(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_sales_series(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  TO authenticated, service_role;

-- ============================================================
-- PRODUCT RANKING
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_product_ranking(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
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
BEGIN
  PERFORM assert_account_access(p_account_id);

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
  ),
  grouped AS (
    SELECT
      l.product_id,
      MIN(l.product_name) AS product_name,
      MIN(l.product_sku)  AS product_sku,
      SUM(l.quantity)                       AS units,
      COUNT(DISTINCT l.order_id)            AS orders,
      SUM(l.line_gross)                     AS gross,
      SUM(l.line_discount)                  AS discount,
      SUM(l.line_gross - l.line_discount)   AS net,
      SUM(l.line_cogs)                      AS cogs
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

ALTER FUNCTION commerce_product_ranking(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_product_ranking(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER)
  TO authenticated, service_role;

-- ============================================================
-- SELLER PERFORMANCE
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_seller_performance(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS TABLE (
  seller_user_id UUID,
  seller_name TEXT,
  order_count BIGINT,
  net_revenue_cents BIGINT,
  gross_profit_cents BIGINT,
  avg_ticket_cents BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM assert_account_access(p_account_id);

  RETURN QUERY
  SELECT
    o.seller_user_id,
    COALESCE(p.full_name, 'Não atribuído')::TEXT,
    COUNT(*)::BIGINT,
    SUM(o.net_revenue_cents)::BIGINT,
    SUM(o.gross_profit_cents)::BIGINT,
    ROUND(SUM(o.net_revenue_cents)::NUMERIC / COUNT(*))::BIGINT
  FROM orders o
  LEFT JOIN profiles p ON p.user_id = o.seller_user_id
  WHERE o.account_id = p_account_id
    AND o.ordered_at >= p_from
    AND o.ordered_at < p_to
    AND order_status_is_revenue(o.status)
  GROUP BY o.seller_user_id, p.full_name
  ORDER BY 4 DESC;
END;
$$;

ALTER FUNCTION commerce_seller_performance(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_seller_performance(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated, service_role;

-- ============================================================
-- CUSTOMER STATS
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_customer_stats(
  p_account_id UUID,
  p_contact_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  contact_id UUID,
  order_count BIGINT,
  net_revenue_cents BIGINT,
  gross_profit_cents BIGINT,
  avg_ticket_cents BIGINT,
  first_order_at TIMESTAMPTZ,
  last_order_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM assert_account_access(p_account_id);

  RETURN QUERY
  SELECT
    o.contact_id,
    COUNT(*)::BIGINT,
    SUM(o.net_revenue_cents)::BIGINT,
    SUM(o.gross_profit_cents)::BIGINT,
    ROUND(SUM(o.net_revenue_cents)::NUMERIC / COUNT(*))::BIGINT,
    MIN(o.ordered_at),
    MAX(o.ordered_at)
  FROM orders o
  WHERE o.account_id = p_account_id
    AND o.contact_id IS NOT NULL
    AND (p_contact_id IS NULL OR o.contact_id = p_contact_id)
    AND order_status_is_revenue(o.status)
  GROUP BY o.contact_id
  ORDER BY 3 DESC
  LIMIT GREATEST(COALESCE(p_limit, 50), 1);
END;
$$;

ALTER FUNCTION commerce_customer_stats(UUID, UUID, INTEGER) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_customer_stats(UUID, UUID, INTEGER)
  TO authenticated, service_role;

-- ============================================================
-- EXPENSE BREAKDOWN
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_expense_breakdown(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS TABLE (
  category_id UUID,
  category_name TEXT,
  color TEXT,
  amount_cents BIGINT,
  entry_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM assert_account_access(p_account_id);

  RETURN QUERY
  SELECT
    e.category_id,
    COALESCE(c.name, e.category_name_snapshot, 'Sem categoria')::TEXT,
    COALESCE(c.color, '#94a3b8')::TEXT,
    SUM(e.amount_cents)::BIGINT,
    COUNT(*)::BIGINT
  FROM operational_expenses e
  LEFT JOIN expense_categories c ON c.id = e.category_id
  WHERE e.account_id = p_account_id
    AND e.incurred_on >= p_from::date
    AND e.incurred_on <= p_to::date
  GROUP BY e.category_id, c.name, e.category_name_snapshot, c.color
  ORDER BY 4 DESC;
END;
$$;

ALTER FUNCTION commerce_expense_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_expense_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated, service_role;
