// Mídia, playlists, agenda, grupos e emergência.
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { newId, HHMM_RE, validDays, clampInt } = require('../util');
const { DEFAULT_IMAGE_DURATION } = require('../domain/manifest');

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg']);
const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv',
  'mpg', 'mpeg', '3gp', 'vob', 'ts', 'mts', 'm2ts', 'ogv', 'rm', 'rmvb'
]);
const MAX_FILES_PER_UPLOAD = 20;

const extOf = (name) => path.extname(name || '').slice(1).toLowerCase();
const mediaType = (ext) => (IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null);
// remove caracteres de controle e limita o tamanho do nome exibido
const cleanName = (name) => path.basename(String(name || '')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'sem nome';

const EMPTY_EMERGENCY = () => ({ active: false, mediaId: null, message: '', startedAt: null });

module.exports = function contentRoutes(router, { store, dirs, config, notify, transcoder, requireAuth }) {
  const d = store.data;

  // ---------- grupos ----------
  router.get('/groups', requireAuth, (_req, res) => res.json(d.groups));

  router.post('/groups', requireAuth, (req, res) => {
    const group = {
      id: newId(),
      name: String(req.body?.name || '').trim().slice(0, 80) || `Grupo ${d.groups.length + 1}`,
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
    const b = req.body || {};
    if (typeof b.name === 'string' && b.name.trim()) group.name = b.name.trim().slice(0, 80);
    if ('playlistId' in b) {
      if (b.playlistId && !d.playlists.some((p) => p.id === b.playlistId)) {
        return res.status(400).json({ error: 'playlist inválida' });
      }
      group.playlistId = b.playlistId || null;
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
    if (!mediaId && !String(message || '').trim()) {
      return res.status(400).json({ error: 'informe uma mídia ou uma mensagem' });
    }
    d.emergency = {
      active: true,
      mediaId: mediaId || null,
      message: String(message || '').trim().slice(0, 500),
      startedAt: Date.now()
    };
    store.save();
    notify.sync();
    notify.panel('emergency-changed');
    res.json(d.emergency);
  });

  router.delete('/emergency', requireAuth, (_req, res) => {
    d.emergency = EMPTY_EMERGENCY();
    store.save();
    notify.sync();
    notify.panel('emergency-changed');
    res.json({ ok: true });
  });

  // ---------- mídia ----------
  const upload = multer({
    storage: multer.diskStorage({
      destination: dirs.original,
      filename: (_req, file, cb) => cb(null, `${newId()}.${extOf(file.originalname)}`)
    }),
    // nomes de arquivo chegam em UTF-8 (o padrão latin1 transformava "promoção" em "promoÃ§Ã£o")
    defParamCharset: 'utf8',
    limits: { fileSize: config.maxUploadMB * 1024 * 1024, files: MAX_FILES_PER_UPLOAD },
    // formato não suportado nem chega ao disco
    fileFilter: (req, file, cb) => {
      const ok = !!mediaType(extOf(file.originalname));
      if (!ok) (req.rejectedFiles ||= []).push(cleanName(file.originalname));
      cb(null, ok);
    }
  });

  router.post('/media', requireAuth, upload.array('files', MAX_FILES_PER_UPLOAD), (req, res) => {
    const created = [];
    for (const file of req.files || []) {
      const ext = extOf(file.originalname);
      const media = {
        id: newId(),
        name: cleanName(file.originalname),
        type: mediaType(ext),
        ext,
        status: 'processing',
        original: file.path,
        file: null,
        hls: null,
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
    const rejected = req.rejectedFiles || [];
    if (!created.length) {
      return res.status(415).json({ error: 'nenhum arquivo em formato suportado', rejected });
    }
    res.json({ created: created.map(({ original: _o, ...m }) => m), rejected });
  });

  // Página web como mídia (dashboards, cardápios, feeds): não passa por transcode.
  router.post('/media/webpage', requireAuth, (req, res) => {
    const { name, url } = req.body || {};
    let parsed;
    try {
      parsed = new URL(String(url || '').trim());
    } catch {
      parsed = null;
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'URL inválida — use http(s)://' });
    }
    const media = {
      id: newId(),
      name: String(name || '').trim().slice(0, 200) || parsed.hostname,
      type: 'webpage',
      url: parsed.href,
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

  router.patch('/media/:id', requireAuth, (req, res) => {
    const media = d.media.find((x) => x.id === req.params.id);
    if (!media) return res.status(404).json({ error: 'mídia não encontrada' });
    if (typeof req.body?.name === 'string' && req.body.name.trim()) media.name = cleanName(req.body.name.trim());
    store.save();
    notify.sync();
    notify.panel('media-changed');
    res.json(media);
  });

  router.delete('/media/:id', requireAuth, (req, res) => {
    const idx = d.media.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'mídia não encontrada' });
    const [media] = d.media.splice(idx, 1);
    // em processamento ativo, o transcoder limpa ao terminar; na fila ou pronta, limpa agora
    if (media.status !== 'processing' || transcoder.cancel(media.id)) transcoder.removeFiles(media);
    for (const p of d.playlists) p.items = p.items.filter((it) => it.mediaId !== media.id);
    if (d.emergency?.mediaId === media.id) {
      d.emergency = EMPTY_EMERGENCY();
      notify.panel('emergency-changed');
    }
    store.save();
    notify.sync();
    notify.panel('media-changed');
    notify.panel('playlists-changed');
    res.json({ ok: true });
  });

  // ---------- playlists ----------
  router.get('/playlists', requireAuth, (_req, res) => res.json(d.playlists));

  router.post('/playlists', requireAuth, (req, res) => {
    const playlist = {
      id: newId(),
      name: String(req.body?.name || '').trim().slice(0, 80) || `Playlist ${d.playlists.length + 1}`,
      items: [],
      createdAt: Date.now()
    };
    d.playlists.push(playlist);
    store.save();
    notify.panel('playlists-changed');
    res.json(playlist);
  });

  router.post('/playlists/:id/duplicate', requireAuth, (req, res) => {
    const src = d.playlists.find((x) => x.id === req.params.id);
    if (!src) return res.status(404).json({ error: 'playlist não encontrada' });
    const copy = { id: newId(), name: `${src.name} (cópia)`.slice(0, 80), items: src.items.map((it) => ({ ...it })), createdAt: Date.now() };
    d.playlists.push(copy);
    store.save();
    notify.panel('playlists-changed');
    res.json(copy);
  });

  router.patch('/playlists/:id', requireAuth, (req, res) => {
    const playlist = d.playlists.find((x) => x.id === req.params.id);
    if (!playlist) return res.status(404).json({ error: 'playlist não encontrada' });
    const b = req.body || {};
    if (typeof b.name === 'string' && b.name.trim()) playlist.name = b.name.trim().slice(0, 80);
    if (Array.isArray(b.items)) {
      playlist.items = b.items
        .filter((it) => it && d.media.some((m) => m.id === it.mediaId))
        .slice(0, 500)
        .map((it) => ({ mediaId: it.mediaId, duration: clampInt(it.duration, 1, 3600, DEFAULT_IMAGE_DURATION) }));
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
    for (const g of d.groups) if (g.playlistId === playlist.id) g.playlistId = null;
    d.schedules = d.schedules.filter((s) => s.playlistId !== playlist.id);
    store.save();
    notify.sync();
    notify.panel('playlists-changed');
    notify.panel('schedules-changed');
    notify.panel('groups-changed');
    notify.panel('devices-changed');
    res.json({ ok: true });
  });

  // ---------- agenda ----------
  router.get('/schedules', requireAuth, (_req, res) => res.json(d.schedules));

  router.post('/schedules', requireAuth, (req, res) => {
    const { deviceId, playlistId, days, start, end, priority } = req.body || {};
    if (!d.devices.some((x) => x.id === deviceId)) return res.status(400).json({ error: 'tela inválida' });
    if (!d.playlists.some((x) => x.id === playlistId)) return res.status(400).json({ error: 'playlist inválida' });
    if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) return res.status(400).json({ error: 'horário inválido' });
    const schedule = {
      id: newId(),
      deviceId,
      playlistId,
      days: validDays(days),
      start,
      end,
      priority: clampInt(priority, 0, 99, 0)
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
};

module.exports.IMAGE_EXT = IMAGE_EXT;
module.exports.VIDEO_EXT = VIDEO_EXT;
