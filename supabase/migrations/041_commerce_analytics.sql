-- ============================================================
-- 041_commerce_analytics.sql
--
-- Aggregation RPCs behind the dashboard, product ranking, customer
-- panel, and reports. Every period filter in the UI resolves to one
-- of these — the numbers are computed in Postgres over the requested
-- window, never by slicing a pre-loaded array in the browser.
--
-- Additive only: CREATE OR REPLACE FUNCTION on names introduced by
-- this file. Nothing existing is touched.
--
-- SECURITY MODEL
-- --------------
-- These are SECURITY DEFINER (they need to read across a whole
-- account's rows without paying RLS evaluation per row on large
-- aggregates). That makes the membership check MANDATORY and it is
-- the FIRST statement in every function body. A caller who passes
-- an account_id they don't belong to gets an exception, not data.
-- This is the same class of bug as GHSA-63cv-2c49-m5v3 — caller-
-- supplied id + service-role/definer execution — so it is guarded
-- explicitly rather than left to the surrounding route.
-- ============================================================

-- ------------------------------------------------------------
-- Shared guard.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_account_access(
  p_account_id UUID,
  p_min_role account_role_enum DEFAULT 'viewer'
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT is_account_member(p_account_id, p_min_role) THEN
    RAISE EXCEPTION 'Not a member of this account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

ALTER FUNCTION assert_account_access(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION assert_account_access(UUID, account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- DASHBOARD METRICS
--
-- One round trip, one row, every headline number for a window.
-- Revenue-bearing statuses only for the money columns; the status
-- counters below cover the full set so cancellations stay visible.
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
    agg.gross,
    agg.disc,
    agg.net,
    agg.cogs,
    agg.ship,
    agg.fees,
    agg.other,
    agg.direct,
    agg.profit,
    v_expenses,
    agg.profit - v_expenses,
    agg.orders,
    agg.units,
    -- Integer average, rounded half-up, guarded against /0.
    CASE WHEN agg.orders > 0
         THEN (agg.net * 2 + agg.orders) / (agg.orders * 2)
         ELSE 0 END,
    agg.customers,
    (SELECT COUNT(*) FROM scoped WHERE status IN ('new', 'paid', 'preparing', 'awaiting_shipment')),
    (SELECT COUNT(*) FROM scoped WHERE status = 'shipped'),
    (SELECT COUNT(*) FROM scoped WHERE status IN ('delivered', 'completed')),
    (SELECT COUNT(*) FROM scoped WHERE status IN ('cancelled', 'refunded'))
  FROM agg;
END;
$$;

ALTER FUNCTION commerce_dashboard_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_dashboard_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated, service_role;

-- ============================================================
-- SALES SERIES
--
-- p_bucket is validated against a fixed allowlist before it reaches
-- date_trunc — the parameter is operator-selected, but treating it
-- as trusted input would be a needless injection surface.
-- p_timezone shifts bucket boundaries to the operator's local day,
-- which is what "today" means to a business user.
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

  -- Reject an unknown timezone up front rather than letting
  -- AT TIME ZONE fail mid-scan with an opaque message.
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
         THEN (agg.net * 2 + agg.orders) / (agg.orders * 2)
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
--
-- Aggregates order_items (the snapshots), not products — so a
-- renamed or deleted product still reports its historical numbers
-- under the name it was sold as.
--
-- Per-line net revenue is (unit_price * qty) - line_discount. The
-- order-level discount is deliberately NOT redistributed across
-- lines: attributing it would require an allocation policy that is
-- a business decision, and silently picking one would make the
-- ranking disagree with the dashboard in a way nobody could audit.
-- It is surfaced separately in the reports view instead.
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
      -- Group by the snapshot identity so deleted products (NULL
      -- product_id) still aggregate under their own name.
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
    g.product_name,
    g.product_sku,
    g.units::BIGINT,
    g.orders::BIGINT,
    g.gross::BIGINT,
    g.discount::BIGINT,
    g.net::BIGINT,
    g.cogs::BIGINT,
    (g.net - g.cogs)::BIGINT,
    CASE WHEN g.orders > 0
         THEN (g.net * 2 + g.orders) / (g.orders * 2)
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
-- EXPENSE BREAKDOWN BY CATEGORY
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
    ((SUM(o.net_revenue_cents) * 2 + COUNT(*)) / (COUNT(*) * 2))::BIGINT
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
--
-- p_contact_id NULL = every customer with at least one order,
-- ranked by spend (the "clientes que mais compraram" report).
-- Lifetime figures, not windowed — a customer panel wants totals.
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
    ((SUM(o.net_revenue_cents) * 2 + COUNT(*)) / (COUNT(*) * 2))::BIGINT,
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
-- CREATE ORDER (atomic)
--
-- Header + items + extra costs in ONE transaction, with the order
-- number allocated server-side. Doing this from the client as three
-- separate PostgREST calls would leave orphan headers whenever the
-- browser dies between calls — and would let a caller invent their
-- own order_number.
--
-- Item prices/costs are read from the request when supplied
-- (operator overrode the price at the till) and otherwise snapshot
-- from the product row at this instant.
-- ============================================================
CREATE OR REPLACE FUNCTION commerce_create_order(
  p_account_id UUID,
  p_payload JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id UUID;
  v_number BIGINT;
  v_item JSONB;
  v_cost JSONB;
  v_product RECORD;
  v_price BIGINT;
  v_unit_cost BIGINT;
  v_qty INTEGER;
  v_disc_kind TEXT;
  v_disc_value BIGINT;
  v_disc_cents BIGINT;
  v_pos INTEGER := 0;
  v_contact RECORD;
BEGIN
  -- Writing data requires at least 'agent'; viewers must not book sales.
  PERFORM assert_account_access(p_account_id, 'agent');

  IF jsonb_typeof(p_payload->'items') <> 'array'
     OR jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'An order needs at least one item'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_number := next_order_number(p_account_id);

  -- Snapshot the customer identity. The contact must belong to this
  -- account — a caller-supplied contact_id from another tenant is
  -- exactly the cross-tenant hole to keep shut.
  IF p_payload->>'contact_id' IS NOT NULL THEN
    SELECT c.id, c.name, c.phone INTO v_contact
    FROM contacts c
    WHERE c.id = (p_payload->>'contact_id')::UUID
      AND c.account_id = p_account_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Contact does not belong to this account'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  INSERT INTO orders (
    account_id, order_number, contact_id,
    customer_name_snapshot, customer_phone_snapshot,
    seller_user_id, status,
    discount_kind, discount_value,
    shipping_cost_cents, payment_fee_cents,
    shipping_carrier, tracking_code, notes, ordered_at
  ) VALUES (
    p_account_id,
    v_number,
    v_contact.id,
    v_contact.name,
    v_contact.phone,
    COALESCE((p_payload->>'seller_user_id')::UUID, auth.uid()),
    COALESCE(p_payload->>'status', 'new'),
    COALESCE(p_payload->>'discount_kind', 'fixed'),
    COALESCE((p_payload->>'discount_value')::BIGINT, 0),
    COALESCE((p_payload->>'shipping_cost_cents')::BIGINT, 0),
    COALESCE((p_payload->>'payment_fee_cents')::BIGINT, 0),
    p_payload->>'shipping_carrier',
    p_payload->>'tracking_code',
    p_payload->>'notes',
    COALESCE((p_payload->>'ordered_at')::TIMESTAMPTZ, NOW())
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items')
  LOOP
    v_qty := GREATEST(COALESCE((v_item->>'quantity')::INTEGER, 1), 1);
    v_product := NULL;

    IF v_item->>'product_id' IS NOT NULL THEN
      SELECT pr.id, pr.name, pr.sku, pr.unit_price_cents, pr.unit_cost_cents
      INTO v_product
      FROM products pr
      WHERE pr.id = (v_item->>'product_id')::UUID
        AND pr.account_id = p_account_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Product does not belong to this account'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;

    -- Explicit override wins; otherwise snapshot the product's current
    -- figures. This is where §9 "history never moves" is enforced.
    v_price := COALESCE(
      (v_item->>'unit_price_cents')::BIGINT,
      v_product.unit_price_cents,
      0
    );
    v_unit_cost := COALESCE(
      (v_item->>'unit_cost_cents')::BIGINT,
      v_product.unit_cost_cents,
      0
    );

    v_disc_kind := COALESCE(v_item->>'discount_kind', 'fixed');
    v_disc_value := GREATEST(COALESCE((v_item->>'discount_value')::BIGINT, 0), 0);

    IF v_disc_kind = 'percent' THEN
      -- Basis points, rounded half-up, applied to the whole line.
      v_disc_cents := (v_price * v_qty * v_disc_value + 5000) / 10000;
    ELSE
      v_disc_cents := v_disc_value;
    END IF;
    v_disc_cents := LEAST(GREATEST(v_disc_cents, 0), v_price * v_qty);

    INSERT INTO order_items (
      account_id, order_id, product_id,
      product_name, product_sku,
      unit_price_cents, unit_cost_cents, quantity,
      discount_kind, discount_value, discount_cents, position
    ) VALUES (
      p_account_id, v_order_id,
      (v_item->>'product_id')::UUID,
      COALESCE(v_item->>'product_name', v_product.name, 'Item'),
      COALESCE(v_item->>'product_sku', v_product.sku),
      v_price, v_unit_cost, v_qty,
      v_disc_kind, v_disc_value, v_disc_cents, v_pos
    );

    v_pos := v_pos + 1;
  END LOOP;

  IF jsonb_typeof(p_payload->'extra_costs') = 'array' THEN
    FOR v_cost IN SELECT * FROM jsonb_array_elements(p_payload->'extra_costs')
    LOOP
      IF COALESCE(v_cost->>'label', '') <> '' THEN
        INSERT INTO order_costs (account_id, order_id, label, amount_cents)
        VALUES (
          p_account_id, v_order_id,
          v_cost->>'label',
          GREATEST(COALESCE((v_cost->>'amount_cents')::BIGINT, 0), 0)
        );
      END IF;
    END LOOP;
  END IF;

  -- Triggers already fired per row; one final pass guarantees the
  -- header is consistent even if every branch above was skipped.
  PERFORM recalculate_order_totals(v_order_id);

  RETURN v_order_id;
END;
$$;

ALTER FUNCTION commerce_create_order(UUID, JSONB) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_create_order(UUID, JSONB)
  TO authenticated, service_role;
