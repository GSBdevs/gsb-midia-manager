// Relatórios de exibição (proof-of-play) e visão geral para o painel.
const fs = require('fs');
const path = require('path');
const { DATE_RE } = require('../util');
const { zonedParts } = require('../time');

const MAX_RANGE_DAYS = 92;
const DAY_MS = 24 * 60 * 60 * 1000;

function datesBetween(from, to) {
  const out = [];
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  for (let t = start; t <= end && out.length < MAX_RANGE_DAYS; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

module.exports = function reportRoutes(router, { store, dirs, config, transcoder, requireAuth }) {
  const d = store.data;
  const today = () => zonedParts(new Date(), config.timezone).date;

  function readLog(date, deviceId) {
    try {
      return fs.readFileSync(path.join(dirs.logs, `plays-${date}.jsonl`), 'utf8')
        .split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && (!deviceId || e.deviceId === deviceId));
    } catch {
      return [];
    }
  }

  // ?date=AAAA-MM-DD (um dia) ou ?from=…&to=… (intervalo, até 92 dias)
  function range(query) {
    const from = DATE_RE.test(query.from || '') ? query.from : DATE_RE.test(query.date || '') ? query.date : today();
    let to = DATE_RE.test(query.to || '') ? query.to : DATE_RE.test(query.date || '') ? query.date : from;
    if (to < from) to = from;
    return { from, to, dates: datesBetween(from, to) };
  }

  router.get('/logs', requireAuth, (req, res) => {
    const { from, to, dates } = range(req.query);
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : '';
    const agg = new Map(); // deviceId|mediaId -> resumo
    const perDay = [];
    let totalPlays = 0;
    let totalSeconds = 0;
    for (const date of dates) {
      const entries = readLog(date, deviceId);
      let daySeconds = 0;
      for (const e of entries) {
        const key = `${e.deviceId}|${e.mediaId}`;
        const cur = agg.get(key) || {
          deviceId: e.deviceId, deviceName: e.deviceName, mediaId: e.mediaId, name: e.name, plays: 0, seconds: 0
        };
        cur.plays++;
        cur.seconds += e.dur || 0;
        cur.deviceName = e.deviceName; // último nome conhecido
        agg.set(key, cur);
        daySeconds += e.dur || 0;
      }
      totalPlays += entries.length;
      totalSeconds += daySeconds;
      perDay.push({ date, plays: entries.length, seconds: daySeconds });
    }
    res.json({
      from, to, date: from, timezone: config.timezone,
      totalPlays, totalSeconds, perDay,
      rows: [...agg.values()].sort((a, b) => b.plays - a.plays)
    });
  });

  router.get('/logs.csv', requireAuth, (req, res) => {
    const { from, to, dates } = range(req.query);
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : '';
    const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'medium' });
    const rows = [];
    for (const date of dates) {
      for (const e of readLog(date, deviceId)) {
        rows.push([fmt.format(new Date(e.ts)), e.deviceName, e.name, e.dur].map(csvCell).join(';'));
      }
    }
    const name = from === to ? from : `${from}_a_${to}`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="proof-of-play-${name}.csv"`);
    // BOM para o Excel abrir acentos corretamente
    res.send('﻿' + ['"data/hora";"tela";"midia";"segundos"', ...rows].join('\r\n'));
  });

  // Números para o painel inicial.
  router.get('/overview', requireAuth, (_req, res) => {
    const media = d.media;
    const todayLog = readLog(today());
    res.json({
      devices: {
        total: d.devices.length,
        online: d.devices.filter((x) => x.online).length,
        withIssues: d.devices.filter((x) => x.status && (x.status.cacheErrors > 0 || x.status.missing > 0)).length
      },
      media: {
        total: media.length,
        processing: media.filter((m) => m.status === 'processing').length,
        failed: media.filter((m) => m.status === 'failed').length,
        bytes: media.reduce((s, m) => s + (m.size || 0), 0)
      },
      playlists: d.playlists.length,
      schedules: d.schedules.length,
      transcodeQueue: transcoder.pending,
      playsToday: todayLog.length,
      secondsToday: todayLog.reduce((s, e) => s + (e.dur || 0), 0),
      emergency: d.emergency,
      timezone: config.timezone,
      version: require('../../package.json').version,
      node: process.version
    });
  });
};
