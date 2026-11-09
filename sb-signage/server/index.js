// SB Signage — ponto de entrada: lê a configuração, sobe o servidor e trata o desligamento.
const fs = require('fs');
const os = require('os');
const { loadConfig } = require('./config');
const { createServer } = require('./app');

async function main() {
  const config = loadConfig();
  const instance = createServer(config);
  const port = await instance.listen();

  // todas as placas de rede: o primeiro IP nem sempre é o do Wi-Fi (Hyper-V, VPN, emulador)
  const ips = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).filter((n) => n.family === 'IPv4' && !n.internal).map((n) => ({ name, address: n.address })));
  console.log('SB Signage no ar.');
  console.log(`  Painel : http://localhost:${port}/`);
  if (!ips.length) console.log('  Rede   : nenhuma placa de rede ativa — só este computador acessa');
  for (const ip of ips) console.log(`  Rede   : http://${ip.address}:${port}   (${ip.name})`);
  console.log('           ↑ endereço que as telas usam (player no navegador: acrescente /player)');
  const installers = fs.existsSync(config.downloadsDir) ? fs.readdirSync(config.downloadsDir).filter((f) => f.endsWith('.exe') || f.endsWith('.apk')) : [];
  for (const f of installers) console.log(`  Baixar : http://${ips[0]?.address || 'localhost'}:${port}/downloads/${f}`);
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
