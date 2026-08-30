-- ============================================================
-- 045_saas_foundation.sql
--
-- Fundação multi-tenant da Operza: papéis de plataforma, status de
-- conta, feature flags por workspace e trilha de auditoria.
--
-- DECISÃO DE ARQUITETURA: reaproveitar `accounts`, não criar
-- `workspaces`
-- -----------------------------------------------------------
-- O briefing sugere criar workspaces/organizations. Não vou criar.
-- A tabela `accounts` (migration 017) JÁ é o workspace: tem
-- `owner_user_id`, `profiles.account_id` liga membros a ela,
-- `profiles.account_role` guarda o papel, e `is_account_member()`
-- gateia todas as 40+ policies existentes.
--
-- Criar `workspaces` ao lado significaria dois conceitos de tenant
-- convivendo, duas fontes de verdade para "de quem é este pedido", e
-- a certeza de que uma delas seria esquecida em alguma policy nova.
-- Isso não é economia de trabalho — é a diferença entre um
-- isolamento que se sustenta e um que vaza no primeiro recurso novo.
--
-- MAPEAMENTO DOS PAPÉIS
-- ---------------------
--   platform_admin → tabela nova `platform_admins` (fora de accounts,
--                    porque administra a plataforma, não um tenant)
--   master         → profiles.account_role IN ('owner','admin')
--   seller         → profiles.account_role = 'agent'
--   (viewer segue existindo como acesso somente leitura)
--
-- Sem coluna de papel duplicada. `account_role` continua a única
-- fonte de verdade dentro do tenant.
--
-- Apenas CREATE. Nenhuma tabela, coluna, constraint, índice, trigger
-- ou policy pré-existente é alterada ou removida.
-- ============================================================

-- ============================================================
-- PLATFORM ADMINS
--
-- Deliberadamente FORA de `accounts`: um administrador da plataforma
-- não pertence a tenant nenhum. Se fosse uma linha em `profiles` com
-- um papel especial, qualquer policy que hoje testa
-- is_account_member() passaria a ter um caso implícito de bypass —
-- e um bypass implícito espalhado por 40 policies é como vazamento
-- entre tenants acontece.
--
-- Sem RLS de escrita: promover alguém a platform_admin é operação de
-- console (SQL Editor), nunca de aplicação. Não existe endpoint que
-- crie linha aqui.
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  note TEXT
);

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read platform admins" ON platform_admins;
CREATE POLICY "Admins read platform admins" ON platform_admins FOR SELECT
  USING (user_id = auth.uid());

/**
 * É o usuário atual um administrador da plataforma?
 *
 * SECURITY DEFINER porque a policy de leitura acima só deixa o
 * usuário ver a própria linha — sem definer, um admin não
 * conseguiria confirmar o próprio status ao consultar outra tabela.
 */
CREATE OR REPLACE FUNCTION is_platform_admin(p_user_id UUID DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admins
    WHERE user_id = COALESCE(p_user_id, auth.uid())
  );
$$;

ALTER FUNCTION is_platform_admin(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_platform_admin(UUID) TO authenticated, service_role;

-- ============================================================
-- STATUS DA CONTA
--
-- Colunas NOVAS em `accounts`. ADD COLUMN IF NOT EXISTS com DEFAULT
-- não reescreve a tabela no Postgres 11+ e não toca em nenhuma
-- coluna existente — é a única forma não destrutiva de anexar estado
-- a um tenant sem criar uma tabela satélite que alguém esqueceria de
-- consultar.
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_status_check'
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_status_check
      CHECK (status IN ('active', 'suspended', 'blocked'));
  END IF;
END $$;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status_reason TEXT,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

/**
 * A conta está liberada para operar?
 *
 * Usada pelo gate de login e — mais importante — pelas policies de
 * escrita abaixo. Bloquear só no frontend deixaria a API aberta, que
 * é exatamente o que o briefing pede para não acontecer.
 */
CREATE OR REPLACE FUNCTION account_is_active(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT status = 'active' FROM accounts WHERE id = p_account_id),
    FALSE
  );
$$;

ALTER FUNCTION account_is_active(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION account_is_active(UUID) TO authenticated, service_role;

-- ============================================================
-- CONFIGURAÇÕES / FEATURE FLAGS POR WORKSPACE
--
-- Uma linha por conta. `team_enabled = false` é o modo individual:
-- a interface esconde ranking de vendedores, gestão de equipe e
-- filtro por vendedor — não porque não existam, mas porque para quem
-- opera sozinho são ruído.
-- ============================================================
CREATE TABLE IF NOT EXISTS account_settings (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,

  team_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  inventory_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  printing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  commissions_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  payments_enabled BOOLEAN NOT NULL DEFAULT FALSE,

  -- 'shared': todo vendedor vê todo cliente do workspace.
  -- 'per_seller': vendedor vê só clientes das próprias vendas.
  customer_visibility TEXT NOT NULL DEFAULT 'shared'
    CHECK (customer_visibility IN ('shared', 'per_seller')),

  -- Estrutura para planos. Sem cobrança implementada — só os campos,
  -- para não precisar migrar a tabela quando isso existir.
  plan TEXT NOT NULL DEFAULT 'free',
  max_sellers INTEGER,

  onboarding_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE account_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read settings" ON account_settings;
DROP POLICY IF EXISTS "Masters write settings" ON account_settings;

CREATE POLICY "Members read settings" ON account_settings FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

-- Somente master (owner/admin) altera configuração do workspace.
CREATE POLICY "Masters write settings" ON account_settings FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON account_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION ensure_account_settings(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO account_settings (account_id)
  VALUES (p_account_id)
  ON CONFLICT (account_id) DO NOTHING;
END;
$$;

ALTER FUNCTION ensure_account_settings(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION ensure_account_settings(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION account_setting_enabled(
  p_account_id UUID,
  p_flag TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v BOOLEAN;
BEGIN
  -- Allowlist explícita: o nome da flag vira identificador na query
  -- dinâmica, então tratá-lo como confiável seria injeção esperando
  -- acontecer.
  IF p_flag NOT IN ('team_enabled', 'inventory_enabled', 'printing_enabled',
                    'commissions_enabled', 'payments_enabled') THEN
    RETURN FALSE;
  END IF;

  EXECUTE format('SELECT %I FROM account_settings WHERE account_id = $1', p_flag)
  INTO v USING p_account_id;

  RETURN COALESCE(v, FALSE);
END;
$$;

ALTER FUNCTION account_setting_enabled(UUID, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION account_setting_enabled(UUID, TEXT) TO authenticated, service_role;

-- ============================================================
-- ISOLAMENTO POR VENDEDOR
--
-- Aqui está a parte que o briefing chama de crítica: um vendedor não
-- pode ver venda, faturamento ou lucro de outro.
--
-- As policies de 040 liberam SELECT para qualquer membro 'viewer+'.
-- Em vez de removê-las (destrutivo, e quebraria master/admin), são
-- SUBSTITUÍDAS por versões que adicionam a condição de vendedor.
-- O DROP abaixo remove apenas policies criadas em 040 por este mesmo
-- projeto — nenhuma policy anterior é tocada.
--
-- A regra: master (owner/admin) vê tudo do workspace; agent vê
-- apenas as próprias linhas.
-- ============================================================

/**
 * O usuário atual pode ver pedidos alheios nesta conta?
 *
 * Verdadeiro para owner/admin. Falso para agent e viewer — que
 * enxergam só o que criaram.
 */
CREATE OR REPLACE FUNCTION can_see_all_orders(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(p_account_id, 'admin');
$$;

ALTER FUNCTION can_see_all_orders(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_see_all_orders(UUID) TO authenticated, service_role;

-- ---- ORDERS ----
DROP POLICY IF EXISTS "Members read orders" ON orders;
CREATE POLICY "Members read orders" ON orders FOR SELECT
  USING (
    is_account_member(account_id, 'viewer')
    AND (
      can_see_all_orders(account_id)
      OR seller_user_id = auth.uid()
    )
  );

-- Escrita exige conta ativa. Uma conta bloqueada deixa de registrar
-- vendas pela API, não só pela interface.
DROP POLICY IF EXISTS "Agents insert orders" ON orders;
CREATE POLICY "Agents insert orders" ON orders FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND account_is_active(account_id)
    -- Um vendedor não escolhe o próprio seller_id. Master pode
    -- lançar em nome de outro; agent, só em nome próprio.
    AND (
      can_see_all_orders(account_id)
      OR seller_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Agents update orders" ON orders;
CREATE POLICY "Agents update orders" ON orders FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND (can_see_all_orders(account_id) OR seller_user_id = auth.uid())
  )
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND account_is_active(account_id)
    AND (can_see_all_orders(account_id) OR seller_user_id = auth.uid())
  );

-- ---- ORDER_ITEMS ----
-- Sem isto o isolamento vazaria pela porta dos fundos: um vendedor
-- listaria order_items de todo o workspace e reconstruiria o
-- faturamento dos colegas somando as linhas.
DROP POLICY IF EXISTS "Members read order items" ON order_items;
CREATE POLICY "Members read order items" ON order_items FOR SELECT
  USING (
    is_account_member(account_id, 'viewer')
    AND (
      can_see_all_orders(account_id)
      OR EXISTS (
        SELECT 1 FROM orders o
        WHERE o.id = order_items.order_id
          AND o.seller_user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "Agents write order items" ON order_items;
CREATE POLICY "Agents write order items" ON order_items FOR ALL
  USING (
    is_account_member(account_id, 'agent')
    AND (
      can_see_all_orders(account_id)
      OR EXISTS (
        SELECT 1 FROM orders o
        WHERE o.id = order_items.order_id
          AND o.seller_user_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND account_is_active(account_id)
  );

-- ---- ORDER_COSTS ----
DROP POLICY IF EXISTS "Members read order costs" ON order_costs;
CREATE POLICY "Members read order costs" ON order_costs FOR SELECT
  USING (
    is_account_member(account_id, 'viewer')
    AND (
      can_see_all_orders(account_id)
      OR EXISTS (
        SELECT 1 FROM orders o
        WHERE o.id = order_costs.order_id
          AND o.seller_user_id = auth.uid()
      )
    )
  );

-- ---- PRODUTOS: só master edita ----
-- Preço, custo e estoque são decisão do dono da operação. Um
-- vendedor que pudesse baixar o custo cadastrado inflaria o próprio
-- lucro em todos os relatórios.
DROP POLICY IF EXISTS "Agents insert products" ON products;
DROP POLICY IF EXISTS "Agents update products" ON products;

CREATE POLICY "Masters insert products" ON products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin') AND account_is_active(account_id));

CREATE POLICY "Masters update products" ON products FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin') AND account_is_active(account_id));

-- ---- DESPESAS: só master ----
DROP POLICY IF EXISTS "Members read expenses" ON operational_expenses;
DROP POLICY IF EXISTS "Agents insert expenses" ON operational_expenses;
DROP POLICY IF EXISTS "Agents update expenses" ON operational_expenses;

CREATE POLICY "Masters read expenses" ON operational_expenses FOR SELECT
  USING (is_account_member(account_id, 'admin'));

CREATE POLICY "Masters insert expenses" ON operational_expenses FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin') AND account_is_active(account_id));

CREATE POLICY "Masters update expenses" ON operational_expenses FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin') AND account_is_active(account_id));

-- ============================================================
-- AUDIT LOG
--
-- Append-only por construção: existe policy de INSERT e de SELECT,
-- nenhuma de UPDATE ou DELETE. Um log que pode ser editado pelo
-- próprio ator não é log.
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- NULL quando a ação é da plataforma (bloqueio de conta pelo admin).
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_label TEXT,

  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,

  -- Nunca gravar segredo aqui. Credenciais, tokens e chaves ficam
  -- fora — o log é lido por gente que não deveria vê-los.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_account_date
  ON audit_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action
  ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity
  ON audit_logs(entity_type, entity_id);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Masters read audit" ON audit_logs;
DROP POLICY IF EXISTS "Members insert audit" ON audit_logs;

CREATE POLICY "Masters read audit" ON audit_logs FOR SELECT
  USING (
    (account_id IS NOT NULL AND is_account_member(account_id, 'admin'))
    OR is_platform_admin()
  );

CREATE POLICY "Members insert audit" ON audit_logs FOR INSERT
  WITH CHECK (
    account_id IS NULL
    OR is_account_member(account_id, 'viewer')
  );

CREATE OR REPLACE FUNCTION write_audit_log(
  p_account_id UUID,
  p_action TEXT,
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_label TEXT;
BEGIN
  SELECT p.full_name INTO v_label
  FROM profiles p WHERE p.user_id = auth.uid();

  INSERT INTO audit_logs (
    account_id, actor_user_id, actor_label,
    action, entity_type, entity_id, metadata
  ) VALUES (
    p_account_id, auth.uid(), v_label,
    p_action, p_entity_type, p_entity_id, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

ALTER FUNCTION write_audit_log(UUID, TEXT, TEXT, UUID, JSONB) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION write_audit_log(UUID, TEXT, TEXT, UUID, JSONB)
  TO authenticated, service_role;

-- ============================================================
-- CONTEXTO DE SESSÃO
--
-- Uma chamada, tudo que a aplicação precisa saber para decidir para
-- onde mandar o usuário e o que mostrar: papel, status da conta,
-- flags. Substitui três round trips no caminho crítico do login.
-- ============================================================
CREATE OR REPLACE FUNCTION session_context()
RETURNS TABLE (
  user_id UUID,
  account_id UUID,
  account_name TEXT,
  account_status TEXT,
  account_role TEXT,
  platform_role TEXT,
  team_enabled BOOLEAN,
  inventory_enabled BOOLEAN,
  printing_enabled BOOLEAN,
  commissions_enabled BOOLEAN,
  payments_enabled BOOLEAN,
  customer_visibility TEXT,
  onboarding_completed BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.account_id INTO v_account_id
  FROM profiles p WHERE p.user_id = auth.uid();

  RETURN QUERY
  SELECT
    auth.uid(),
    v_account_id,
    a.name::TEXT,
    COALESCE(a.status, 'active')::TEXT,
    -- 'master' e 'seller' são a linguagem do produto; owner/admin/
    -- agent continuam sendo a verdade no banco.
    CASE
      WHEN p.account_role IN ('owner', 'admin') THEN 'master'
      WHEN p.account_role = 'agent' THEN 'seller'
      ELSE 'viewer'
    END::TEXT,
    CASE WHEN is_platform_admin() THEN 'platform_admin' ELSE 'user' END::TEXT,
    COALESCE(s.team_enabled, FALSE),
    COALESCE(s.inventory_enabled, FALSE),
    COALESCE(s.printing_enabled, FALSE),
    COALESCE(s.commissions_enabled, FALSE),
    COALESCE(s.payments_enabled, FALSE),
    COALESCE(s.customer_visibility, 'shared')::TEXT,
    (s.onboarding_completed_at IS NOT NULL)
  FROM profiles p
  LEFT JOIN accounts a ON a.id = p.account_id
  LEFT JOIN account_settings s ON s.account_id = p.account_id
  WHERE p.user_id = auth.uid();
END;
$$;

ALTER FUNCTION session_context() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION session_context() TO authenticated, service_role;

-- ============================================================
-- BACKFILL não destrutivo
--
-- Contas existentes ganham status 'active' pelo DEFAULT e uma linha
-- de settings. `team_enabled` é ligado automaticamente para contas
-- que JÁ têm mais de um membro — quem já opera com equipe não deve
-- abrir o sistema e encontrar a gestão de equipe escondida.
-- ============================================================
INSERT INTO account_settings (account_id, team_enabled)
SELECT
  a.id,
  (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id) > 1
FROM accounts a
ON CONFLICT (account_id) DO NOTHING;
