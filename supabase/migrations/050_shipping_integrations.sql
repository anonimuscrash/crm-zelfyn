-- ============================================================
-- 050_shipping_integrations.sql
--
-- Integração de frete por workspace. Primeiro provedor: SuperFrete.
--
-- TABELA PRÓPRIA, NÃO UMA FLAG EM account_settings
-- ------------------------------------------------
-- Credenciais têm ciclo de vida e requisitos de acesso diferentes de
-- configuração comum: são cifradas, nunca voltam ao frontend, e só
-- master lê ou escreve. Guardá-las ao lado de `team_enabled` faria
-- toda leitura de configuração arrastar segredo junto — e bastaria
-- um `select *` esquecido em qualquer tela para vazá-lo.
--
-- A estrutura já nasce multi-provedor (`provider`), porque adicionar
-- Melhor Envio ou Frete Rápido depois não deve exigir migration.
--
-- Apenas CREATE. Nada existente é alterado.
-- ============================================================

CREATE TABLE IF NOT EXISTS shipping_integrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  provider TEXT NOT NULL DEFAULT 'superfrete'
    CHECK (provider IN ('superfrete')),

  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,

  -- 'sandbox' | 'production'. Separado do token porque trocar de
  -- ambiente é operação comum durante a implantação, e não deveria
  -- exigir recolar a credencial.
  environment TEXT NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),

  -- Cifrado em repouso com a mesma ENCRYPTION_KEY que protege os
  -- tokens da Meta. NUNCA retornado ao frontend, nem parcialmente.
  encrypted_token TEXT,

  -- Últimos 4 caracteres, em claro, só para a tela confirmar QUAL
  -- credencial está salva sem revelá-la: "••••••••X92F".
  token_hint TEXT,

  -- O SuperFrete exige User-Agent identificando a aplicação e um
  -- e-mail de contato técnico. Sem isso a API recusa.
  contact_email TEXT,

  -- ---- Padrões do remetente ----
  -- CEP de origem e dimensões da caixa habitual. Guardados para o
  -- vendedor cotar durante a conversa digitando só o CEP do cliente
  -- — pedir cinco medidas no meio de um atendimento inviabiliza o
  -- uso.
  origin_postal_code TEXT,
  default_height_cm NUMERIC(6,2) NOT NULL DEFAULT 4,
  default_width_cm NUMERIC(6,2) NOT NULL DEFAULT 12,
  default_length_cm NUMERIC(6,2) NOT NULL DEFAULT 17,
  default_weight_kg NUMERIC(6,3) NOT NULL DEFAULT 0.3,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (account_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_shipping_integrations_account
  ON shipping_integrations(account_id);

ALTER TABLE shipping_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Masters manage shipping" ON shipping_integrations;

-- SEM policy de SELECT para não-master, de propósito.
--
-- A linha inteira contém o token cifrado. Mesmo cifrado, não há
-- motivo para um vendedor conseguir lê-la. O que ele precisa saber
-- — "a cotação está disponível?" — vem da RPC abaixo, que devolve
-- só booleanos.
CREATE POLICY "Masters manage shipping" ON shipping_integrations FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin') AND account_is_active(account_id));

DROP TRIGGER IF EXISTS set_updated_at ON shipping_integrations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shipping_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

/**
 * O que o vendedor precisa saber sobre a integração de frete.
 *
 * Booleanos e padrões públicos. Nenhum token, nem o `token_hint` —
 * o vendedor não precisa nem confirmar qual credencial está em uso.
 */
CREATE OR REPLACE FUNCTION shipping_status(p_account_id UUID)
RETURNS TABLE (
  provider TEXT,
  is_enabled BOOLEAN,
  is_configured BOOLEAN,
  has_origin BOOLEAN,
  environment TEXT
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
    s.provider::TEXT,
    s.is_enabled,
    (s.encrypted_token IS NOT NULL AND s.contact_email IS NOT NULL),
    (COALESCE(s.origin_postal_code, '') <> ''),
    s.environment::TEXT
  FROM shipping_integrations s
  WHERE s.account_id = p_account_id;
END;
$$;

ALTER FUNCTION shipping_status(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION shipping_status(UUID) TO authenticated, service_role;

-- ============================================================
-- CEP DO CLIENTE
--
-- Coluna nova em `contacts`. Guardar o CEP evita que o vendedor
-- redigite a cada cotação — e é a informação que ele acabou de pedir
-- ao cliente na conversa.
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS postal_code TEXT;

COMMENT ON COLUMN contacts.postal_code IS
  'CEP do cliente, só dígitos. Preenchido na cotação de frete.';
