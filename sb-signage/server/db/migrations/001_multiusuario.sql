-- Fase A: base multiusuário (organizações, usuários, papéis) e dados de negócio por cliente.
--
-- Isolamento: toda tabela de negócio tem org_id e uma política RLS que só mostra as linhas da
-- organização definida em app.org_id. As consultas de clientes rodam com o papel sb_app
-- (SET LOCAL ROLE), que nunca ignora o RLS. Mesmo que a aplicação esqueça um "WHERE org_id",
-- o banco não devolve dados de outro cliente.
--
-- IDs de negócio continuam texto (os mesmos da versão JSON): a importação preserva nomes de
-- arquivo de mídia e credenciais das telas já pareadas.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sb_app') THEN
    CREATE ROLE sb_app NOLOGIN;
  END IF;
END $$;
GRANT sb_app TO CURRENT_USER;

-- ---------- contas (fora do RLS: usadas no login, antes de existir uma organização ativa) ----------

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL UNIQUE CHECK (email = lower(email)),
  name               text NOT NULL DEFAULT '',
  password_hash      text NOT NULL,             -- scrypt$<salt>$<hash>
  must_change_password boolean NOT NULL DEFAULT false,
  is_platform_admin  boolean NOT NULL DEFAULT false, -- equipe GrupoSB (console central)
  disabled           boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_login_at      timestamptz
);

-- papéis por organização: owner > admin > editor > viewer
CREATE TABLE memberships (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE user_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,           -- sha256 do token; o token em si nunca é gravado
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid REFERENCES organizations(id) ON DELETE CASCADE, -- organização ativa
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX user_sessions_user ON user_sessions (user_id);

-- pareamento: o código existe antes de a tela pertencer a uma organização
CREATE TABLE pairings (
  code               text NOT NULL,
  token_hash         text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  claimed_device_id  text
);

-- ---------- negócio (com org_id e RLS) ----------

CREATE TABLE org_settings (
  org_id      uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  brand_name  text NOT NULL DEFAULT 'SB Mídias',
  accent      text NOT NULL DEFAULT '#ffd60a',
  theme       text NOT NULL DEFAULT 'dark',
  density     text NOT NULL DEFAULT 'comfortable',
  logo        text,
  emergency   jsonb                              -- mantido para os players; o painel não usa
);

CREATE TABLE media (
  id                 text PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               text NOT NULL,
  type               text NOT NULL CHECK (type IN ('image', 'video', 'webpage')),
  status             text NOT NULL CHECK (status IN ('processing', 'ready', 'error')),
  file               text,
  thumb              text,
  hls                text,
  url                text,                      -- página web
  size               bigint,
  width              int,
  height             int,
  duration           real,
  error              text,
  meta               jsonb NOT NULL DEFAULT '{}', -- ext, original, transcodeReasons...
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_org ON media (org_id);

CREATE TABLE playlists (
  id          text PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX playlists_org ON playlists (org_id);

-- itens em tabela própria: excluir uma mídia já a tira de todas as playlists (cascata)
CREATE TABLE playlist_items (
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  playlist_id  text NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position     int  NOT NULL,
  media_id     text NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  duration     int  NOT NULL DEFAULT 10 CHECK (duration BETWEEN 1 AND 3600),
  PRIMARY KEY (playlist_id, position)
);

CREATE TABLE device_groups (
  id           text PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  playlist_id  text REFERENCES playlists(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id              text PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  playlist_id     text REFERENCES playlists(id) ON DELETE SET NULL,
  group_id        text REFERENCES device_groups(id) ON DELETE SET NULL,
  orientation     int  NOT NULL DEFAULT 0 CHECK (orientation IN (0, 90, 180, 270)),
  fit             text NOT NULL DEFAULT 'contain' CHECK (fit IN ('contain', 'cover')),
  volume          int  NOT NULL DEFAULT 100 CHECK (volume BETWEEN 0 AND 100),
  muted           boolean NOT NULL DEFAULT false,
  overlay         jsonb NOT NULL DEFAULT '{"ticker":"","showClock":false}',
  power_schedule  jsonb,
  status          jsonb,
  online          boolean NOT NULL DEFAULT false,
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_org ON devices (org_id);

CREATE TABLE schedules (
  id           text PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id    text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  playlist_id  text NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  days         int[] NOT NULL,
  start_hhmm   text NOT NULL,
  end_hhmm     text NOT NULL,
  priority     int  NOT NULL DEFAULT 0
);

-- quem fez o quê, inclusive acessos da equipe GrupoSB a um cliente
CREATE TABLE audit_log (
  id       bigserial PRIMARY KEY,
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  action   text NOT NULL,
  target   text,
  details  jsonb NOT NULL DEFAULT '{}',
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_at ON audit_log (org_id, at DESC);

-- ---------- RLS ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_settings','media','playlists','playlist_items','device_groups',
                           'devices','schedules','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)
         WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO sb_app', t);
  END LOOP;
END $$;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO sb_app;
