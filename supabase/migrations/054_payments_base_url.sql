-- ============================================================
-- 054_payments_base_url.sql
--
-- Torna o endereço da API da Dotfy configurável.
--
-- POR QUE
-- -------
-- A documentação mostra a rota como `/api/charges` — caminho
-- relativo, sem o host. Eu supus `api.dotfy.com.br`; todas as
-- referências concretas da documentação (checkout, dashboard, painel
-- de chaves) apontam para `app.dotfy.com.br`.
--
-- O sintoma de errar isso é péssimo: o fetch falha sem resposta e a
-- tela diz "serviço indisponível", que soa como problema deles.
--
-- Guardar o endereço num campo faz uma suposição errada virar um
-- ajuste de um minuto em vez de um deploy.
--
-- Apenas ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE payment_integrations
  ADD COLUMN IF NOT EXISTS base_url TEXT;

COMMENT ON COLUMN payment_integrations.base_url IS
  'Host da API da Dotfy, sem barra final. Vazio usa o padrão '
  'https://app.dotfy.com.br.';
