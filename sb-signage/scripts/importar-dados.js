// Importa o data.json atual para o banco multiusuário (Fase A).
//
//   node scripts/importar-dados.js --org "GrupoSB" --email dono@empresa.com [--nome "Nome"] [--senha xxxxxxxx]
//
// Origem: DATA_DIR/data.json (padrão ./data). Destino: DATABASE_URL, ou PGlite em DATA_DIR/pg.
// --destino <pasta> grava o PGlite em outra pasta (ensaio sem tocar na instalação).
// Não altera o data.json nem o servidor em uso.
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../server/config');
const { openDatabase } = require('../server/db');
const { createAccounts } = require('../server/accounts');
const { importFromJson } = require('../server/db/import-json');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const config = loadConfig();
  const source = path.join(config.dataDir, 'data.json');
  if (!fs.existsSync(source)) throw new Error(`não encontrei ${source}`);
  const data = JSON.parse(fs.readFileSync(source, 'utf8'));

  const destino = arg('destino');
  const db = await openDatabase({
    databaseUrl: destino ? undefined : process.env.DATABASE_URL,
    dataDir: destino || config.dataDir
  });
  try {
    const accounts = createAccounts(db);
    const result = await importFromJson(db, accounts, data, {
      orgName: arg('org'),
      ownerEmail: arg('email'),
      ownerName: arg('nome') || '',
      ownerPassword: arg('senha')
    });
    console.log(`Organização "${result.org.name}" criada (${result.org.slug}).`);
    console.log(`Dono: ${result.owner.email}${result.mustChangePassword ? ' — senha provisória admin1234, troca obrigatória no 1º acesso' : ''}`);
    for (const [k, v] of Object.entries(result.counts)) console.log(`  ${k.padEnd(10)} ${v}`);
    console.log(`Banco: ${db.kind === 'pglite' ? path.join(destino || config.dataDir, 'pg') : 'DATABASE_URL'}`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[importação]', err.message);
  process.exit(1);
});
