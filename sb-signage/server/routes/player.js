// Endpoints consumidos pelo player: manifesto e proof-of-play.
const fs = require('fs');
const path = require('path');
const { buildManifest } = require('../domain/manifest');
const { zonedParts } = require('../time');

const MAX_EVENTS_PER_BATCH = 500;
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// "If-None-Match" pode chegar com aspas, prefixo fraco (W/) ou como lista.
function etagMatches(header, version) {
  if (!header) return false;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, '') === version);
}

module.exports = function playerRoutes(router, { store, dirs, config, requireDevice }) {
  router.get('/player/manifest', requireDevice, (req, res) => {
    req.device.lastSeenAt = Date.now();
    store.save();
    const manifest = buildManifest(store.data, req.device, {
      timeZone: config.timezone,
      mediaBaseUrl: config.mediaBaseUrl
    });
    res.set('Cache-Control', 'no-cache');
    // ETag = versão do manifesto → o player pergunta "mudou algo?" quase de graça (304).
    res.set('ETag', `"${manifest.version}"`);
    if (etagMatches(req.headers['if-none-match'], manifest.version)) return res.status(304).end();
    res.json(manifest);
  });

  // O player envia lotes do que exibiu; o servidor acumula em JSONL diário (fora do data.json).
  // Cada evento vai para o arquivo do dia em que ACONTECEU (no fuso configurado), não do envio.
  router.post('/player/logs', requireDevice, (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
    const now = Date.now();
    const byDate = new Map();
    for (const e of events) {
      if (!e || !e.mediaId) continue;
      let ts = Number(e.ts);
      if (!Number.isFinite(ts) || ts > now + 60_000 || ts < now - MAX_EVENT_AGE_MS) ts = now;
      const line = JSON.stringify({
        ts,
        deviceId: req.device.id,
        deviceName: req.device.name,
        mediaId: String(e.mediaId).slice(0, 40),
        name: String(e.name || '').slice(0, 200),
        dur: Math.max(0, Math.min(86400, Number(e.dur) || 0))
      });
      const date = zonedParts(new Date(ts), config.timezone).date;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(line);
    }
    let saved = 0;
    for (const [date, lines] of byDate) {
      fs.appendFileSync(path.join(dirs.logs, `plays-${date}.jsonl`), lines.join('\n') + '\n');
      saved += lines.length;
    }
    res.json({ ok: true, saved });
  });
};

module.exports.etagMatches = etagMatches;
