-- ============================================================
-- 051_shipping_services.sql
--
-- Filtro opcional de serviços na cotação.
--
-- POR QUE ISTO EXISTE
-- -------------------
-- A cotação estava devolvendo só uma transportadora. A API aceita um
-- parâmetro `services` com os IDs desejados; sem ele, o retorno
-- depende do que está habilitado na conta SuperFrete — e essa
-- configuração vive lá, não aqui.
--
-- Deixar o campo VAZIO mantém o comportamento atual (o provedor
-- decide). Preenchido, força a consulta a pedir exatamente aqueles
-- serviços. É controle para quando o padrão não serve, não uma
-- exigência de configuração.
--
-- Apenas ADD COLUMN IF NOT EXISTS. Nada existente é alterado.
-- ============================================================

ALTER TABLE shipping_integrations
  ADD COLUMN IF NOT EXISTS services TEXT;

COMMENT ON COLUMN shipping_integrations.services IS
  'IDs de serviço separados por vírgula (ex: "1,2,17"). '
  'Vazio = deixa o provedor decidir quais retornar.';
