// Mídia, playlists, agenda, grupos e emergência — tudo dentro da organização ativa.
const path = require('path');
const multer = require('multer');
const { newId, HHMM_RE, validDays, clampInt } = require('../util');
const { DEFAULT_IMAGE_DURATION } = require('../domain/manifest');
const { httpError } = require('../auth');
const { can } = require('../accounts');
const repo = require('../repo');

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

module.exports = function contentRoutes(router, { db, dirs, config, transcoder, auth }) {
  const { allow, requireSession, requireOrg } = auth;
  const read = allow('content.read');
  const write = allow('content.write');
  const inOrg = (req, fn) => db.withOrg(req.orgId, fn);

  // ---------- grupos ----------
  router.get('/groups', read, async (req, res) => res.json(await inOrg(req, (tx) => repo.listGroups(tx))));

  router.post('/groups', allow('devices.write'), async (req, res) => {
    const group = await inOrg(req, async (tx) => {
      const g = {
        id: newId(),
        name: String(req.body?.name || '').trim().slice(0, 80) || `Grupo ${(await repo.listGroups(tx)).length + 1}`,
        playlistId: null,
        createdAt: Date.now()
      };
      await repo.insertGroup(tx, req.orgId, g);
      return g;
    });
    req.notify.panel('groups-changed');
    res.json(group);
  });

  // Trocar só a playlist do grupo é conteúdo (editor); renomear é organizar telas (admin).
  router.patch('/groups/:id', requireSession, requireOrg, async (req, res) => {
    const b = req.body || {};
    const contentOnly = Object.keys(b).every((k) => k === 'playlistId');
    if (!can(req.session.role, contentOnly ? 'content.write' : 'devices.write')) throw httpError(403, 'seu papel não permite esta ação');
    const group = await inOrg(req, async (tx) => {
      const g = await repo.getGroup(tx, req.params.id);
      if (!g) throw httpError(404, 'grupo não encontrado');
      if (typeof b.name === 'string' && b.name.trim()) g.name = b.name.trim().slice(0, 80);
      if ('playlistId' in b) {
        if (b.playlistId && !(await repo.exists(tx, 'playlists', b.playlistId))) throw httpError(400, 'playlist inválida');
        g.playlistId = b.playlistId || null;
      }
      await repo.updateGroup(tx, g);
      return g;
    });
    req.notify.sync();
    req.notify.panel('groups-changed');
    res.json(group);
  });

  router.delete('/groups/:id', allow('devices.write'), async (req, res) => {
    if (!(await inOrg(req, (tx) => repo.deleteGroup(tx, req.params.id)))) throw httpError(404, 'grupo não encontrado');
    req.notify.sync();
    req.notify.panel('groups-changed');
    req.notify.panel('devices-changed');
    res.json({ ok: true });
  });

  // ---------- emergência (override da organização; o painel não usa mais, os players sim) ----------
  router.get('/emergency', read, async (req, res) => res.json((await inOrg(req, (tx) => repo.getSettings(tx))).emergency));

  router.post('/emergency', allow('settings.write'), async (req, res) => {
    const { mediaId, message } = req.body || {};
    const emergency = await inOrg(req, async (tx) => {
      if (mediaId) {
        const m = await repo.getMedia(tx, String(mediaId));
        if (!m || m.status !== 'ready') throw httpError(400, 'mídia inválida ou não processada');
      }
      if (!mediaId && !String(message || '').trim()) throw httpError(400, 'informe uma mídia ou uma mensagem');
      const e = { active: true, mediaId: mediaId || null, message: String(message || '').trim().slice(0, 500), startedAt: Date.now() };
      await repo.setEmergency(tx, e);
      return e;
    });
    req.notify.sync();
    req.notify.panel('emergency-changed');
    res.json(emergency);
  });

  router.delete('/emergency', allow('settings.write'), async (req, res) => {
    await inOrg(req, (tx) => repo.setEmergency(tx, null));
    req.notify.sync();
    req.notify.panel('emergency-changed');
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

  router.post('/media', write, upload.array('files', MAX_FILES_PER_UPLOAD), async (req, res) => {
    const created = (req.files || []).map((file) => {
      const ext = extOf(file.originalname);
      return {
        id: newId(), name: cleanName(file.originalname), type: mediaType(ext), ext, status: 'processing',
        original: file.path, file: null, hls: null, thumb: null, size: file.size,
        width: null, height: null, duration: null, error: null, createdAt: Date.now()
      };
    });
    if (created.length) {
      await inOrg(req, async (tx) => { for (const m of created) await repo.insertMedia(tx, req.orgId, m); });
      for (const m of created) transcoder.enqueue(req.orgId, m.id);
      req.notify.panel('media-changed');
    }
    const rejected = req.rejectedFiles || [];
    if (!created.length) return res.status(415).json({ error: 'nenhum arquivo em formato suportado', rejected });
    res.json({ created: created.map(repo.publicMedia), rejected });
  });

  // Página web como mídia (dashboards, cardápios, feeds): não passa por transcode.
  router.post('/media/webpage', write, async (req, res) => {
    const { name, url } = req.body || {};
    let parsed;
    try {
      parsed = new URL(String(url || '').trim());
    } catch {
      parsed = null;
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw httpError(400, 'URL inválida — use http(s)://');
    const media = {
      id: newId(),
      name: String(name || '').trim().slice(0, 200) || parsed.hostname,
      type: 'webpage',
      url: parsed.href,
      status: 'ready',
      createdAt: Date.now()
    };
    await inOrg(req, (tx) => repo.insertMedia(tx, req.orgId, media));
    req.notify.sync();
    req.notify.panel('media-changed');
    res.json(media);
  });

  router.get('/media', read, async (req, res) => {
    res.json((await inOrg(req, (tx) => repo.listMedia(tx))).map(repo.publicMedia));
  });

  router.patch('/media/:id', write, async (req, res) => {
    const media = await inOrg(req, async (tx) => {
      const m = await repo.getMedia(tx, req.params.id);
      if (!m) throw httpError(404, 'mídia não encontrada');
      if (typeof req.body?.name === 'string' && req.body.name.trim()) m.name = cleanName(req.body.name.trim());
      await repo.updateMedia(tx, m);
      return m;
    });
    req.notify.sync();
    req.notify.panel('media-changed');
    res.json(repo.publicMedia(media));
  });

  router.delete('/media/:id', write, async (req, res) => {
    let emergencyCleared = false;
    const media = await inOrg(req, async (tx) => {
      const m = await repo.deleteMedia(tx, req.params.id); // itens de playlist saem em cascata
      if (!m) throw httpError(404, 'mídia não encontrada');
      const { emergency } = await repo.getSettings(tx);
      if (emergency.mediaId === m.id) {
        await repo.setEmergency(tx, null);
        emergencyCleared = true;
      }
      return m;
    });
    // em processamento ativo, o transcoder limpa ao terminar; na fila ou pronta, limpa agora
    if (media.status !== 'processing' || transcoder.cancel(media.id)) transcoder.removeFiles(media);
    if (emergencyCleared) req.notify.panel('emergency-changed');
    req.notify.sync();
    req.notify.panel('media-changed');
    req.notify.panel('playlists-changed');
    res.json({ ok: true });
  });

  // ---------- playlists ----------
  router.get('/playlists', read, async (req, res) => res.json(await inOrg(req, (tx) => repo.listPlaylists(tx))));

  router.post('/playlists', write, async (req, res) => {
    const playlist = await inOrg(req, async (tx) => {
      const p = {
        id: newId(),
        name: String(req.body?.name || '').trim().slice(0, 80) || `Playlist ${(await repo.listPlaylists(tx)).length + 1}`,
        items: [],
        createdAt: Date.now()
      };
      await repo.insertPlaylist(tx, req.orgId, p);
      return p;
    });
    req.notify.panel('playlists-changed');
    res.json(playlist);
  });

  router.post('/playlists/:id/duplicate', write, async (req, res) => {
    const copy = await inOrg(req, async (tx) => {
      const src = await repo.getPlaylist(tx, req.params.id);
      if (!src) throw httpError(404, 'playlist não encontrada');
      const p = { id: newId(), name: `${src.name} (cópia)`.slice(0, 80), items: src.items.map((it) => ({ ...it })), createdAt: Date.now() };
      await repo.insertPlaylist(tx, req.orgId, p);
      return p;
    });
    req.notify.panel('playlists-changed');
    res.json(copy);
  });

  router.patch('/playlists/:id', write, async (req, res) => {
    const b = req.body || {};
    const playlist = await inOrg(req, async (tx) => {
      if (!(await repo.exists(tx, 'playlists', req.params.id))) throw httpError(404, 'playlist não encontrada');
      if (typeof b.name === 'string' && b.name.trim()) await repo.renamePlaylist(tx, req.params.id, b.name.trim().slice(0, 80));
      if (Array.isArray(b.items)) {
        const items = b.items
          .filter((it) => it && typeof it.mediaId === 'string')
          .slice(0, 500)
          .map((it) => ({ mediaId: it.mediaId, duration: clampInt(it.duration, 1, 3600, DEFAULT_IMAGE_DURATION) }));
        await repo.setPlaylistItems(tx, req.orgId, req.params.id, items);
      }
      return repo.getPlaylist(tx, req.params.id);
    });
    req.notify.sync();
    req.notify.panel('playlists-changed');
    res.json(playlist);
  });

  router.delete('/playlists/:id', write, async (req, res) => {
    if (!(await inOrg(req, (tx) => repo.deletePlaylist(tx, req.params.id)))) throw httpError(404, 'playlist não encontrada');
    req.notify.sync();
    req.notify.panel('playlists-changed');
    req.notify.panel('schedules-changed');
    req.notify.panel('groups-changed');
    req.notify.panel('devices-changed');
    res.json({ ok: true });
  });

  // ---------- agenda ----------
  router.get('/schedules', read, async (req, res) => res.json(await inOrg(req, (tx) => repo.listSchedules(tx))));

  router.post('/schedules', write, async (req, res) => {
    const { deviceId, playlistId, days, start, end, priority } = req.body || {};
    const schedule = await inOrg(req, async (tx) => {
      if (!(await repo.exists(tx, 'devices', deviceId))) throw httpError(400, 'tela inválida');
      if (!(await repo.exists(tx, 'playlists', playlistId))) throw httpError(400, 'playlist inválida');
      if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) throw httpError(400, 'horário inválido');
      const s = { id: newId(), deviceId, playlistId, days: validDays(days), start, end, priority: clampInt(priority, 0, 99, 0) };
      if (!s.days.length) throw httpError(400, 'selecione ao menos um dia');
      await repo.insertSchedule(tx, req.orgId, s);
      return s;
    });
    req.notify.sync();
    req.notify.panel('schedules-changed');
    res.json(schedule);
  });

  router.delete('/schedules/:id', write, async (req, res) => {
    await inOrg(req, (tx) => repo.deleteSchedule(tx, req.params.id));
    req.notify.sync();
    req.notify.panel('schedules-changed');
    res.json({ ok: true });
  });
};

module.exports.IMAGE_EXT = IMAGE_EXT;
module.exports.VIDEO_EXT = VIDEO_EXT;
