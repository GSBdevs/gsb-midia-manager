// Pareamento (device flow) e gestão de telas.
//
// O código de pareamento existe antes de a tela pertencer a alguém; quem o digita no painel
// vincula a tela à própria organização. A partir daí ela só enxerga o conteúdo desse cliente.
const { newId, newToken, hashToken, pairCode, createLimiter, HHMM_RE, validDays, clampInt } = require('../util');
const { httpError } = require('../auth');
const { can } = require('../accounts');
const repo = require('../repo');

const PAIR_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 200;
const COMMANDS = ['identify', 'reload', 'clear-cache'];

// campos que só trocam o conteúdo exibido: quem edita conteúdo pode mudar
const CONTENT_FIELDS = new Set(['playlistId', 'groupId']);

module.exports = function deviceRoutes(router, { db, auth, notify, limiters }) {
  const { allow, requireSession, requireOrg } = auth;

  // endpoint público: limita a geração de códigos por IP
  const pairRequests = createLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
  limiters.push(pairRequests);

  router.post('/pair/request', async (req, res) => {
    if (!pairRequests.hit(req.ip || 'unknown')) throw httpError(429, 'muitas solicitações de código — aguarde');
    const token = newToken();
    const now = Date.now();
    const pairing = await db.system(async (tx) => {
      // códigos vencidos saem; pareamentos já reivindicados são descartados após 1h
      await tx.query(
        `DELETE FROM pairings WHERE (claimed_device_id IS NULL AND expires_at < now())
                                 OR (claimed_device_id IS NOT NULL AND created_at < $1)`,
        [new Date(now - 60 * 60 * 1000)]
      );
      await tx.query(
        `DELETE FROM pairings WHERE token_hash IN (
           SELECT token_hash FROM pairings WHERE claimed_device_id IS NULL
            ORDER BY created_at DESC OFFSET $1)`, [MAX_PENDING_PAIRINGS - 1]
      );
      let code;
      do code = pairCode();
      while ((await tx.query('SELECT 1 FROM pairings WHERE code = $1 AND claimed_device_id IS NULL', [code])).rows.length);
      const expiresAt = new Date(now + PAIR_TTL_MS);
      await tx.query('INSERT INTO pairings (code, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4)',
        [code, hashToken(token), new Date(now), expiresAt]);
      return { code, expiresAt: expiresAt.getTime() };
    });
    res.json({ code: pairing.code, token, expiresAt: pairing.expiresAt });
  });

  router.get('/pair/status', async (req, res) => {
    const h = hashToken(req.headers['x-device-token'] || '');
    const p = await db.system(async (tx) => (await tx.query(
      'SELECT claimed_device_id FROM pairings WHERE token_hash = $1', [h]
    )).rows[0]);
    if (!p) throw httpError(404, 'código expirado');
    res.json({ claimed: !!p.claimed_device_id });
  });

  router.post('/devices/claim', allow('devices.write'), async (req, res) => {
    const { code, name } = req.body || {};
    const id = newId();
    // reserva o código (uma só vez, mesmo com dois cliques simultâneos)
    const pairing = await db.system(async (tx) => (await tx.query(
      `UPDATE pairings SET claimed_device_id = $1
        WHERE code = $2 AND claimed_device_id IS NULL AND expires_at > now()
        RETURNING token_hash`,
      [id, String(code || '').toUpperCase().trim()]
    )).rows[0]);
    if (!pairing) throw httpError(404, 'código inválido ou expirado');
    const device = await db.withOrg(req.orgId, async (tx) => {
      const d = {
        id,
        name: String(name || '').trim().slice(0, 80) || `Tela ${(await repo.countDevices(tx)) + 1}`,
        playlistId: null,
        groupId: null,
        orientation: 0,
        fit: 'contain',
        volume: 100,
        muted: false,
        overlay: { ticker: '', showClock: false },
        powerSchedule: null,
        online: false,
        lastSeenAt: null,
        createdAt: Date.now(),
        status: null
      };
      // o token temporário do pareamento vira a credencial permanente da tela
      await repo.insertDevice(tx, req.orgId, d, pairing.token_hash);
      return d;
    });
    req.notify.panel('devices-changed');
    res.json(device);
  });

  router.get('/devices', allow('content.read'), async (req, res) => {
    res.json(await db.withOrg(req.orgId, (tx) => repo.listDevices(tx)));
  });

  // Mudar só playlist/grupo é conteúdo (editor); o resto configura a tela (admin).
  router.patch('/devices/:id', requireSession, requireOrg, async (req, res) => {
    const b = req.body || {};
    const contentOnly = Object.keys(b).every((k) => CONTENT_FIELDS.has(k));
    if (!can(req.session.role, contentOnly ? 'content.write' : 'devices.write')) {
      throw httpError(403, 'seu papel não permite esta ação');
    }
    const device = await db.withOrg(req.orgId, async (tx) => {
      const dev = await repo.getDevice(tx, req.params.id);
      if (!dev) throw httpError(404, 'tela não encontrada');
      if (typeof b.name === 'string' && b.name.trim()) dev.name = b.name.trim().slice(0, 80);
      if ('playlistId' in b) {
        if (b.playlistId && !(await repo.exists(tx, 'playlists', b.playlistId))) throw httpError(400, 'playlist inválida');
        dev.playlistId = b.playlistId || null;
      }
      if ('groupId' in b) {
        if (b.groupId && !(await repo.exists(tx, 'device_groups', b.groupId))) throw httpError(400, 'grupo inválido');
        dev.groupId = b.groupId || null;
      }
      if ('orientation' in b) dev.orientation = [0, 90, 180, 270].includes(+b.orientation) ? +b.orientation : 0;
      if ('volume' in b) dev.volume = clampInt(b.volume, 0, 100, 100);
      // contain: mídia inteira (bordas pretas se sobrar espaço); cover: preenche a tela
      if ('fit' in b) {
        if (!['contain', 'cover'].includes(b.fit)) throw httpError(400, 'ajuste de mídia inválido');
        dev.fit = b.fit;
      }
      if ('muted' in b) dev.muted = !!b.muted;
      if (b.overlay && typeof b.overlay === 'object') {
        dev.overlay = { ticker: String(b.overlay.ticker || '').slice(0, 500), showClock: !!b.overlay.showClock };
      }
      if ('powerSchedule' in b) {
        const ps = b.powerSchedule;
        if (ps === null) dev.powerSchedule = null;
        else if (ps && HHMM_RE.test(ps.on) && HHMM_RE.test(ps.off) && validDays(ps.days).length) {
          dev.powerSchedule = { on: ps.on, off: ps.off, days: validDays(ps.days) };
        } else {
          throw httpError(400, 'agenda de energia inválida');
        }
      }
      await repo.updateDevice(tx, dev);
      return dev;
    });
    req.notify.sync();
    req.notify.panel('devices-changed');
    res.json(device);
  });

  router.delete('/devices/:id', allow('devices.write'), async (req, res) => {
    const removed = await db.withOrg(req.orgId, (tx) => repo.deleteDevice(tx, req.params.id));
    if (!removed) throw httpError(404, 'tela não encontrada');
    notify.unpair(req.params.id);
    req.notify.panel('devices-changed');
    req.notify.panel('schedules-changed');
    res.json({ ok: true });
  });

  router.post('/devices/:id/command', allow('content.write'), async (req, res) => {
    const device = await db.withOrg(req.orgId, (tx) => repo.getDevice(tx, req.params.id));
    if (!device) throw httpError(404, 'tela não encontrada');
    const type = req.body?.type;
    if (!COMMANDS.includes(type)) throw httpError(400, 'comando inválido');
    res.json({ ok: true, delivered: notify.command(device.id, { type }) });
  });
};
