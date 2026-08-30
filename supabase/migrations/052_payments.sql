-- ============================================================
-- 052_payments.sql
--
-- Pagamentos: cobrança PIX pela Dotfy e chaves PIX estáticas.
--
-- DUAS FORMAS, DOIS PROBLEMAS DIFERENTES
-- --------------------------------------
-- Cobrança dinâmica (Dotfy) é um pedido de pagamento com valor,
-- vencimento e confirmação automática por webhook — vale o custo da
-- integração quando o valor varia e você precisa saber que pagou.
--
-- Chave estática é um dado que o operador copia e cola. Não tem
-- valor, não tem confirmação, não tem API. Modelar as duas como a
-- mesma coisa produziria uma "cobrança" que nunca sai de pendente e
-- envenenaria qualquer relatório de conversão.
--
-- Por isso são tabelas separadas.
--
-- Apenas CREATE. Nada existente é alterado.
-- ============================================================

-- ============================================================
-- INTEGRAÇÃO DE PAGAMENTO (Dotfy)
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_integrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  provider TEXT NOT NULL DEFAULT 'dotfy' CHECK (provider IN ('dotfy')),
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,

  -- A Dotfy distingue ambiente pelo PREFIXO da chave (vk_test_ /
  -- vk_live_), não por URL. Guardamos assim mesmo: mostrar na tela
  -- em qual ambiente a conta está evita o operador descobrir que
  -- estava em sandbox só quando o dinheiro não cai.
  environment TEXT NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),

  encrypted_api_key TEXT,
  api_key_hint TEXT,

  -- Segredo do webhook, fornecido pela Dotfy ao cadastrar o endpoint.
  encrypted_webhook_secret TEXT,

  -- Padrão de expiração da cobrança, em segundos. A API aceita de 60
  -- a 86400; 3600 é o default dela.
  default_expires_in INTEGER NOT NULL DEFAULT 3600
    CHECK (default_expires_in BETWEEN 60 AND 86400),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (account_id, provider)
);

ALTER TABLE payment_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Masters manage payments" ON payment_integrations;

-- Sem SELECT para não-master: a linha carrega credenciais cifradas.
-- O que o vendedor precisa saber vem da RPC `payment_status`.
CREATE POLICY "Masters manage payments" ON payment_integrations FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin') AND account_is_active(account_id));

DROP TRIGGER IF EXISTS set_updated_at ON payment_integrations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON payment_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- CHAVES PIX ESTÁTICAS
--
-- Não são credencial: são dado público que o cliente vai receber de
-- qualquer forma. Por isso o vendedor LÊ (precisa copiar durante o
-- atendimento) mas só master ESCREVE — mudar a chave de recebimento
-- é decisão do dono.
-- ============================================================
CREATE TABLE IF NOT EXISTS pix_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  label TEXT NOT NULL,
  key_type TEXT NOT NULL
    CHECK (key_type IN ('cpf', 'cnpj', 'email', 'phone', 'random')),
  key_value TEXT NOT NULL,

  -- Nome do titular, para o operador enviar junto e o cliente
  -- conferir antes de pagar.
  holder_name TEXT,

  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pix_keys_account
  ON pix_keys(account_id, is_active);

-- Uma chave padrão por conta. Índice parcial em vez de trigger: o
-- banco recusa a segunda no INSERT, sem código para manter.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pix_keys_one_default
  ON pix_keys(account_id)
  WHERE is_default AND is_active;

ALTER TABLE pix_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read pix keys" ON pix_keys;
DROP POLICY IF EXISTS "Masters write pix keys" ON pix_keys;

CREATE POLICY "Members read pix keys" ON pix_keys FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

CREATE POLICY "Masters write pix keys" ON pix_keys FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin') AND account_is_active(account_id));

DROP TRIGGER IF EXISTS set_updated_at ON pix_keys;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON pix_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- COBRANÇAS
--
-- `correlation_id` é gerado pela Dotfy (a API não aceita um nosso) e
-- é a chave de conciliação: o webhook chega com ele, e é por ele que
-- consultamos status. UNIQUE por conta para o webhook nunca casar
-- com a cobrança de outro workspace.
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_charges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- SET NULL: apagar um pedido não pode apagar o registro de um
  -- pagamento que existiu de verdade.
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  provider TEXT NOT NULL DEFAULT 'dotfy',
  correlation_id TEXT NOT NULL,
  external_id TEXT,

  -- Em CENTAVOS, como todo dinheiro neste sistema. A API da Dotfy
  -- recebe reais e devolve centavos; a conversão acontece no adapter,
  -- num lugar só.
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired', 'canceled', 'failed')),

  description TEXT,
  qr_code TEXT,
  qr_code_image TEXT,
  payment_link TEXT,

  expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (account_id, correlation_id)
);

CREATE INDEX IF NOT EXISTS idx_charges_account_status
  ON payment_charges(account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_charges_contact
  ON payment_charges(contact_id);
CREATE INDEX IF NOT EXISTS idx_charges_correlation
  ON payment_charges(correlation_id);

ALTER TABLE payment_charges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read charges" ON payment_charges;
DROP POLICY IF EXISTS "Agents create charges" ON payment_charges;

-- Vendedor vê as cobranças que criou; master vê todas. Mesma regra
-- do isolamento de pedidos (045) — uma cobrança revela o valor de
-- uma venda.
CREATE POLICY "Members read charges" ON payment_charges FOR SELECT
  USING (
    is_account_member(account_id, 'viewer')
    AND (
      can_see_all_orders(account_id)
      OR created_by_user_id = auth.uid()
    )
  );

CREATE POLICY "Agents create charges" ON payment_charges FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND account_is_active(account_id)
    AND created_by_user_id = auth.uid()
  );

-- Sem policy de UPDATE: só o webhook muda status, com service role.
-- Um vendedor não pode marcar a própria cobrança como paga.

DROP TRIGGER IF EXISTS set_updated_at ON payment_charges;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON payment_charges
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- STATUS PARA O VENDEDOR
--
-- Booleanos e a chave PIX padrão. Nenhuma credencial.
-- ============================================================
CREATE OR REPLACE FUNCTION payment_status(p_account_id UUID)
RETURNS TABLE (
  dotfy_enabled BOOLEAN,
  dotfy_configured BOOLEAN,
  environment TEXT,
  pix_key_count BIGINT
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
    COALESCE(p.is_enabled, FALSE),
    COALESCE(p.encrypted_api_key IS NOT NULL, FALSE),
    COALESCE(p.environment, 'sandbox')::TEXT,
    (SELECT COUNT(*) FROM pix_keys k
      WHERE k.account_id = p_account_id AND k.is_active)::BIGINT
  FROM (SELECT 1) dummy
  LEFT JOIN payment_integrations p
    ON p.account_id = p_account_id AND p.provider = 'dotfy';
END;
$$;

ALTER FUNCTION payment_status(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION payment_status(UUID) TO authenticated, service_role;

-- ============================================================
-- CONFIRMAÇÃO DE PAGAMENTO
--
-- Chamada pelo webhook. Idempotente: uma cobrança já paga não é
-- reprocessada, porque a Dotfy reentrega o evento e marcar duas
-- vezes moveria o pedido de status indevidamente.
-- ============================================================
CREATE OR REPLACE FUNCTION confirm_payment(
  p_account_id UUID,
  p_correlation_id TEXT,
  p_paid_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge UUID;
  v_order UUID;
  v_status TEXT;
BEGIN
  SELECT c.id, c.order_id, c.status
  INTO v_charge, v_order, v_status
  FROM payment_charges c
  WHERE c.account_id = p_account_id
    AND c.correlation_id = p_correlation_id;

  IF v_charge IS NULL THEN
    RETURN NULL;
  END IF;

  -- Já processada. Não é erro: a Dotfy reentrega até receber 200.
  IF v_status = 'paid' THEN
    RETURN v_charge;
  END IF;

  UPDATE payment_charges
     SET status = 'paid', paid_at = COALESCE(p_paid_at, NOW())
   WHERE id = v_charge;

  -- Avança o pedido para 'paid' se ele ainda estiver em 'new'.
  --
  -- Só a partir de 'new': se o operador já moveu para "preparando"
  -- ou "enviado", voltar para "pago" desfaria trabalho humano com
  -- base num evento que chegou atrasado.
  IF v_order IS NOT NULL THEN
    UPDATE orders
       SET status = 'paid'
     WHERE id = v_order AND status = 'new';
  END IF;

  RETURN v_charge;
END;
$$;

ALTER FUNCTION confirm_payment(UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION confirm_payment(UUID, TEXT, TIMESTAMPTZ) TO service_role;
