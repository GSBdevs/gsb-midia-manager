// SB Signage — servidor: API + Socket.IO + arquivos estáticos (painel, player, mídia).
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');

const { Store } = require('./store');
const { Transcoder } = require('./transcode');
const { createApi } = require('./api');

// Quando empacotado como .exe (pkg), __dirname aponta para o snapshot somente-leitura;
// dados de runtime vão para a pasta ao lado do executável.
const isPackaged = typeof process.pkg !== 'undefined';
const baseDir = isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');

const config = {
  port: parseInt(process.env.PORT, 10) || 4000,
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  dataDir: process.env.DATA_DIR || path.join(baseDir, 'data'),
  maxUploadMB: parseInt(process.env.MAX_UPLOAD_MB, 10) || 2048,
  // CDN: prefixo absoluto para /m e /hls no manifesto (ex.: https://cdn.seudominio.com)
  mediaBaseUrl: (process.env.MEDIA_BASE_URL || '').replace(/\/+$/, ''),
  // vídeos com duração acima deste limite ganham variante HLS (streaming imediato)
  hlsMinMinutes: parseInt(process.env.HLS_MIN_MINUTES, 10) || 10
};

const dirs = {
  original: path.join(config.dataDir, 'original'),
  processed: path.join(config.dataDir, 'processed'),
  thumbs: path.join(config.dataDir, 'thumbs'),
  hls: path.join(config.dataDir, 'hls'),
  logs: path.join(config.dataDir, 'logs')
};
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

const store = new Store(path.join(config.dataDir, 'data.json'));

// migração: devices criados antes dos novos campos ganham os padrões
for (const dev of store.data.devices) {
  if (dev.groupId === undefined) dev.groupId = null;
  if (dev.orientation === undefined) dev.orientation = 0;
  if (dev.volume === undefined) dev.volume = 100;
  if (dev.muted === undefined) dev.muted = false;
  if (dev.overlay === undefined) dev.overlay = { ticker: '', showClock: false };
  if (dev.powerSchedule === undefined) dev.powerSchedule = null;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// ---------- Socket.IO: players e painel ----------
const playerSockets = new Map(); // deviceId -> Set<socket>

const notify = {
  // "há novidade" → todos os players revalidam o manifesto (ETag torna isso barato)
  sync() {
    io.to('players').emit('sync');
  },
  panel(event, payload) {
    io.to('panel').emit(event, payload || {});
  },
  command(deviceId, cmd) {
    const sockets = playerSockets.get(deviceId);
    if (!sockets || !sockets.size) return false;
    for (const s of sockets) s.emit('command', cmd);
    return true;
  }
};

io.on('connection', (socket) => {
  const { role, token } = socket.handshake.auth || {};

  if (role === 'panel') {
    if (!store.data.sessions.some((s) => s.token === token)) return socket.disconnect(true);
    socket.join('panel');
    return;
  }

  if (role === 'player') {
    const device = store.data.devices.find((dev) => dev.token === token);
    if (!device) return socket.disconnect(true);
    socket.join('players');
    socket.data.deviceId = device.id;

    if (!playerSockets.has(device.id)) playerSockets.set(device.id, new Set());
    playerSockets.get(device.id).add(socket);

    device.online = true;
    device.lastSeenAt = Date.now();
    store.save();
    notify.panel('devices-changed');

    socket.on('status', (status) => {
      device.status = {
        playing: status?.playing || null,
        cached: status?.cached ?? null,
        version: status?.version || null
      };
      device.lastSeenAt = Date.now();
      store.save();
      notify.panel('devices-changed');
    });

    socket.on('disconnect', () => {
      const set = playerSockets.get(device.id);
      if (set) {
        set.delete(socket);
        if (!set.size) {
          playerSockets.delete(device.id);
          device.online = false;
          store.save();
          notify.panel('devices-changed');
        }
      }
    });
    return;
  }

  socket.disconnect(true);
});

// ---------- transcodificação ----------
const transcoder = new Transcoder({
  store,
  dirs,
  hlsMinSeconds: config.hlsMinMinutes * 60,
  onUpdate: (media) => {
    notify.panel('media-changed');
    if (media.status === 'ready') notify.sync(); // mídia pronta pode entrar em manifestos
  }
});

// ---------- HTTP ----------
app.set('trust proxy', true); // req.ip correto atrás de túnel/reverse proxy (Cloudflare, nginx…)
app.use(express.json());

const { router } = createApi({ store, dirs, transcoder, config, notify });
app.use('/api', router);

// CORS liberado na mídia: necessário quando os players buscam de um CDN/domínio próprio.
const mediaCors = (_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
};

// Mídia processada: nome tem hash → imutável, um ano de cache.
app.use('/m', mediaCors, express.static(dirs.processed, { immutable: true, maxAge: '365d', fallthrough: false }));
// HLS: pasta com hash no nome → também imutável.
app.use('/hls', mediaCors, express.static(dirs.hls, { immutable: true, maxAge: '365d', fallthrough: false }));
app.use('/thumbs', express.static(dirs.thumbs, { maxAge: '7d' }));

const pub = path.join(__dirname, '..', 'public');
app.use('/player', express.static(path.join(pub, 'player')));
app.use('/', express.static(path.join(pub, 'panel')));

app.get('/health', (_req, res) => res.json({ ok: true }));

// erros do multer (arquivo grande demais etc.)
app.use((err, _req, res, _next) => {
  console.error('[http]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `arquivo excede o limite de ${config.maxUploadMB} MB` });
  }
  res.status(err.status || 500).json({ error: err.message });
});

// ---------- watchdog de status: marca offline quem sumiu sem disconnect ----------
setInterval(() => {
  let changed = false;
  for (const device of store.data.devices) {
    if (device.online && device.lastSeenAt && Date.now() - device.lastSeenAt > 90_000 && !playerSockets.has(device.id)) {
      device.online = false;
      changed = true;
    }
  }
  if (changed) {
    store.save();
    notify.panel('devices-changed');
  }
}, 30_000);

process.on('SIGINT', () => {
  store.flush();
  process.exit(0);
});

server.listen(config.port, () => {
  transcoder.recover();
  const nets = os.networkInterfaces();
  const lan = Object.values(nets)
    .flat()
    .find((n) => n && n.family === 'IPv4' && !n.internal);
  console.log('SB Signage no ar.');
  console.log(`  Painel : http://localhost:${config.port}/`);
  console.log(`  Player : http://${lan ? lan.address : 'localhost'}:${config.port}/player`);
  console.log(`  Senha do painel: ${config.adminPassword === 'admin' ? 'admin (defina ADMIN_PASSWORD!)' : '(definida via ambiente)'}`);
});
