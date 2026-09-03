-- ============================================================
-- 059 — Foto de perfil do contato
--
-- O webhook procurava o contato para gravar o avatar com
-- `phone LIKE '%' || <8 últimos dígitos>`, direto no PostgREST.
-- Duas coisas erradas nisso:
--
--   1. Comparava contra `contacts.phone` CRU, enquanto a ingestão
--      (`resolve_whatsapp_contact`) compara contra
--      `normalize_phone(contacts.phone)`. Um contato gravado como
--      "+55 11 99999-8888" nunca casava com "%99998888", porque o
--      hífen está no meio. O avatar simplesmente nunca era achado.
--
--   2. Sem `ORDER BY`, com `LIMIT 1`. Quando casava mais de um, o
--      Postgres devolvia qualquer linha — e no Brasil dois números
--      com os mesmos 8 dígitos finais não é raro. A foto podia ir
--      parar no contato errado.
--
-- Estas duas funções repetem exatamente o critério da ingestão, para
-- que avatar e mensagem nunca resolvam para contatos diferentes.
-- ============================================================

-- Há contato para este telefone e ele ainda está sem foto?
--
-- Existe para evitar a chamada ao serviço de WhatsApp quando ela
-- seria descartada: buscar a foto é uma requisição de rede por
-- mensagem recebida, para um dado que quase nunca muda.
CREATE OR REPLACE FUNCTION contact_avatar_missing(
  p_account_id UUID,
  p_phone TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm TEXT;
  v_avatar TEXT;
  v_achou BOOLEAN := FALSE;
BEGIN
  v_norm := normalize_phone(p_phone);
  IF v_norm IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT c.avatar_url, TRUE INTO v_avatar, v_achou
  FROM contacts c
  WHERE c.account_id = p_account_id
    AND RIGHT(normalize_phone(c.phone), 8) = RIGHT(v_norm, 8)
  ORDER BY c.created_at ASC
  LIMIT 1;

  RETURN COALESCE(v_achou, FALSE) AND v_avatar IS NULL;
END;
$$;

-- Grava a foto, e só se o contato ainda não tiver uma.
--
-- A condição `avatar_url IS NULL` fica DENTRO do UPDATE, e não numa
-- leitura anterior: entre a checagem e a escrita cabe outra mensagem
-- do mesmo contato fazendo o mesmo trabalho, e sem isso a segunda
-- sobrescreveria a primeira à toa.
CREATE OR REPLACE FUNCTION set_contact_avatar_by_phone(
  p_account_id UUID,
  p_phone TEXT,
  p_avatar_url TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm TEXT;
  v_contact UUID;
BEGIN
  v_norm := normalize_phone(p_phone);
  IF v_norm IS NULL OR p_avatar_url IS NULL OR TRIM(p_avatar_url) = '' THEN
    RETURN FALSE;
  END IF;

  SELECT c.id INTO v_contact
  FROM contacts c
  WHERE c.account_id = p_account_id
    AND RIGHT(normalize_phone(c.phone), 8) = RIGHT(v_norm, 8)
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF v_contact IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE contacts
     SET avatar_url = p_avatar_url,
         updated_at = NOW()
   WHERE id = v_contact
     AND avatar_url IS NULL;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION contact_avatar_missing(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_contact_avatar_by_phone(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION contact_avatar_missing(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION set_contact_avatar_by_phone(UUID, TEXT, TEXT) TO service_role;
