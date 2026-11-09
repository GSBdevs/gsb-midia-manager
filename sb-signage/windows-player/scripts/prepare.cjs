// Copia o player web e o cliente Socket.IO (mesma versão do servidor) para dentro do app.
// Roda antes de iniciar ou empacotar: o player do Windows é sempre o mesmo do navegador.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, '..', 'app');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'public', 'player'), path.join(out, 'player'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js'),
  path.join(out, 'socket.io.min.js')
);

const serverVersion = require(path.join(root, 'node_modules', 'socket.io', 'package.json')).version;
console.log(`player web copiado; cliente Socket.IO ${serverVersion}`);
