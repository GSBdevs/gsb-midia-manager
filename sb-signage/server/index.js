// SB Signage — ponto de entrada: lê a configuração, sobe o servidor e trata o desligamento.
const fs = require('fs');
const os = require('os');
const { loadConfig } = require('./config');
const { createServer } = require('./app');

async function main() {
  const config = loadConfig();
  const instance = await createServer(config);
  const port = await instance.listen();

  // todas as placas de rede: o primeiro IP nem sempre é o do Wi-Fi (Hyper-V, VPN, emulador)
  const ips = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).filter((n) => n.family === 'IPv4' && !n.internal).map((n) => ({ name, address: n.address })));
  console.log('SB Mídias no ar.');
  console.log(`  Painel : http://localhost:${port}/`);
  if (!ips.length) console.log('  Rede   : nenhuma placa de rede ativa — só este computador acessa');
  for (const ip of ips) console.log(`  Rede   : http://${ip.address}:${port}   (${ip.name})`);
  console.log('           ↑ endereço que as telas usam (player no navegador: acrescente /player)');
  const installers = fs.existsSync(config.downloadsDir) ? fs.readdirSync(config.downloadsDir).filter((f) => f.endsWith('.exe') || f.endsWith('.apk')) : [];
  for (const f of installers) console.log(`  Baixar : http://${ips[0]?.address || 'localhost'}:${port}/downloads/${f}`);
  console.log(`  Fuso   : ${config.timezone}`);
  console.log(`  Banco  : ${instance.db.kind === 'pglite' ? `embutido (${require('path').join(config.dataDir, 'pg')})` : 'PostgreSQL (DATABASE_URL)'}`);
  if ((await instance.accounts.countUsers()) === 0) {
    console.log('  Acesso : PRIMEIRO ACESSO — abra o painel para criar a conta do administrador');
  }

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
