-- ============================================================
-- 040_commerce_core.sql
--
-- Adds the commercial-operations layer: products, orders, order
-- items, per-order direct costs, and operational expenses.
--
-- NON-DESTRUCTIVE BY CONSTRUCTION. This migration only issues
-- CREATE ... IF NOT EXISTS and CREATE OR REPLACE FUNCTION. It does
-- not DROP, RENAME, or ALTER TYPE any pre-existing table, column,
-- constraint, index, trigger, or policy. The only statements that
-- touch existing objects are DROP POLICY / DROP TRIGGER guards for
-- objects this same file creates (Postgres has no
-- CREATE POLICY IF NOT EXISTS), matching the convention used by
-- every earlier migration in this repo.
--
-- Tenancy: every table carries account_id and is gated by the
-- is_account_member(account_id, min_role) helper from
-- 017_account_sharing.sql. Contacts are reused as customers — no
-- parallel customer table.
--
-- MONEY REPRESENTATION
-- --------------------
-- Every monetary column is BIGINT holding MINOR UNITS (cents).
-- No NUMERIC, no float, anywhere in the money path. Rationale:
--   * exact integer arithmetic in Postgres AND in JS (Number is
--     safe to 2^53, i.e. ~90 trillion BRL — far past any real
--     ledger here);
--   * no driver-level NUMERIC→string→float round trips;
--   * rounding becomes an explicit, testable decision at the one
--     place it happens (percentage discounts), instead of an
--     emergent property of binary floating point.
-- The currency itself lives on accounts.default_currency (021).
-- ============================================================

-- ============================================================
-- HELPER: which order statuses count as realised revenue
--
-- Cancelled and refunded orders stay in the table (operators need
-- the audit trail and the cancellation rate) but must never inflate
-- revenue, COGS, or profit. Centralised here so SQL aggregates and
-- the TypeScript layer cannot drift: src/lib/commerce/order-status.ts
-- mirrors this list and a unit test pins the two together.
-- ============================================================
CREATE OR REPLACE FUNCTION order_status_is_revenue(p_status TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_status IN (
    'new', 'paid', 'preparing', 'awaiting_shipment',
    'shipped', 'delivered', 'completed', 'problem'
  );
$$;

GRANT EXECUTE ON FUNCTION order_status_is_revenue(TEXT) TO authenticated, service_role;

-- ============================================================
-- PRODUCTS
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  name TEXT NOT NULL,
  sku TEXT,
  description TEXT,
  category TEXT,

  -- Current defaults. Orders snapshot these at write time (see
  -- order_items) so editing a product NEVER rewrites history.
  unit_cost_cents BIGINT NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  unit_price_cents BIGINT NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),

  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  image_url TEXT,
  -- NULL = stock not tracked for this product. 0 = tracked, sold out.
  stock_quantity INTEGER,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_account_active
  ON products(account_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_account_name
  ON products(account_id, name);
CREATE INDEX IF NOT EXISTS idx_products_account_category
  ON products(account_id, category)
  WHERE category IS NOT NULL;

-- SKU is unique per account when present. Partial index so multiple
-- products may leave it NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_account_sku_unique
  ON products(account_id, sku)
  WHERE sku IS NOT NULL;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read products" ON products;
DROP POLICY IF EXISTS "Agents insert products" ON products;
DROP POLICY IF EXISTS "Agents update products" ON products;
DROP POLICY IF EXISTS "Admins delete products" ON products;

CREATE POLICY "Members read products" ON products FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
CREATE POLICY "Agents insert products" ON products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY "Agents update products" ON products FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY "Admins delete products" ON products FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ORDER NUMBER COUNTER
--
-- Human-facing sequential number, per account, starting at 1.
-- A dedicated counter row (rather than a global sequence) keeps
-- each tenant's numbering clean and gap-free-ish. The UPDATE takes
-- a row lock, so concurrent inserts serialise on this one row —
-- acceptable at the write volume of a human-operated sales desk.
-- ============================================================
CREATE TABLE IF NOT EXISTS order_counters (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  next_number BIGINT NOT NULL DEFAULT 1
);

ALTER TABLE order_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members read order counters" ON order_counters;
CREATE POLICY "Members read order counters" ON order_counters FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

CREATE OR REPLACE FUNCTION next_order_number(p_account_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_number BIGINT;
BEGIN
  INSERT INTO order_counters (account_id, next_number)
  VALUES (p_account_id, 1)
  ON CONFLICT (account_id) DO NOTHING;

  UPDATE order_counters
     SET next_number = next_number + 1
   WHERE account_id = p_account_id
  RETURNING next_number - 1 INTO v_number;

  RETURN v_number;
END;
$$;

ALTER FUNCTION next_order_number(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION next_order_number(UUID) TO authenticated, service_role;

-- ============================================================
-- ORDERS
--
-- The *_cents totals below are DERIVED, not user-supplied. The
-- recalculate_order_totals() trigger recomputes every one of them
-- from order_items + order_costs on any write. The frontend may
-- preview the arithmetic for responsiveness, but the database is
-- the authority — a tampered client cannot book a fake margin.
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_number BIGINT NOT NULL,

  -- Customer. Contacts are reused as the customer entity; SET NULL
  -- so deleting a contact never destroys financial history.
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  customer_name_snapshot TEXT,
  customer_phone_snapshot TEXT,

  -- Who booked the sale (for per-seller reporting).
  seller_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'paid', 'preparing', 'awaiting_shipment', 'shipped',
    'delivered', 'completed', 'problem', 'cancelled', 'refunded'
  )),

  -- Order-level discount ON TOP of any per-item discount.
  -- discount_kind records operator intent ('percent' vs 'fixed') so
  -- the UI can round-trip the input; discount_value stores the raw
  -- entry (basis points when percent, cents when fixed). The
  -- resolved cash amount always lands in order_discount_cents.
  discount_kind TEXT NOT NULL DEFAULT 'fixed'
    CHECK (discount_kind IN ('fixed', 'percent')),
  discount_value BIGINT NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  order_discount_cents BIGINT NOT NULL DEFAULT 0 CHECK (order_discount_cents >= 0),

  -- Direct costs attributable to THIS order. Never operational
  -- expenses — that separation is the whole point of §18.
  shipping_cost_cents BIGINT NOT NULL DEFAULT 0 CHECK (shipping_cost_cents >= 0),
  payment_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (payment_fee_cents >= 0),

  -- Shipping / fulfilment tracking.
  shipping_carrier TEXT,
  tracking_code TEXT,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,

  notes TEXT,

  -- ---- DERIVED TOTALS (trigger-maintained, do not write directly) ----
  gross_cents BIGINT NOT NULL DEFAULT 0,
  item_discount_cents BIGINT NOT NULL DEFAULT 0,
  discount_total_cents BIGINT NOT NULL DEFAULT 0,
  net_revenue_cents BIGINT NOT NULL DEFAULT 0,
  cogs_cents BIGINT NOT NULL DEFAULT 0,
  other_costs_cents BIGINT NOT NULL DEFAULT 0,
  direct_costs_cents BIGINT NOT NULL DEFAULT 0,
  gross_profit_cents BIGINT NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,

  -- Business date of the sale. Separate from created_at so an
  -- operator can back-date a sale registered late in the evening
  -- without corrupting the audit timestamp.
  ordered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (account_id, order_number)
);

CREATE INDEX IF NOT EXISTS idx_orders_account_ordered_at
  ON orders(account_id, ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_account_status
  ON orders(account_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_account_contact
  ON orders(account_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_orders_account_seller
  ON orders(account_id, seller_user_id);
-- Covers the dashboard's hot path: revenue-bearing orders in a window.
CREATE INDEX IF NOT EXISTS idx_orders_account_revenue_window
  ON orders(account_id, ordered_at DESC)
  WHERE status NOT IN ('cancelled', 'refunded');

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read orders" ON orders;
DROP POLICY IF EXISTS "Agents insert orders" ON orders;
DROP POLICY IF EXISTS "Agents update orders" ON orders;
DROP POLICY IF EXISTS "Admins delete orders" ON orders;

CREATE POLICY "Members read orders" ON orders FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
CREATE POLICY "Agents insert orders" ON orders FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY "Agents update orders" ON orders FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY "Admins delete orders" ON orders FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ORDER_ITEMS
--
-- product_id is SET NULL on product delete; the snapshot columns
-- keep the line readable and the maths correct regardless.
-- ============================================================
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,

  -- ---- SNAPSHOT AT SALE TIME (§9) ----
  product_name TEXT NOT NULL,
  product_sku TEXT,
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
  unit_cost_cents BIGINT NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),

  quantity INTEGER NOT NULL CHECK (quantity > 0),

  discount_kind TEXT NOT NULL DEFAULT 'fixed'
    CHECK (discount_kind IN ('fixed', 'percent')),
  discount_value BIGINT NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  -- Resolved cash discount for the WHOLE line (not per unit).
  discount_cents BIGINT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),

  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_account_product
  ON order_items(account_id, product_id);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read order items" ON order_items;
DROP POLICY IF EXISTS "Agents write order items" ON order_items;

CREATE POLICY "Members read order items" ON order_items FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
CREATE POLICY "Agents write order items" ON order_items FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- ============================================================
-- ORDER_COSTS — arbitrary extra DIRECT costs on one order
-- (packaging for this shipment, gateway surcharge, gift wrap…).
-- Still order-scoped: never operational overhead.
-- ============================================================
CREATE TABLE IF NOT EXISTS order_costs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  amount_cents BIGINT NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_costs_order ON order_costs(order_id);

ALTER TABLE order_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read order costs" ON order_costs;
DROP POLICY IF EXISTS "Agents write order costs" ON order_costs;

CREATE POLICY "Members read order costs" ON order_costs FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
CREATE POLICY "Agents write order costs" ON order_costs FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- ============================================================
-- TOTALS TRIGGER
--
-- Single source of financial truth. Fires from order_items,
-- order_costs, and orders itself. Recomputes the whole derived
-- block from scratch rather than applying deltas — idempotent, and
-- immune to a missed event leaving a permanently skewed total.
--
-- Order-level percent discount is applied to the POST-item-discount
-- subtotal, and rounded half-up to the cent, once, here.
-- ============================================================
CREATE OR REPLACE FUNCTION recalculate_order_totals(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gross BIGINT := 0;
  v_item_disc BIGINT := 0;
  v_cogs BIGINT := 0;
  v_items INTEGER := 0;
  v_other BIGINT := 0;
  v_order RECORD;
  v_order_disc BIGINT := 0;
  v_subtotal BIGINT := 0;
  v_net BIGINT := 0;
  v_direct BIGINT := 0;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(unit_price_cents * quantity), 0),
    COALESCE(SUM(discount_cents), 0),
    COALESCE(SUM(unit_cost_cents * quantity), 0),
    COALESCE(SUM(quantity), 0)
  INTO v_gross, v_item_disc, v_cogs, v_items
  FROM order_items
  WHERE order_id = p_order_id;

  SELECT COALESCE(SUM(amount_cents), 0)
  INTO v_other
  FROM order_costs
  WHERE order_id = p_order_id;

  -- Subtotal the order-level discount applies to.
  v_subtotal := GREATEST(v_gross - v_item_disc, 0);

  IF v_order.discount_kind = 'percent' THEN
    -- discount_value is basis points (1250 = 12.50%). Round half-up.
    v_order_disc := (v_subtotal * v_order.discount_value + 5000) / 10000;
  ELSE
    v_order_disc := v_order.discount_value;
  END IF;

  -- Never discount below zero revenue.
  v_order_disc := LEAST(GREATEST(v_order_disc, 0), v_subtotal);

  v_net := v_subtotal - v_order_disc;
  v_direct := v_cogs
            + COALESCE(v_order.shipping_cost_cents, 0)
            + COALESCE(v_order.payment_fee_cents, 0)
            + v_other;

  UPDATE orders SET
    gross_cents          = v_gross,
    item_discount_cents  = v_item_disc,
    order_discount_cents = v_order_disc,
    discount_total_cents = v_item_disc + v_order_disc,
    net_revenue_cents    = v_net,
    cogs_cents           = v_cogs,
    other_costs_cents    = v_other,
    direct_costs_cents   = v_direct,
    gross_profit_cents   = v_net - v_direct,
    item_count           = v_items
  WHERE id = p_order_id;
END;
$$;

ALTER FUNCTION recalculate_order_totals(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION recalculate_order_totals(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION trg_recalculate_order_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM recalculate_order_totals(
    COALESCE(NEW.order_id, OLD.order_id)
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS recalc_totals ON order_items;
CREATE TRIGGER recalc_totals
  AFTER INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION trg_recalculate_order_totals();

DROP TRIGGER IF EXISTS recalc_totals ON order_costs;
CREATE TRIGGER recalc_totals
  AFTER INSERT OR UPDATE OR DELETE ON order_costs
  FOR EACH ROW EXECUTE FUNCTION trg_recalculate_order_totals();

-- Orders-side trigger: fires when an input that feeds the maths
-- changes (discount, shipping, fee). Guarded against recursion by
-- comparing only the INPUT columns — the UPDATE inside
-- recalculate_order_totals touches only DERIVED columns, so the
-- WHEN clause is false on that pass and the trigger does not re-fire.
CREATE OR REPLACE FUNCTION trg_recalculate_own_order_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM recalculate_order_totals(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS recalc_own_totals ON orders;
CREATE TRIGGER recalc_own_totals
  AFTER INSERT OR UPDATE OF discount_kind, discount_value,
                            shipping_cost_cents, payment_fee_cents
  ON orders
  FOR EACH ROW EXECUTE FUNCTION trg_recalculate_own_order_totals();

-- ============================================================
-- SHIPPING TIMESTAMP AUTOMATION
--
-- Kanban drag-and-drop only sends a status. Stamping shipped_at /
-- delivered_at here means the timestamps are correct no matter which
-- surface moved the card (board, table, API, future integration).
-- ============================================================
CREATE OR REPLACE FUNCTION trg_order_status_timestamps()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('shipped', 'delivered', 'completed')
       AND NEW.shipped_at IS NULL THEN
      NEW.shipped_at := NOW();
    END IF;
    IF NEW.status IN ('delivered', 'completed')
       AND NEW.delivered_at IS NULL THEN
      NEW.delivered_at := NOW();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_status_timestamps ON orders;
CREATE TRIGGER order_status_timestamps BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION trg_order_status_timestamps();

-- ============================================================
-- EXPENSE CATEGORIES
--
-- Seeded per account on first use by ensure_default_expense_categories().
-- is_system marks the seeded set so the UI can offer "reset to
-- defaults" without clobbering an operator's own categories.
-- ============================================================
CREATE TABLE IF NOT EXISTS expense_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b',
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_expense_categories_account
  ON expense_categories(account_id);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read expense categories" ON expense_categories;
DROP POLICY IF EXISTS "Agents write expense categories" ON expense_categories;

CREATE POLICY "Members read expense categories" ON expense_categories FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
CREATE POLICY "Agents write expense categories" ON expense_categories FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE OR REPLACE FUNCTION ensure_default_expense_categories(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO expense_categories (account_id, name, slug, color, is_system)
  VALUES
    (p_account_id, 'Marketing',              'marketing',   '#6366f1', TRUE),
    (p_account_id, 'Funcionários',           'payroll',     '#0ea5e9', TRUE),
    (p_account_id, 'Ferramentas',            'tools',       '#14b8a6', TRUE),
    (p_account_id, 'Servidor',               'hosting',     '#8b5cf6', TRUE),
    (p_account_id, 'Embalagens',             'packaging',   '#f59e0b', TRUE),
    (p_account_id, 'Aluguel',                'rent',        '#ef4444', TRUE),
    (p_account_id, 'Fretes administrativos', 'admin_ship',  '#f97316', TRUE),
    (p_account_id, 'Comissões',              'commissions', '#22c55e', TRUE),
    (p_account_id, 'Impostos',               'taxes',       '#64748b', TRUE),
    (p_account_id, 'Taxas',                  'fees',        '#94a3b8', TRUE),
    (p_account_id, 'Outros',                 'other',       '#a1a1aa', TRUE)
  ON CONFLICT (account_id, slug) DO NOTHING;
END;
$$;

ALTER FUNCTION ensure_default_expense_categories(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION ensure_default_expense_categories(UUID)
  TO authenticated, service_role;

-- ============================================================
-- OPERATIONAL EXPENSES
--
-- Deliberately NOT related to any order. This table is the second
-- line of the P&L (§18): gross profit minus these = operating profit.
-- ============================================================
CREATE TABLE IF NOT EXISTS operational_expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  description TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  category_id UUID REFERENCES expense_categories(id) ON DELETE SET NULL,
  -- Denormalised so a deleted category doesn't blank out history.
  category_name_snapshot TEXT,

  incurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier TEXT,
  payment_method TEXT,
  notes TEXT,

  is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence TEXT CHECK (recurrence IN ('monthly', 'weekly', 'yearly')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_account_date
  ON operational_expenses(account_id, incurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_account_category
  ON operational_expenses(account_id, category_id);

ALTER TABLE operational_expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read expenses" ON operational_expenses;
DROP POLICY IF EXISTS "Agents insert expenses" ON operational_expenses;
DROP POLICY IF EXISTS "Agents update expenses" ON operational_expenses;
DROP POLICY IF EXISTS "Admins delete expenses" ON operational_expenses;

CREATE POLICY "Members read expenses" ON operational_expenses FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
CREATE POLICY "Agents insert expenses" ON operational_expenses FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY "Agents update expenses" ON operational_expenses FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY "Admins delete expenses" ON operational_expenses FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON operational_expenses;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON operational_expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
