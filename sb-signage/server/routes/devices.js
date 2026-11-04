// Pareamento (device flow) e gestão de telas.
const { newId, newToken, hashToken, pairCode, createLimiter, HHMM_RE, validDays, clampInt } = require('../util');

const PAIR_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 200;
const COMMANDS = ['identify', 'reload', 'clear-cache'];

function publicDevice({ tokenHash: _t, ...rest }) {
  return rest;
}

module.exports = function deviceRoutes(router, { store, auth, notify, requireAuth, limiters }) {
  const d = store.data;
  // endpoint público: limita a geração de códigos por IP
  const pairRequests = createLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
  limiters.push(pairRequests);

  router.post('/pair/request', (req, res) => {
    if (!pairRequests.hit(req.ip || 'unknown')) {
      return res.status(429).json({ error: 'muitas solicitações de código — aguarde' });
    }
    const now = Date.now();
    // limpa códigos vencidos; pareamentos já reivindicados são descartados após 1h
    d.pairings = d.pairings.filter((p) =>
      p.claimedDeviceId ? now - p.createdAt < 60 * 60 * 1000 : p.expiresAt > now
    );
    while (d.pairings.filter((p) => !p.claimedDeviceId).length >= MAX_PENDING_PAIRINGS) {
      d.pairings.splice(d.pairings.findIndex((p) => !p.claimedDeviceId), 1);
    }
    let code;
    do code = pairCode(); while (d.pairings.some((p) => p.code === code && !p.claimedDeviceId));
    const token = newToken();
    const pairing = { code, tokenHash: hashToken(token), createdAt: now, expiresAt: now + PAIR_TTL_MS, claimedDeviceId: null };
    d.pairings.push(pairing);
    store.save();
    res.json({ code, token, expiresAt: pairing.expiresAt });
  });

  router.get('/pair/status', (req, res) => {
    const h = hashToken(req.headers['x-device-token'] || '');
    const pairing = d.pairings.find((p) => p.tokenHash === h);
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
      id: newId(),
      name: String(name || '').trim().slice(0, 80) || `Tela ${d.devices.length + 1}`,
      tokenHash: pairing.tokenHash, // o token temporário vira a credencial permanente da tela
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
    res.json(publicDevice(device));
  });

  router.get('/devices', requireAuth, (_req, res) => {
    res.json(d.devices.map(publicDevice));
  });

  router.patch('/devices/:id', requireAuth, (req, res) => {
    const device = d.devices.find((x) => x.id === req.params.id);
    if (!device) return res.status(404).json({ error: 'tela não encontrada' });
    const b = req.body || {};
    if (typeof b.name === 'string' && b.name.trim()) device.name = b.name.trim().slice(0, 80);
    if ('playlistId' in b) {
      if (b.playlistId && !d.playlists.some((p) => p.id === b.playlistId)) {
        return res.status(400).json({ error: 'playlist inválida' });
      }
      device.playlistId = b.playlistId || null;
    }
    if ('groupId' in b) {
      if (b.groupId && !d.groups.some((g) => g.id === b.groupId)) return res.status(400).json({ error: 'grupo inválido' });
      device.groupId = b.groupId || null;
    }
    if ('orientation' in b) device.orientation = [0, 90, 180, 270].includes(+b.orientation) ? +b.orientation : 0;
    if ('volume' in b) device.volume = clampInt(b.volume, 0, 100, 100);
    if ('muted' in b) device.muted = !!b.muted;
    if (b.overlay && typeof b.overlay === 'object') {
      device.overlay = { ticker: String(b.overlay.ticker || '').slice(0, 500), showClock: !!b.overlay.showClock };
    }
    if ('powerSchedule' in b) {
      const ps = b.powerSchedule;
      if (ps === null) device.powerSchedule = null;
      else if (ps && HHMM_RE.test(ps.on) && HHMM_RE.test(ps.off) && validDays(ps.days).length) {
        device.powerSchedule = { on: ps.on, off: ps.off, days: validDays(ps.days) };
      } else {
        return res.status(400).json({ error: 'agenda de energia inválida' });
      }
    }
    store.save();
    notify.sync();
    notify.panel('devices-changed');
    res.json(publicDevice(device));
  });

  router.delete('/devices/:id', requireAuth, (req, res) => {
    const idx = d.devices.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'tela não encontrada' });
    const [device] = d.devices.splice(idx, 1);
    d.schedules = d.schedules.filter((s) => s.deviceId !== device.id);
    store.save();
    notify.unpair(device.id);
    notify.panel('devices-changed');
    notify.panel('schedules-changed');
    res.json({ ok: true });
  });

  router.post('/devices/:id/command', requireAuth, (req, res) => {
    const device = d.devices.find((x) => x.id === req.params.id);
    if (!device) return res.status(404).json({ error: 'tela não encontrada' });
    const type = req.body?.type;
    if (!COMMANDS.includes(type)) return res.status(400).json({ error: 'comando inválido' });
    res.json({ ok: true, delivered: notify.command(device.id, { type }) });
  });
};
