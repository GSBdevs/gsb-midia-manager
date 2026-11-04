// Monta o servidor (HTTP + Socket.IO + rotas + estáticos) sem iniciá-lo — testável.
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

const { Store } = require('./store');
const { createAuth } = require('./auth');
const { attachRealtime } = require('./realtime');
const { Transcoder } = require('./media/transcode');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Cabeçalhos de segurança. O painel e o player só executam scripts da própria origem;
// a mídia é servida em "sandbox" — um SVG com <script> aberto direto não executa nada.
function securityHeaders(kind, mediaOrigin) {
  const media = mediaOrigin ? ` ${mediaOrigin}` : '';
  const policies = {
    panel: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      `img-src 'self' data: blob:${media}`,
      `media-src 'self' blob:${media}`,
      "connect-src 'self' ws: wss:",
      "frame-src http: https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ],
    player: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob:${media}`,
      `media-src 'self' blob:${media}`,
      `connect-src 'self' ws: wss:${media}`,
      "worker-src 'self' blob:",
      'frame-src http: https:',
      "base-uri 'self'"
    ],
    media: ["default-src 'none'", "style-src 'unsafe-inline'", 'sandbox']
  };
  const csp = policies[kind].join('; ');
  return (_req, res, next) => {
    res.set('Content-Security-Policy', csp);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    if (kind === 'media') {
      // CDN/domínio próprio: players de outra origem precisam ler a mídia
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    next();
  };
}

function createServer(config) {
  const dirs = {
    original: path.join(config.dataDir, 'original'),
    processed: path.join(config.dataDir, 'processed'),
    thumbs: path.join(config.dataDir, 'thumbs'),
    hls: path.join(config.dataDir, 'hls'),
    logs: path.join(config.dataDir, 'logs'),
    branding: path.join(config.dataDir, 'branding')
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  const store = new Store(path.join(config.dataDir, 'data.json'), { sessionMaxDays: config.sessionMaxDays });
  store.save(); // grava a migração de esquema, se houve

  const app = express();
  const server = http.createServer(app);
  const auth = createAuth({ store, config });
  const realtime = attachRealtime(server, { store, auth });
  const { notify } = realtime;

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
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '1mb' }));

  const requireAuth = (req, res, next) => {
    if (auth.validateSession(req.headers['x-auth-token'])) return next();
    res.status(401).json({ error: 'não autenticado' });
  };
  const requireDevice = (req, res, next) => {
    const device = auth.findDevice(req.headers['x-device-token']);
    if (!device) return res.status(401).json({ error: 'tela não autorizada' });
    req.device = device;
    next();
  };

  const limiters = [];
  const ctx = { store, dirs, config, notify, transcoder, auth, requireAuth, requireDevice, limiters };
  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  for (const register of [
    require('./routes/session'),
    require('./routes/devices'),
    require('./routes/content'),
    require('./routes/player'),
    require('./routes/reports'),
    require('./routes/settings')
  ]) register(api, ctx);
  api.use((_req, res) => res.status(404).json({ error: 'rota não encontrada' }));
  app.use('/api', api);

  const mediaOrigin = config.mediaBaseUrl ? new URL(config.mediaBaseUrl).origin : '';
  const mediaHeaders = securityHeaders('media');
  // Mídia processada e HLS: nome tem hash → imutável, um ano de cache.
  app.use('/m', mediaHeaders, express.static(dirs.processed, { immutable: true, maxAge: '365d', fallthrough: false }));
  app.use('/hls', mediaHeaders, express.static(dirs.hls, { immutable: true, maxAge: '365d', fallthrough: false }));
  app.use('/thumbs', mediaHeaders, express.static(dirs.thumbs, { maxAge: '7d', fallthrough: false }));
  app.use('/branding', mediaHeaders, express.static(dirs.branding, { immutable: true, maxAge: '365d', fallthrough: false }));

  app.use('/player', securityHeaders('player', mediaOrigin), express.static(path.join(PUBLIC_DIR, 'player')));
  app.use('/', securityHeaders('panel', mediaOrigin), express.static(path.join(PUBLIC_DIR, 'panel')));

  app.get('/health', (_req, res) => res.json({ ok: true, transcodeQueue: transcoder.pending }));

  // Erros (upload grande demais, JSON inválido, arquivo inexistente…).
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `arquivo excede o limite de ${config.maxUploadMB} MB` });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'envie no máximo 20 arquivos por vez' });
    }
    if (status >= 500) console.error('[http]', err);
    res.status(status).json({ error: status >= 500 ? 'erro interno' : err.message });
  });

  return {
    app,
    server,
    store,
    transcoder,
    notify,
    dirs,
    listen(port = config.port, host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          transcoder.recover();
          resolve(server.address().port);
        });
      });
    },
    async close() {
      transcoder.close();
      for (const l of limiters) l.close();
      realtime.close();
      await new Promise((resolve) => server.close(() => resolve()));
      store.flush();
    }
  };
}

module.exports = { createServer };
