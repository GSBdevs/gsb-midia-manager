// Banco de dados da versão multiusuário.
//
//  - Sem DATABASE_URL: PGlite (PostgreSQL 18 embutido, sem instalar nada) em DATA_DIR/pg.
//    Serve para desenvolvimento, testes e instalação local de um cliente só.
//  - Com DATABASE_URL: PostgreSQL de verdade (nuvem, vários servidores).
//
// Duas formas de consultar:
//  - db.system(fn): sem organização (login, pareamento, console da GrupoSB). Use o mínimo.
//  - db.withOrg(orgId, fn): dados de UM cliente. Roda como sb_app com app.org_id definido,
//    então o RLS do banco garante o isolamento mesmo se a consulta esquecer o filtro.
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function openPglite(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
  return {
    kind: 'pglite',
    query: (sql, params) => pg.query(sql, params),
    exec: (sql) => pg.exec(sql),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (s, p) => tx.query(s, p), exec: (s) => tx.exec(s) })),
    close: () => pg.close()
  };
}

async function openPostgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 10 });
  return {
    kind: 'postgres',
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (s, p) => client.query(s, p), exec: (s) => client.query(s) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

async function migrate(conn) {
  await conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await conn.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await conn.transaction(async (tx) => {
      await tx.exec(sql); // várias instruções
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

/**
 * @param {{ databaseUrl?: string, dataDir?: string, memory?: boolean }} opts
 */
async function openDatabase({ databaseUrl, dataDir, memory } = {}) {
  let conn;
  if (databaseUrl) conn = await openPostgres(databaseUrl);
  else {
    const dir = memory ? null : path.join(dataDir, 'pg');
    if (dir) fs.mkdirSync(dir, { recursive: true });
    conn = await openPglite(dir);
  }
  const applied = await migrate(conn);

  return {
    kind: conn.kind,
    applied,
    /** Consultas sem organização (login, pareamento, console). */
    system: (fn) => conn.transaction(fn),
    /** Consultas de um cliente: RLS ativo, só enxerga a própria organização. */
    withOrg(orgId, fn) {
      if (!UUID_RE.test(String(orgId))) throw new Error('organização inválida');
      return conn.transaction(async (tx) => {
        await tx.query('SET LOCAL ROLE sb_app');
        await tx.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
        return fn(tx);
      });
    },
    close: () => conn.close()
  };
}

module.exports = { openDatabase };
