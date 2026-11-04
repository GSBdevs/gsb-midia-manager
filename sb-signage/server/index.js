// SB Signage — ponto de entrada: lê a configuração, sobe o servidor e trata o desligamento.
const os = require('os');
const { loadConfig } = require('./config');
const { createServer } = require('./app');

async function main() {
  const config = loadConfig();
  const instance = createServer(config);
  const port = await instance.listen();

  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((n) => n && n.family === 'IPv4' && !n.internal);
  console.log('SB Signage no ar.');
  console.log(`  Painel : http://localhost:${port}/`);
  console.log(`  Player : http://${lan ? lan.address : 'localhost'}:${port}/player`);
  console.log(`  Fuso   : ${config.timezone}`);
  if (instance.store.data.auth?.passwordHash) console.log('  Senha  : definida pelo painel');
  else if (config.adminPassword === 'admin') console.log('  Senha  : admin — TROQUE no painel (Configurações) ou via ADMIN_PASSWORD');
  else console.log('  Senha  : definida via ADMIN_PASSWORD');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await instance.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
