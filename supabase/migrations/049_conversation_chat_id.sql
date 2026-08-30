-- ============================================================
-- 049_conversation_chat_id.sql
--
-- Guarda o identificador COMPLETO do chat no provedor.
--
-- O PROBLEMA QUE ISTO RESOLVE
-- ---------------------------
-- O WhatsApp endereça conversas de duas formas:
--   5511999998888@c.us   → telefone
--   249460508647484@lid  → Linked ID, identificador interno
--
-- A versão anterior extraía só os dígitos e, na hora de enviar,
-- reconstruía como `@c.us`. Para um chat de LID isso produz um
-- endereço que não existe: o provedor aceita a chamada (HTTP 200) e
-- a mensagem não chega a ninguém. O operador vê "enviada" e o
-- cliente nunca recebe — o pior tipo de falha, porque é silenciosa
-- dos dois lados.
--
-- Guardar o identificador como veio elimina a adivinhação: enviamos
-- exatamente para o endereço de onde a mensagem chegou.
--
-- Apenas ADD COLUMN IF NOT EXISTS e CREATE OR REPLACE FUNCTION.
-- Nada existente é alterado ou removido.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS external_chat_id TEXT;

COMMENT ON COLUMN conversations.external_chat_id IS
  'Identificador do chat no provedor, com sufixo (@c.us ou @lid). '
  'Usado para endereçar o envio sem reconstruir a partir do telefone.';

CREATE INDEX IF NOT EXISTS idx_conversations_external_chat
  ON conversations(external_chat_id)
  WHERE external_chat_id IS NOT NULL;

-- ============================================================
-- INGESTÃO — agora recebe e persiste o chat id completo
-- ============================================================
CREATE OR REPLACE FUNCTION ingest_whatsapp_message(
  p_connection_id UUID,
  p_external_id TEXT,
  p_phone TEXT,
  p_push_name TEXT,
  p_content_type TEXT,
  p_content_text TEXT,
  p_media_url TEXT,
  p_from_me BOOLEAN,
  p_timestamp TIMESTAMPTZ,
  p_chat_id TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_owner UUID;
  v_contact UUID;
  v_conversation UUID;
  v_message UUID;
  v_tipo TEXT;
  v_inserido BOOLEAN;
BEGIN
  SELECT c.account_id INTO v_account
  FROM whatsapp_connections c WHERE c.id = p_connection_id;

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Unknown connection' USING ERRCODE = 'no_data_found';
  END IF;

  -- Reserva o id externo ANTES de gravar. Se outra entrega do mesmo
  -- evento chegar em paralelo, ela perde aqui e não duplica.
  INSERT INTO provider_message_map (
    connection_id, external_id, account_id, direction
  ) VALUES (
    p_connection_id, p_external_id, v_account,
    CASE WHEN p_from_me THEN 'outbound' ELSE 'inbound' END
  )
  ON CONFLICT (connection_id, external_id) DO NOTHING;

  GET DIAGNOSTICS v_inserido = ROW_COUNT;
  IF NOT v_inserido THEN
    RETURN NULL;
  END IF;

  v_contact := resolve_whatsapp_contact(v_account, p_phone, p_push_name);
  SELECT a.owner_user_id INTO v_owner FROM accounts a WHERE a.id = v_account;

  SELECT cv.id INTO v_conversation
  FROM conversations cv
  WHERE cv.account_id = v_account
    AND cv.contact_id = v_contact
  ORDER BY cv.created_at ASC
  LIMIT 1;

  IF v_conversation IS NULL THEN
    INSERT INTO conversations (
      account_id, user_id, contact_id, status,
      whatsapp_connection_id, external_chat_id
    ) VALUES (
      v_account, v_owner, v_contact, 'open',
      p_connection_id, p_chat_id
    )
    RETURNING id INTO v_conversation;
  ELSE
    -- COALESCE preserva o valor já gravado: o primeiro identificador
    -- visto é o que funciona, e sobrescrevê-lo a cada mensagem
    -- arriscaria trocar um endereço bom por um pior.
    UPDATE conversations
       SET whatsapp_connection_id = COALESCE(whatsapp_connection_id, p_connection_id),
           external_chat_id = COALESCE(external_chat_id, p_chat_id)
     WHERE id = v_conversation;
  END IF;

  v_tipo := CASE
    WHEN p_content_type IN ('text','image','document','audio','video','location','template')
      THEN p_content_type
    ELSE 'text'
  END;

  INSERT INTO messages (
    conversation_id, sender_type, content_type, content_text,
    media_url, message_id, status, created_at
  ) VALUES (
    v_conversation,
    CASE WHEN p_from_me THEN 'agent' ELSE 'customer' END,
    v_tipo, p_content_text, p_media_url, p_external_id,
    'delivered', COALESCE(p_timestamp, NOW())
  )
  RETURNING id INTO v_message;

  UPDATE provider_message_map
     SET message_id = v_message
   WHERE connection_id = p_connection_id AND external_id = p_external_id;

  UPDATE conversations SET
    last_message_text = LEFT(COALESCE(p_content_text, ''), 500),
    last_message_at = COALESCE(p_timestamp, NOW()),
    unread_count = CASE
      WHEN p_from_me THEN unread_count
      ELSE COALESCE(unread_count, 0) + 1
    END,
    updated_at = NOW()
  WHERE id = v_conversation;

  UPDATE whatsapp_connections
     SET last_seen_at = NOW()
   WHERE id = p_connection_id;

  RETURN v_message;
END;
$$;

ALTER FUNCTION ingest_whatsapp_message(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT)
  OWNER TO postgres;
GRANT EXECUTE ON FUNCTION ingest_whatsapp_message(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT)
  TO service_role;

-- ============================================================
-- BACKFILL das conversas existentes
--
-- Reconstrói o identificador a partir do telefone guardado.
-- Números com mais de 15 dígitos são LID (E.164 vai até 15), então
-- levam sufixo @lid; o resto, @c.us.
--
-- Não é perfeito — um LID de exatamente 15 dígitos fica indistinguível
-- de um telefone — mas é melhor que a alternativa atual, que é
-- reconstruir tudo como @c.us e falhar em silêncio.
-- ============================================================
UPDATE conversations c
SET external_chat_id = CASE
  WHEN length(regexp_replace(coalesce(ct.phone, ''), '[^0-9]', '', 'g')) > 15
    THEN regexp_replace(ct.phone, '[^0-9]', '', 'g') || '@lid'
  ELSE regexp_replace(ct.phone, '[^0-9]', '', 'g') || '@c.us'
END
FROM contacts ct
WHERE ct.id = c.contact_id
  AND c.external_chat_id IS NULL
  AND c.whatsapp_connection_id IS NOT NULL
  AND coalesce(ct.phone, '') <> '';
