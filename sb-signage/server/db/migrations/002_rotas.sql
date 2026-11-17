-- Fase A, etapa 2: ajustes para as rotas do servidor rodarem sobre o banco.

-- O conversor de mídia sempre gravou 'failed' (o painel mostra assim); a 001 só aceitava 'error'.
-- Sem isso, importar uma instalação com uma mídia que falhou quebrava na restrição.
ALTER TABLE media DROP CONSTRAINT IF EXISTS media_status_check;
ALTER TABLE media ADD CONSTRAINT media_status_check CHECK (status IN ('processing', 'ready', 'failed', 'error'));

-- db.system() roda com o usuário dono das tabelas. Com FORCE ROW LEVEL SECURITY, um dono que
-- não seja superusuário (PostgreSQL gerenciado na nuvem) não enxergaria nada, e o servidor não
-- acharia a tela pela credencial nem retomaria conversões pendentes. Esta política vale só para
-- esse usuário; as consultas de clientes continuam como sb_app, sujeitas ao isolamento.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_settings','media','playlists','playlist_items','device_groups',
                           'devices','schedules','audit_log']
  LOOP
    EXECUTE format('CREATE POLICY system_access ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS pairings_code ON pairings (code);
CREATE INDEX IF NOT EXISTS schedules_device ON schedules (device_id);
