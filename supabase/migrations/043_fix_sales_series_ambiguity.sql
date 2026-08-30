-- ============================================================
-- 043_fix_sales_series_ambiguity.sql
--
-- Corrige: column reference "net_revenue_cents" is ambiguous
--
-- CAUSA
-- -----
-- Em plpgsql, cada nome declarado em RETURNS TABLE (...) vira uma
-- VARIÁVEL no escopo da função. Dentro do corpo, uma referência não
-- qualificada a uma coluna homônima é ambígua: o planejador não sabe
-- se `net_revenue_cents` é a variável de saída ou a coluna da CTE.
--
-- Em commerce_sales_series a CTE `rows_in_window` expunha colunas com
-- exatamente os mesmos nomes dos parâmetros de saída, e a CTE `agg`
-- as agregava sem prefixo — SUM(net_revenue_cents) em vez de
-- SUM(w.net_revenue_cents).
--
-- CORREÇÃO
-- --------
-- Duas travas, não uma:
--   1. As colunas intermediárias ganham prefixo `r_` (r_net, r_profit,
--      r_costs, r_units), então não existe mais homônimo algum.
--   2. Toda referência é qualificada pelo alias da CTE (`w.`).
--
-- Qualquer uma das duas resolveria; juntas, um `SELECT` novo escrito
-- aqui no futuro não reintroduz o problema por descuido.
--
-- As outras cinco funções de 042 foram auditadas e já qualificam
-- todas as referências — só esta precisava de ajuste.
--
-- Apenas CREATE OR REPLACE FUNCTION. Nenhuma tabela, coluna, índice,
-- policy ou dado é tocado.
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
    -- Todos os buckets do intervalo, inclusive os sem venda: um dia
    -- vazio precisa render um ponto zero no gráfico, não um buraco.
    SELECT generate_series(
      date_trunc(v_bucket, p_from AT TIME ZONE v_tz),
      date_trunc(v_bucket, (p_to - INTERVAL '1 microsecond') AT TIME ZONE v_tz),
      ('1 ' || v_bucket)::INTERVAL
    ) AS g_bucket
  ),
  rows_in_window AS (
    -- Prefixo `r_` para não colidir com os parâmetros de saída.
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
  ),
  agg AS (
    SELECT
      w.r_bucket        AS a_bucket,
      SUM(w.r_net)      AS a_net,
      SUM(w.r_profit)   AS a_profit,
      SUM(w.r_costs)    AS a_costs,
      COUNT(*)          AS a_orders,
      SUM(w.r_units)    AS a_units
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

ALTER FUNCTION commerce_sales_series(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_sales_series(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  TO authenticated, service_role;
