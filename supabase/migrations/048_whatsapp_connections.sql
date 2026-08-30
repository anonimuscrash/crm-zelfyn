-- ============================================================
-- 048_whatsapp_connections.sql
--
-- Conexões de WhatsApp por workspace, com dois provedores:
-- Meta Cloud API (oficial) e QR (sessão do WhatsApp Web via serviço
-- self-hosted).
--
-- O QUE É REAPROVEITADO
-- ---------------------
-- `conversations` e `messages` JÁ são multi-tenant por account_id
-- (migration 017) e já cobrem o que a Inbox precisa. Não crio
-- tabelas paralelas de conversa nem de mensagem: duas fontes de
-- verdade para "qual foi a última mensagem deste contato" é como a
-- Inbox começa a divergir de si mesma.
--
-- `whatsapp_config` (Meta Cloud) continua existindo e funcionando.
-- Esta migration NÃO a toca — a integração oficial segue de pé (§34).
--
-- O QUE É NOVO
-- ------------
--   whatsapp_connections        — uma linha por número conectado
--   whatsapp_connection_members — quais vendedores atendem em qual
--   whatsapp_events             — trilha técnica de conexão
--   provider_message_map        — deduplicação por ID externo
--
-- Apenas CREATE e ADD COLUMN IF NOT EXISTS. Nenhuma tabela, coluna,
-- constraint, índice, trigger ou policy pré-existente é alterada
-- ou removida.
-- ============================================================

-- ============================================================
-- WHATSAPP_CONNECTIONS
--
-- `instance_identifier` é o nome da sessão no serviço QR. Gerado
-- pelo servidor a partir do id da conexão, nunca escolhido pelo
-- cliente: um identificador previsível deixaria um workspace
-- adivinhar (e tentar operar) a sessão de outro.
--
-- `encrypted_credentials` guarda o que for específico do provedor
-- (token de instância, chave de webhook). Cifrado em repouso com a
-- mesma ENCRYPTION_KEY que já protege os tokens da Meta. NUNCA
-- retornado ao frontend — nem parcialmente (§23).
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- 'meta_cloud' | 'qr'. Cada conexão é de UM provedor e não migra
  -- entre eles (§35): converter uma sessão QR em número oficial da
  -- Meta não é uma operação que exista no mundo real.
  provider TEXT NOT NULL CHECK (provider IN ('meta_cloud', 'qr')),

  -- Rótulo do operador: "Comercial", "Suporte".
  name TEXT NOT NULL,

  -- Preenchido só depois que a sessão conecta e o número é conhecido.
  phone_number TEXT,
  display_name TEXT,

  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN (
    'disconnected',   -- nunca conectou, ou desconectada de propósito
    'connecting',     -- sessão subindo no serviço
    'qr_required',    -- QR disponível, esperando leitura
    'qr_expired',     -- QR venceu sem ser lido
    'connected',
    'logged_out',     -- desconectada pelo celular
    'failed'
  )),
  status_detail TEXT,

  instance_identifier TEXT,
  encrypted_credentials TEXT,

  -- Quando o QR foi gerado. O QR em si NÃO é persistido: é efêmero,
  -- vale segundos, e guardar um QR de pareamento no banco seria
  -- guardar uma credencial de sessão.
  qr_issued_at TIMESTAMPTZ,
  last_connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,

  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_conn_account
  ON whatsapp_connections(account_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_conn_instance
  ON whatsapp_connections(instance_identifier)
  WHERE instance_identifier IS NOT NULL;

ALTER TABLE whatsapp_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read connections" ON whatsapp_connections;
DROP POLICY IF EXISTS "Masters write connections" ON whatsapp_connections;

-- Vendedor precisa LER a conexão para saber de qual número está
-- atendendo. A coluna de credenciais nunca sai do banco pela API —
-- as rotas selecionam colunas explícitas.
CREATE POLICY "Members read connections" ON whatsapp_connections FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

-- Criar, parear, desconectar e remover: só master (§6).
CREATE POLICY "Masters write connections" ON whatsapp_connections FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin') AND account_is_active(account_id));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- MEMBROS DA CONEXÃO (§7)
--
-- Ausência de linhas = todo mundo do workspace atende naquele
-- número. Só quando o master restringe explicitamente é que a
-- tabela ganha linhas.
--
-- A alternativa — exigir uma linha por vendedor por conexão — faria
-- um master individual precisar cadastrar a si mesmo antes de usar
-- o próprio WhatsApp, e faria cada vendedor novo aparecer sem
-- acesso a nada.
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_connection_members (
  connection_id UUID NOT NULL REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (connection_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_conn_members_user
  ON whatsapp_connection_members(user_id);

ALTER TABLE whatsapp_connection_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read connection members" ON whatsapp_connection_members;
DROP POLICY IF EXISTS "Masters write connection members" ON whatsapp_connection_members;

CREATE POLICY "Members read connection members" ON whatsapp_connection_members FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

CREATE POLICY "Masters write connection members" ON whatsapp_connection_members FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

/**
 * O usuário atual pode atender nesta conexão?
 *
 * Master sempre pode. Vendedor pode quando não há restrição alguma
 * na conexão, ou quando está explicitamente na lista.
 */
CREATE OR REPLACE FUNCTION can_use_whatsapp_connection(p_connection_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_restrita BOOLEAN;
BEGIN
  SELECT c.account_id INTO v_account
  FROM whatsapp_connections c WHERE c.id = p_connection_id;

  IF v_account IS NULL THEN
    RETURN FALSE;
  END IF;
  IF NOT is_account_member(v_account, 'viewer') THEN
    RETURN FALSE;
  END IF;
  IF is_account_member(v_account, 'admin') THEN
    RETURN TRUE;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM whatsapp_connection_members m
    WHERE m.connection_id = p_connection_id
  ) INTO v_restrita;

  IF NOT v_restrita THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM whatsapp_connection_members m
    WHERE m.connection_id = p_connection_id
      AND m.user_id = auth.uid()
  );
END;
$$;

ALTER FUNCTION can_use_whatsapp_connection(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_use_whatsapp_connection(UUID) TO authenticated, service_role;

-- ============================================================
-- LIGAÇÃO DAS CONVERSAS À CONEXÃO
--
-- Coluna nova em `conversations`, nullable: as conversas que já
-- existem vieram da integração Meta e continuam válidas sem
-- conexão associada. Nada é reescrito.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_connection_id UUID
    REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

-- `ON DELETE SET NULL`, não CASCADE: remover uma conexão NÃO pode
-- apagar conversas, clientes ou histórico (§20). Só interrompe a
-- sincronização futura.

CREATE INDEX IF NOT EXISTS idx_conversations_connection
  ON conversations(whatsapp_connection_id)
  WHERE whatsapp_connection_id IS NOT NULL;

-- Quem enviou a mensagem, para métricas de atendimento (§30).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sent_by_user_id UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_sent_by
  ON messages(sent_by_user_id)
  WHERE sent_by_user_id IS NOT NULL;

-- ============================================================
-- DEDUPLICAÇÃO (§28)
--
-- O serviço QR reentrega eventos em reconexão e em falha de ACK. A
-- constraint UNIQUE aqui é o que impede a mesma mensagem de
-- aparecer duas vezes na Inbox — o INSERT do webhook usa
-- ON CONFLICT DO NOTHING e descobre pelo resultado se já tinha
-- processado.
--
-- Chave por (conexão, id externo): dois workspaces podem receber
-- mensagens com o mesmo id se usarem instâncias distintas do
-- serviço, e a unicidade global rejeitaria a segunda.
-- ============================================================
CREATE TABLE IF NOT EXISTS provider_message_map (
  connection_id UUID NOT NULL REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (connection_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_msg_map_message
  ON provider_message_map(message_id);

ALTER TABLE provider_message_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read message map" ON provider_message_map;
CREATE POLICY "Members read message map" ON provider_message_map FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
-- Sem policy de escrita: só o webhook grava aqui, com service role.

-- ============================================================
-- EVENTOS DE CONEXÃO (§43)
--
-- Trilha técnica: conectou, caiu, QR expirou, webhook falhou. Serve
-- ao suporte, não ao usuário — a tela mostra "Desconectado", não
-- este log.
--
-- `payload` guarda contexto do evento. NUNCA token, chave de sessão
-- ou conteúdo de mensagem: quem lê log de conexão está diagnosticando
-- infraestrutura, não precisa ver o que o cliente escreveu.
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_events_conn
  ON whatsapp_events(connection_id, created_at DESC);

ALTER TABLE whatsapp_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Masters read wa events" ON whatsapp_events;
CREATE POLICY "Masters read wa events" ON whatsapp_events FOR SELECT
  USING (is_account_member(account_id, 'admin'));
-- Append-only: sem policy de UPDATE ou DELETE.

-- ============================================================
-- RESOLUÇÃO DE CONTATO (§12)
--
-- Chega mensagem de um número: achar o contato existente ou criar
-- um, sem duplicar.
--
-- A normalização acontece ANTES da busca. Sem isso, "+55 11 99999-
-- 8888" e "5511999998888" viram dois contatos para a mesma pessoa,
-- e o histórico comercial dela se parte em dois.
--
-- Comparação pelos últimos 8 dígitos: no Brasil o nono dígito e o
-- código do país aparecem de forma inconsistente conforme a origem
-- do evento, e exigir igualdade exata criaria exatamente a
-- duplicata que esta função existe para evitar.
-- ============================================================
CREATE OR REPLACE FUNCTION normalize_phone(p_phone TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(REGEXP_REPLACE(COALESCE(p_phone, ''), '[^0-9]', '', 'g'), '');
$$;

GRANT EXECUTE ON FUNCTION normalize_phone(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION resolve_whatsapp_contact(
  p_account_id UUID,
  p_phone TEXT,
  p_push_name TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm TEXT;
  v_sufixo TEXT;
  v_contact UUID;
  v_owner UUID;
BEGIN
  v_norm := normalize_phone(p_phone);
  IF v_norm IS NULL THEN
    RAISE EXCEPTION 'Phone number is empty'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_sufixo := RIGHT(v_norm, 8);

  SELECT c.id INTO v_contact
  FROM contacts c
  WHERE c.account_id = p_account_id
    AND RIGHT(normalize_phone(c.phone), 8) = v_sufixo
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF v_contact IS NOT NULL THEN
    -- Só preenche o nome se estiver vazio. O nome que o operador
    -- digitou vale mais que o "push name" que o cliente pôs no
    -- próprio perfil, e sobrescrever apagaria trabalho humano.
    IF p_push_name IS NOT NULL AND TRIM(p_push_name) <> '' THEN
      UPDATE contacts
         SET name = TRIM(p_push_name)
       WHERE id = v_contact
         AND (name IS NULL OR TRIM(name) = '' OR name = phone);
    END IF;
    RETURN v_contact;
  END IF;

  SELECT a.owner_user_id INTO v_owner FROM accounts a WHERE a.id = p_account_id;

  INSERT INTO contacts (account_id, user_id, name, phone)
  VALUES (
    p_account_id,
    v_owner,
    COALESCE(NULLIF(TRIM(p_push_name), ''), v_norm),
    v_norm
  )
  RETURNING id INTO v_contact;

  RETURN v_contact;
END;
$$;

ALTER FUNCTION resolve_whatsapp_contact(UUID, TEXT, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_contact(UUID, TEXT, TEXT)
  TO authenticated, service_role;

-- ============================================================
-- INGESTÃO DE MENSAGEM RECEBIDA
--
-- Uma transação: resolve contato, acha ou cria a conversa,
-- deduplica e grava. Feito no banco porque a alternativa — quatro
-- chamadas PostgREST do handler de webhook — deixaria estado pela
-- metade sempre que uma delas falhasse, e webhooks falham.
--
-- Retorna NULL quando a mensagem já tinha sido processada. O
-- chamador responde 200 mesmo assim: um webhook que recebe erro
-- reentrega, e reentregar algo já processado é justamente o que
-- estamos evitando.
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
  p_timestamp TIMESTAMPTZ
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
    RAISE EXCEPTION 'Unknown connection'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Reserva o id externo ANTES de gravar qualquer coisa. Se outra
  -- entrega do mesmo evento chegar em paralelo, ela perde aqui e
  -- não duplica a mensagem.
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
      account_id, user_id, contact_id, status, whatsapp_connection_id
    ) VALUES (
      v_account, v_owner, v_contact, 'open', p_connection_id
    )
    RETURNING id INTO v_conversation;
  ELSE
    -- Amarra a conversa à conexão por onde a mensagem chegou, sem
    -- sobrescrever uma amarração anterior.
    UPDATE conversations
       SET whatsapp_connection_id = COALESCE(whatsapp_connection_id, p_connection_id)
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
    v_tipo,
    p_content_text,
    p_media_url,
    p_external_id,
    'delivered',
    COALESCE(p_timestamp, NOW())
  )
  RETURNING id INTO v_message;

  UPDATE provider_message_map
     SET message_id = v_message
   WHERE connection_id = p_connection_id AND external_id = p_external_id;

  UPDATE conversations SET
    last_message_text = LEFT(COALESCE(p_content_text, ''), 500),
    last_message_at = COALESCE(p_timestamp, NOW()),
    -- Mensagem enviada pelo próprio operador não conta como não lida.
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

ALTER FUNCTION ingest_whatsapp_message(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TIMESTAMPTZ)
  OWNER TO postgres;
GRANT EXECUTE ON FUNCTION ingest_whatsapp_message(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TIMESTAMPTZ)
  TO service_role;

-- ============================================================
-- LISTAGEM PARA A INBOX
--
-- Devolve só as conexões em que o usuário atual pode atender, sem
-- nenhuma coluna sensível. É o que o frontend consome.
-- ============================================================
CREATE OR REPLACE FUNCTION whatsapp_connections_for_user(p_account_id UUID)
RETURNS TABLE (
  id UUID,
  provider TEXT,
  name TEXT,
  phone_number TEXT,
  display_name TEXT,
  status TEXT,
  status_detail TEXT,
  qr_issued_at TIMESTAMPTZ,
  last_connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  member_count BIGINT,
  restricted BOOLEAN,
  created_at TIMESTAMPTZ
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
    c.id,
    c.provider::TEXT,
    c.name::TEXT,
    c.phone_number::TEXT,
    c.display_name::TEXT,
    c.status::TEXT,
    c.status_detail::TEXT,
    c.qr_issued_at,
    c.last_connected_at,
    c.last_seen_at,
    (SELECT COUNT(*) FROM whatsapp_connection_members m
      WHERE m.connection_id = c.id)::BIGINT,
    EXISTS (SELECT 1 FROM whatsapp_connection_members m
             WHERE m.connection_id = c.id),
    c.created_at
  FROM whatsapp_connections c
  WHERE c.account_id = p_account_id
    AND can_use_whatsapp_connection(c.id)
  ORDER BY c.created_at ASC;
END;
$$;

ALTER FUNCTION whatsapp_connections_for_user(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION whatsapp_connections_for_user(UUID)
  TO authenticated, service_role;
