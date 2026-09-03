-- ============================================================
-- 053_payments_optional_webhook.sql
--
-- Torna a confirmação automática por webhook OPCIONAL.
--
-- POR QUE
-- -------
-- Cadastrar endpoint e segredo na Dotfy é um passo a mais que nem
-- toda operação quer dar. Quem cobra poucas vezes por dia confere no
-- painel da Dotfy e marca o pedido à mão — e isso é uma escolha
-- legítima, não uma configuração pela metade.
--
-- Antes, a ausência do segredo era tratada como pendência: o webhook
-- respondia 503 e a tela sugeria que faltava algo. Agora é uma
-- decisão explícita, e a interface para de cobrar por ela.
--
-- Apenas ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE payment_integrations
  ADD COLUMN IF NOT EXISTS webhook_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN payment_integrations.webhook_enabled IS
  'Confirmação automática de pagamento. Quando falso, o operador '
  'consulta o status manualmente e a rota de webhook ignora eventos '
  'desta conta.';

-- Contas que já cadastraram segredo estavam usando o webhook: o
-- backfill preserva a intenção delas em vez de desligar algo que
-- funcionava.
UPDATE payment_integrations
   SET webhook_enabled = TRUE
 WHERE encrypted_webhook_secret IS NOT NULL
   AND webhook_enabled = FALSE;

-- ============================================================
-- STATUS — agora informa se a confirmação é automática
--
-- A interface precisa disso para decidir entre "aguardando
-- pagamento" (o sistema avisa) e "aguardando confirmação" (você
-- precisa checar). Prometer confirmação automática onde ela não
-- existe é pior que não prometer nada.
-- ============================================================
-- DROP antes de recriar.
--
-- `CREATE OR REPLACE FUNCTION` não muda o formato de retorno de uma
-- função existente: a 052 declarou quatro colunas e esta declara
-- cinco, então o Postgres recusa com 42P13.
--
-- Dropar é seguro aqui porque `payment_status` é só leitura, não
-- guarda estado, e é recriada na linha seguinte. Nenhuma view ou
-- outra função depende dela — por isso RESTRICT (o padrão), e não
-- CASCADE: se algo passar a depender no futuro, é melhor a migration
-- falhar do que arrastar a dependência junto em silêncio.
DROP FUNCTION IF EXISTS payment_status(UUID);

CREATE FUNCTION payment_status(p_account_id UUID)
RETURNS TABLE (
  dotfy_enabled BOOLEAN,
  dotfy_configured BOOLEAN,
  environment TEXT,
  pix_key_count BIGINT,
  webhook_enabled BOOLEAN
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
      WHERE k.account_id = p_account_id AND k.is_active)::BIGINT,
    COALESCE(p.webhook_enabled, FALSE)
  FROM (SELECT 1) dummy
  LEFT JOIN payment_integrations p
    ON p.account_id = p_account_id AND p.provider = 'dotfy';
END;
$$;

ALTER FUNCTION payment_status(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION payment_status(UUID) TO authenticated, service_role;
