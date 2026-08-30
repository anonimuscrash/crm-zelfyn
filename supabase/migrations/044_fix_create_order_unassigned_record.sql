-- ============================================================
-- 044_fix_create_order_unassigned_record.sql
--
-- Corrige: record "v_contact" is not assigned yet
--
-- CAUSA
-- -----
-- `v_contact` e `v_product` eram declarados como RECORD e só
-- recebiam valor dentro de um IF. Em plpgsql, ler um campo de um
-- RECORD que nunca foi atribuído levanta exceção — não devolve NULL.
--
-- Então duas operações perfeitamente válidas quebravam:
--
--   1. Venda sem cliente vinculado (balcão, WhatsApp de número
--      desconhecido) → v_contact nunca atribuído → erro no INSERT.
--   2. Item avulso sem produto cadastrado (um serviço, um frete
--      cobrado à parte) → v_product nunca atribuído → erro ao ler
--      v_product.unit_price_cents.
--
-- CORREÇÃO
-- --------
-- Trocados por variáveis ESCALARES, que nascem NULL e podem ser
-- lidas sem atribuição prévia. O COALESCE que já existia então
-- funciona como sempre foi a intenção: usa o valor enviado, senão o
-- do produto, senão zero.
--
-- O resto da função é idêntico — mesma validação de conta cruzada,
-- mesmo snapshot de preço e custo, mesma transação atômica.
--
-- Apenas CREATE OR REPLACE FUNCTION. Nenhuma tabela, coluna, índice,
-- policy ou dado é tocado.
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
  v_price BIGINT;
  v_unit_cost BIGINT;
  v_qty INTEGER;
  v_disc_kind TEXT;
  v_disc_value BIGINT;
  v_disc_cents BIGINT;
  v_pos INTEGER := 0;

  -- Escalares em vez de RECORD: nascem NULL e podem ser lidas mesmo
  -- quando a venda não tem cliente ou a linha não tem produto.
  v_contact_id UUID;
  v_contact_name TEXT;
  v_contact_phone TEXT;

  v_product_id UUID;
  v_product_name TEXT;
  v_product_sku TEXT;
  v_product_price BIGINT;
  v_product_cost BIGINT;
BEGIN
  -- Gravar dados exige pelo menos 'agent'; viewers não lançam vendas.
  PERFORM assert_account_access(p_account_id, 'agent');

  IF jsonb_typeof(p_payload->'items') <> 'array'
     OR jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'An order needs at least one item'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_number := next_order_number(p_account_id);

  -- Snapshot da identidade do cliente. O contato precisa pertencer a
  -- esta conta — um contact_id de outro tenant é exatamente o buraco
  -- que precisa ficar fechado.
  IF p_payload->>'contact_id' IS NOT NULL THEN
    SELECT c.id, c.name, c.phone
    INTO v_contact_id, v_contact_name, v_contact_phone
    FROM contacts c
    WHERE c.id = (p_payload->>'contact_id')::UUID
      AND c.account_id = p_account_id;

    IF v_contact_id IS NULL THEN
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
    v_contact_id,
    v_contact_name,
    v_contact_phone,
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

    -- Zera a cada volta do laço: sem isso, uma linha sem produto
    -- herdaria o preço da linha anterior.
    v_product_id := NULL;
    v_product_name := NULL;
    v_product_sku := NULL;
    v_product_price := NULL;
    v_product_cost := NULL;

    IF v_item->>'product_id' IS NOT NULL THEN
      SELECT pr.id, pr.name, pr.sku, pr.unit_price_cents, pr.unit_cost_cents
      INTO v_product_id, v_product_name, v_product_sku,
           v_product_price, v_product_cost
      FROM products pr
      WHERE pr.id = (v_item->>'product_id')::UUID
        AND pr.account_id = p_account_id;

      IF v_product_id IS NULL THEN
        RAISE EXCEPTION 'Product does not belong to this account'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;

    -- Valor explícito vence; senão, snapshot do produto neste instante.
    -- É aqui que "histórico nunca se move" (§9) é garantido.
    v_price := COALESCE(
      (v_item->>'unit_price_cents')::BIGINT,
      v_product_price,
      0
    );
    v_unit_cost := COALESCE(
      (v_item->>'unit_cost_cents')::BIGINT,
      v_product_cost,
      0
    );

    v_disc_kind := COALESCE(v_item->>'discount_kind', 'fixed');
    v_disc_value := GREATEST(COALESCE((v_item->>'discount_value')::BIGINT, 0), 0);

    IF v_disc_kind = 'percent' THEN
      -- Basis points, arredondado half-up, aplicado à linha inteira.
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
      v_product_id,
      COALESCE(v_item->>'product_name', v_product_name, 'Item'),
      COALESCE(v_item->>'product_sku', v_product_sku),
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

  -- Os triggers já dispararam linha a linha; esta passada final
  -- garante o cabeçalho consistente mesmo se algum ramo acima
  -- não tiver executado.
  PERFORM recalculate_order_totals(v_order_id);

  RETURN v_order_id;
END;
$$;

ALTER FUNCTION commerce_create_order(UUID, JSONB) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION commerce_create_order(UUID, JSONB)
  TO authenticated, service_role;
