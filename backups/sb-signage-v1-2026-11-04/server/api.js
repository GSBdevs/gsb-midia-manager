// API REST: auth do painel, pareamento de telas, mídia, playlists, agenda e manifesto do player.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg']);
const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv',
  'mpg', 'mpeg', '3gp', 'vob', 'ts', 'mts', 'm2ts', 'ogv', 'rm', 'rmvb'
]);

const PAIR_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
const PAIR_TTL_MS = 15 * 60 * 1000;
const DEFAULT_IMAGE_DURATION = 10; // segundos

const id = () => crypto.randomBytes(8).toString('hex');
const token = () => crypto.randomBytes(24).toString('hex');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function pairCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += PAIR_CHARSET[crypto.randomInt(PAIR_CHARSET.length)];
  return c;
}

function createApi({ store, dirs, transcoder, config, notify }) {
  const router = express.Router();
  const d = store.data;

  // ---------- helpers ----------
  const requireAuth = (req, res, next) => {
    const t = req.headers['x-auth-token'];
    if (t && d.sessions.some((s) => s.token === t)) return next();
    res.status(401).json({ error: 'não autenticado' });
  };

  const requireDevice = (req, res, next) => {
    const t = req.headers['x-device-token'];
    const device = t && d.devices.find((dev) => dev.token === t);
    if (!device) return res.status(401).json({ error: 'dispositivo não autorizado' });
    req.device = device;
    next();
  };

  // Resolve "o que tocar agora": agenda ativa > playlist da tela > playlist do grupo.
  function resolvePlaylist(device, now = new Date()) {
    const hhmm = now.toTimeString().slice(0, 5);
    const day = now.getDay();
    const active = d.schedules
      .filter((s) => s.deviceId === device.id && s.days.includes(day))
      .filter((s) => {
        if (s.start <= s.end) return hhmm >= s.start && hhmm < s.end;
        return hhmm >= s.start || hhmm < s.end; // janela que cruza a meia-noite
      })
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const group = device.groupId ? d.groups.find((g) => g.id === device.groupId) : null;
    const playlistId = active[0]?.playlistId ?? device.playlistId ?? group?.playlistId ?? null;
    return d.playlists.find((p) => p.id === playlistId) || null;
  }

  // URL absoluta quando há CDN configurado (MEDIA_BASE_URL); relativa caso contrário.
  const mediaUrl = (p) => `${config.mediaBaseUrl || ''}${p}`;

  function manifestItem(m, it) {
    if (m.type === 'webpage') {
      return { id: m.id, name: m.name, type: 'webpage', url: m.url, duration: it?.duration || DEFAULT_IMAGE_DURATION };
    }
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      url: mediaUrl(`/m/${m.file}`),
      hls: m.type === 'video' && m.hls ? mediaUrl(`/hls/${m.hls}`) : null,
      duration: m.type === 'video' ? null : (it?.duration || DEFAULT_IMAGE_DURATION)
    };
  }

  function buildEmergency() {
    if (!d.emergency?.active) return null;
    if (d.emergency.mediaId) {
      const m = d.media.find((x) => x.id === d.emergency.mediaId && x.status === 'ready');
      if (m) return manifestItem(m, { duration: DEFAULT_IMAGE_DURATION });
    }
    return { type: 'message', message: d.emergency.message || 'ATENÇÃO' };
  }

  function buildManifest(device) {
    const playlist = resolvePlaylist(device);
    const items = (playlist?.items || [])
      .map((it) => {
        const m = d.media.find((x) => x.id === it.mediaId);
        if (!m || m.status !== 'ready') return null;
        return manifestItem(m, it);
      })
      .filter(Boolean);
    const settings = {
      orientation: device.orientation || 0,
      volume: device.volume ?? 100,
      muted: !!device.muted,
      overlay: device.overlay || { ticker: '', showClock: false },
      powerSchedule: device.powerSchedule || null
    };
    const emergency = buildEmergency();
    const version = sha1(JSON.stringify([
      items.map((i) => [i.id, i.url, i.hls, i.duration]),
      settings,
      emergency && [emergency.url, emergency.message]
    ]));
    return {
      version,
      deviceName: device.name,
      playlistName: playlist?.name || null,
      serverTime: new Date().toISOString(),
      settings,
      emergency,
      items
    };
  }

  // ---------- auth do painel ----------
  // Rate limit em memória: 20 tentativas por IP a cada 15 min (barra força-bruta).
  const loginAttempts = new Map(); // ip -> { count, windowStart }
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_MAX_ATTEMPTS = 20;

  router.post('/login', (req, res) => {
    const now = Date.now();
    const ip = req.ip || 'unknown';
    let attempts = loginAttempts.get(ip);
    if (!attempts || now - attempts.windowStart >= LOGIN_WINDOW_MS) {
      attempts = { count: 0, windowStart: now };
      loginAttempts.set(ip, attempts);
    }
    if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'muitas tentativas — aguarde alguns minutos' });
    }
    if ((req.body?.password || '') !== config.adminPassword) {
      attempts.count++;
      return res.status(401).json({ error: 'senha incorreta' });
    }
    loginAttempts.delete(ip);
    const t = token();
    d.sessions.push({ token: t, createdAt: Date.now() });
    if (d.sessions.length > 50) d.sessions.splice(0, d.sessions.length - 50);
    store.save();
    res.json({ token: t });
  });

  router.get('/me', requireAuth, (_req, res) => res.json({ ok: true }));

  // ---------- pareamento ----------
  router.post('/pair/request', (_req, res) => {
    const now = Date.now();
    // limpa códigos vencidos; pareamentos já reivindicados são descartados após 1h
    // (o token já virou credencial do device — o registro de pairing não é mais necessário)
    d.pairings = d.pairings.filter((p) =>
      p.claimedDeviceId ? now - p.createdAt < 60 * 60 * 1000 : p.expiresAt > now
    );
    // proteção contra flood no endpoint público: no máximo 200 códigos pendentes
    while (d.pairings.filter((p) => !p.claimedDeviceId).length >= 200) {
      d.pairings.splice(d.pairings.findIndex((p) => !p.claimedDeviceId), 1);
    }
    const pairing = {
      code: pairCode(),
      token: token(),
      createdAt: Date.now(),
      expiresAt: Date.now() + PAIR_TTL_MS,
      claimedDeviceId: null
    };
    d.pairings.push(pairing);
    store.save();
    res.json({ code: pairing.code, token: pairing.token, expiresAt: pairing.expiresAt });
  });

  router.get('/pair/status', (req, res) => {
    const t = req.headers['x-device-token'];
    const pairing = d.pairings.find((p) => p.token === t);
    if (!pairing) return res.status(404).json({ error: 'código expirado' });
    res.json({ claimed: !!pairing.claimedDeviceId });
  });

  router.post('/devices/claim', requireAuth, (req, res) => {
    const { code, name } = req.body || {};
    const pairing = d.pairings.find(
      (p) => p.code === String(code || '').toUpperCase().trim() && !p.claimedDeviceId && p.expiresAt > Date.now()
    );
    if (!pairing) return res.status(404).json({ error: 'código inválido ou expirado' });
    const device = {
      id: id(),
      name: (name || '').trim() || `Tela ${d.devices.length + 1}`,
      token: pairing.token, // o token temporário vira a credencial permanente do device
      playlistId: null,
      groupId: null,
      orientation: 0,
      volume: 100,
      muted: false,
      overlay: { ticker: '', showClock: false },
      powerSchedule: null,
      online: false,
      lastSeenAt: null,
      createdAt: Date.now(),
      status: null
    };
    pairing.claimedDeviceId = device.id;
    d.devices.push(device);
    store.save();
    notify.panel('devices-changed');
    res.json(device);
  });

  // ---------- devices (painel) ----------
  router.get('/devices', requireAuth, (_req, res) => {
    res.json(d.devices.map(({ token: _t, ...rest }) => rest));
  });

  const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  router.patch('/devices/:id', requireAuth, (req, res) => {
    const device = d.devices.find((x) => x.id === req.params.id);
    if (!device) return res.status(404).json({ error: 'tela não encontrada' });
    const b = req.body || {};
    if (typeof b.name === 'string' && b.name.trim()) device.name = b.name.trim();
    if ('playlistId' in b) device.playlistId = b.playlistId || null;
    if ('groupId' in b) {
      device.groupId = b.groupId && d.groups.some((g) => g.id === b.groupId) ? b.groupId : null;
    }
    if ('orientation' in b) {
      device.orientation = [0, 90, 180, 270].includes(+b.orientation) ? +b.orientation : 0;
    }
    if ('volume' in b) device.volume = Math.max(0, Math.min(100, parseInt(b.volume, 10) || 0));
    if ('muted' in b) device.muted = !!b.muted;
    if (b.overlay && typeof b.overlay === 'object') {
      device.overlay = {
        ticker: String(b.overlay.ticker || '').slice(0, 500),
        showClock: !!b.overlay.showClock
      };
    }
    if ('powerSchedule' in b) {
      const ps = b.powerSchedule;
      if (ps && HHMM_RE.test(ps.on) && HHMM_RE.test(ps.off)) {
        const days = (Array.isArray(ps.days) ? ps.days : []).map(Number).filter((x) => x >= 0 && x <= 6);
        device.powerSchedule = days.length ? { on: ps.on, off: ps.off, days } : null;
      } else {
        device.powerSchedule = null;
      }
    }
    store.save();
    notify.sync();
    notify.panel('devices-changed');
    res.json({ ok: true });
  });

  router.delete('/devices/:id', requireAuth, (req, res) => {
    const idx = d.devices.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'tela não encontrada' });
    const [device] = d.devices.splice(idx, 1);
    d.schedules = d.schedules.filter((s) => s.deviceId !== device.id);
    store.save();
    notify.command(device.id, { type: 'unpaired' });
    notify.panel('devices-changed');
    res.json({ ok: true });
  });

  router.post('/devices/:id/command', requireAuth, (req, res) => {
    const device = d.devices.find((x) => x.id === req.params.id);
    if (!device) return res.status(404).json({ error: 'tela não encontrada' });
    const type = req.body?.type;
    if (!['identify', 'reload', 'clear-cache'].includes(type)) {
      return res.status(400).json({ error: 'comando inválido' });
    }
    const sent = notify.command(device.id, { type });
    res.json({ ok: true, delivered: sent });
  });

  // ---------- grupos de telas ----------
  router.get('/groups', requireAuth, (_req, res) => res.json(d.groups));

  router.post('/groups', requireAuth, (req, res) => {
    const group = {
      id: id(),
      name: (req.body?.name || '').trim() || `Grupo ${d.groups.length + 1}`,
      playlistId: null,
      createdAt: Date.now()
    };
    d.groups.push(group);
    store.save();
    notify.panel('groups-changed');
    res.json(group);
  });

  router.patch('/groups/:id', requireAuth, (req, res) => {
    const group = d.groups.find((g) => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'grupo não encontrado' });
    if (typeof req.body.name === 'string' && req.body.name.trim()) group.name = req.body.name.trim();
    if ('playlistId' in req.body) {
      group.playlistId = req.body.playlistId && d.playlists.some((p) => p.id === req.body.playlistId)
        ? req.body.playlistId : null;
    }
    store.save();
    notify.sync();
    notify.panel('groups-changed');
    res.json(group);
  });

  router.delete('/groups/:id', requireAuth, (req, res) => {
    const idx = d.groups.findIndex((g) => g.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'grupo não encontrado' });
    d.groups.splice(idx, 1);
    for (const dev of d.devices) if (dev.groupId === req.params.id) dev.groupId = null;
    store.save();
    notify.sync();
    notify.panel('groups-changed');
    notify.panel('devices-changed');
    res.json({ ok: true });
  });

  // ---------- emergência (override global) ----------
  router.get('/emergency', requireAuth, (_req, res) => res.json(d.emergency));

  router.post('/emergency', requireAuth, (req, res) => {
    const { mediaId, message } = req.body || {};
    if (mediaId && !d.media.some((m) => m.id === mediaId && m.status === 'ready')) {
      return res.status(400).json({ error: 'mídia inválida ou não processada' });
    }
    if (!mediaId && !(message || '').trim()) {
      return res.status(400).json({ error: 'informe uma mídia ou uma mensagem' });
    }
    d.emergency = {
      active: true,
      mediaId: mediaId || null,
      message: String(message || '').slice(0, 500),
      startedAt: Date.now()
    };
    store.save();
    notify.sync();
    notify.panel('emergency-changed');
    res.json(d.emergency);
  });

  router.delete('/emergency', requireAuth, (_req, res) => {
    d.emergency = { active: false, mediaId: null, message: '', startedAt: null };
    store.save();
    notify.sync();
    notify.panel('emergency-changed');
    res.json({ ok: true });
  });

  // ---------- mídia ----------
  const upload = multer({
    storage: multer.diskStorage({
      destination: dirs.original,
      filename: (_req, file, cb) => cb(null, `${id()}${path.extname(file.originalname).toLowerCase()}`)
    }),
    limits: { fileSize: config.maxUploadMB * 1024 * 1024 }
  });

  router.post('/media', requireAuth, upload.array('files', 20), (req, res) => {
    const created = [];
    for (const file of req.files || []) {
      const ext = path.extname(file.originalname).slice(1).toLowerCase();
      const type = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
      if (!type) {
        fs.unlinkSync(file.path);
        continue;
      }
      const media = {
        id: id(),
        name: path.basename(file.originalname),
        type,
        ext,
        status: 'processing',
        original: file.path,
        file: null,
        thumb: null,
        size: file.size,
        width: null,
        height: null,
        duration: null,
        error: null,
        createdAt: Date.now()
      };
      d.media.push(media);
      transcoder.enqueue(media.id);
      created.push(media);
    }
    store.save();
    notify.panel('media-changed');
    if (!created.length) return res.status(415).json({ error: 'nenhum arquivo em formato suportado' });
    res.json(created);
  });

  // Página web como mídia (dashboards, cardápios, feeds): não passa por transcode.
  router.post('/media/webpage', requireAuth, (req, res) => {
    const { name, url } = req.body || {};
    if (!/^https?:\/\/.+/i.test(url || '')) {
      return res.status(400).json({ error: 'URL inválida — use http(s)://' });
    }
    const media = {
      id: id(),
      name: (name || '').trim() || url,
      type: 'webpage',
      url: String(url).trim(),
      status: 'ready',
      createdAt: Date.now()
    };
    d.media.push(media);
    store.save();
    notify.sync();
    notify.panel('media-changed');
    res.json(media);
  });

  router.get('/media', requireAuth, (_req, res) => {
    res.json(d.media.map(({ original: _o, ...rest }) => rest));
  });

  router.delete('/media/:id', requireAuth, (req, res) => {
    const idx = d.media.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'mídia não encontrada' });
    const [media] = d.media.splice(idx, 1);
    for (const f of [
      media.original,
      media.file && path.join(dirs.processed, media.file),
      media.thumb && path.join(dirs.thumbs, media.thumb)
    ]) {
      if (f) fs.rm(f, { force: true }, () => {});
    }
    if (media.hls) {
      fs.rm(path.join(dirs.hls, path.dirname(media.hls)), { recursive: true, force: true }, () => {});
    }
    // remove das playlists
    for (const p of d.playlists) {
      p.items = p.items.filter((it) => it.mediaId !== media.id);
    }
    // emergência apontando para ela é desativada
    if (d.emergency?.mediaId === media.id) {
      d.emergency = { active: false, mediaId: null, message: '', startedAt: null };
      notify.panel('emergency-changed');
    }
    store.save();
    notify.sync();
    notify.panel('media-changed');
    res.json({ ok: true });
  });

  // ---------- playlists ----------
  router.get('/playlists', requireAuth, (_req, res) => res.json(d.playlists));

  router.post('/playlists', requireAuth, (req, res) => {
    const playlist = {
      id: id(),
      name: (req.body?.name || '').trim() || `Playlist ${d.playlists.length + 1}`,
      items: [],
      createdAt: Date.now()
    };
    d.playlists.push(playlist);
    store.save();
    notify.panel('playlists-changed');
    res.json(playlist);
  });

  router.patch('/playlists/:id', requireAuth, (req, res) => {
    const playlist = d.playlists.find((x) => x.id === req.params.id);
    if (!playlist) return res.status(404).json({ error: 'playlist não encontrada' });
    if (typeof req.body.name === 'string' && req.body.name.trim()) playlist.name = req.body.name.trim();
    if (Array.isArray(req.body.items)) {
      playlist.items = req.body.items
        .filter((it) => d.media.some((m) => m.id === it.mediaId))
        .map((it) => ({
          mediaId: it.mediaId,
          duration: Math.max(1, Math.min(3600, parseInt(it.duration, 10) || DEFAULT_IMAGE_DURATION))
        }));
    }
    store.save();
    notify.sync();
    notify.panel('playlists-changed');
    res.json(playlist);
  });

  router.delete('/playlists/:id', requireAuth, (req, res) => {
    const idx = d.playlists.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'playlist não encontrada' });
    const [playlist] = d.playlists.splice(idx, 1);
    for (const dev of d.devices) if (dev.playlistId === playlist.id) dev.playlistId = null;
    d.schedules = d.schedules.filter((s) => s.playlistId !== playlist.id);
    store.save();
    notify.sync();
    notify.panel('playlists-changed');
    res.json({ ok: true });
  });

  // ---------- agenda ----------
  router.get('/schedules', requireAuth, (_req, res) => res.json(d.schedules));

  router.post('/schedules', requireAuth, (req, res) => {
    const { deviceId, playlistId, days, start, end, priority } = req.body || {};
    if (!d.devices.some((x) => x.id === deviceId)) return res.status(400).json({ error: 'tela inválida' });
    if (!d.playlists.some((x) => x.id === playlistId)) return res.status(400).json({ error: 'playlist inválida' });
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!hhmm.test(start) || !hhmm.test(end)) return res.status(400).json({ error: 'horário inválido' });
    const schedule = {
      id: id(),
      deviceId,
      playlistId,
      days: (Array.isArray(days) ? days : []).map(Number).filter((x) => x >= 0 && x <= 6),
      start,
      end,
      priority: parseInt(priority, 10) || 0
    };
    if (!schedule.days.length) return res.status(400).json({ error: 'selecione ao menos um dia' });
    d.schedules.push(schedule);
    store.save();
    notify.sync();
    notify.panel('schedules-changed');
    res.json(schedule);
  });

  router.delete('/schedules/:id', requireAuth, (req, res) => {
    d.schedules = d.schedules.filter((s) => s.id !== req.params.id);
    store.save();
    notify.sync();
    notify.panel('schedules-changed');
    res.json({ ok: true });
  });

  // ---------- proof-of-play ----------
  const logFile = (date) => path.join(dirs.logs, `plays-${date}.jsonl`);
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Player envia lotes do que exibiu; servidor acumula em JSONL diário (fora do data.json).
  router.post('/player/logs', requireDevice, (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 500) : [];
    if (!events.length) return res.json({ ok: true, saved: 0 });
    const lines = events
      .filter((e) => e && e.mediaId)
      .map((e) => JSON.stringify({
        ts: Number(e.ts) || Date.now(),
        deviceId: req.device.id,
        deviceName: req.device.name,
        mediaId: String(e.mediaId),
        name: String(e.name || '').slice(0, 200),
        dur: Math.max(0, Math.min(86400, Number(e.dur) || 0))
      }));
    if (lines.length) fs.appendFile(logFile(todayStr()), lines.join('\n') + '\n', () => {});
    res.json({ ok: true, saved: lines.length });
  });

  function readLog(date) {
    try {
      return fs.readFileSync(logFile(date), 'utf8')
        .split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  }

  router.get('/logs', requireAuth, (req, res) => {
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : todayStr();
    const entries = readLog(date);
    const agg = new Map(); // deviceId|mediaId -> resumo
    for (const e of entries) {
      const key = `${e.deviceId}|${e.mediaId}`;
      const cur = agg.get(key) || {
        deviceId: e.deviceId, deviceName: e.deviceName,
        mediaId: e.mediaId, name: e.name, plays: 0, seconds: 0
      };
      cur.plays++;
      cur.seconds += e.dur || 0;
      cur.deviceName = e.deviceName; // último nome conhecido
      agg.set(key, cur);
    }
    res.json({
      date,
      totalPlays: entries.length,
      rows: [...agg.values()].sort((a, b) => b.plays - a.plays)
    });
  });

  router.get('/logs.csv', requireAuth, (req, res) => {
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : todayStr();
    const entries = readLog(date);
    const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = entries.map((e) =>
      [new Date(e.ts).toISOString(), e.deviceName, e.name, e.dur].map(csvCell).join(';'));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="proof-of-play-${date}.csv"`);
    res.send('﻿' + ['"data/hora";"tela";"midia";"segundos"', ...rows].join('\r\n'));
  });

  // ---------- player ----------
  router.get('/player/manifest', requireDevice, (req, res) => {
    req.device.lastSeenAt = Date.now();
    store.save();
    const manifest = buildManifest(req.device);
    // ETag = versão do manifesto → player pergunta "mudou algo?" quase de graça (304).
    if (req.headers['if-none-match'] === manifest.version) return res.status(304).end();
    res.set('ETag', manifest.version);
    res.json(manifest);
  });

  return { router, buildManifest };
}

module.exports = { createApi, IMAGE_EXT, VIDEO_EXT };
