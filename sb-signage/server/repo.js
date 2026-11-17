// Acesso aos dados de negócio de UMA organização (sempre dentro de db.withOrg).
//
// Converte linhas do banco para o mesmo formato que a API usava com o data.json (camelCase,
// datas em milissegundos): painel e players não percebem a troca de armazenamento.
// O isolamento é do banco (RLS); mesmo assim, toda referência vinda do cliente (playlist de uma
// tela, mídia de uma playlist) é validada aqui, porque chave estrangeira não respeita RLS.

const ms = (d) => (d == null ? null : new Date(d).getTime());
const num = (v) => (v == null ? null : Number(v));
const json = (v) => (v == null ? null : JSON.stringify(v));

// ---------- conversões ----------

function mediaFrom(r) {
  const base = { id: r.id, name: r.name, type: r.type, status: r.status, createdAt: ms(r.created_at) };
  if (r.type === 'webpage') return { ...base, url: r.url };
  const meta = r.meta || {};
  return {
    ...base,
    ext: meta.ext ?? null,
    original: meta.original ?? null, // caminho no disco; nunca sai na API (ver publicMedia)
    file: r.file,
    hls: r.hls,
    thumb: r.thumb,
    size: num(r.size),
    width: r.width,
    height: r.height,
    duration: r.duration,
    error: r.error,
    ...(meta.transcodeReasons ? { transcodeReasons: meta.transcodeReasons } : {})
  };
}

const publicMedia = ({ original: _o, ...rest }) => rest;

function deviceFrom(r) {
  return {
    id: r.id,
    name: r.name,
    playlistId: r.playlist_id,
    groupId: r.group_id,
    orientation: r.orientation,
    fit: r.fit,
    volume: r.volume,
    muted: r.muted,
    overlay: r.overlay || { ticker: '', showClock: false },
    powerSchedule: r.power_schedule,
    online: r.online,
    lastSeenAt: ms(r.last_seen_at),
    createdAt: ms(r.created_at),
    status: r.status
  };
}

const groupFrom = (r) => ({ id: r.id, name: r.name, playlistId: r.playlist_id, createdAt: ms(r.created_at) });

const scheduleFrom = (r) => ({
  id: r.id, deviceId: r.device_id, playlistId: r.playlist_id, days: r.days,
  start: r.start_hhmm, end: r.end_hhmm, priority: r.priority
});

function settingsFrom(r = {}) {
  return {
    brandName: r.brand_name || 'SB Mídias',
    accent: r.accent || '#ffd60a',
    theme: r.theme || 'dark',
    density: r.density || 'comfortable',
    logo: r.logo || null
  };
}

const EMPTY_EMERGENCY = () => ({ active: false, mediaId: null, message: '', startedAt: null });

// ---------- configurações ----------

async function getSettings(tx) {
  const r = (await tx.query('SELECT * FROM org_settings')).rows[0];
  return { settings: settingsFrom(r), emergency: r?.emergency || EMPTY_EMERGENCY() };
}

async function updateSettings(tx, s) {
  await tx.query(
    'UPDATE org_settings SET brand_name = $1, accent = $2, theme = $3, density = $4, logo = $5',
    [s.brandName, s.accent, s.theme, s.density, s.logo]
  );
}

async function setEmergency(tx, emergency) {
  await tx.query('UPDATE org_settings SET emergency = $1', [emergency?.active ? json(emergency) : null]);
}

// ---------- mídia ----------

async function listMedia(tx) {
  return (await tx.query('SELECT * FROM media ORDER BY created_at, id')).rows.map(mediaFrom);
}

async function getMedia(tx, id) {
  const r = (await tx.query('SELECT * FROM media WHERE id = $1', [id])).rows[0];
  return r ? mediaFrom(r) : null;
}

function mediaMeta(m) {
  const meta = {};
  if (m.ext != null) meta.ext = m.ext;
  if (m.original != null) meta.original = m.original;
  if (m.transcodeReasons) meta.transcodeReasons = m.transcodeReasons;
  return json(meta);
}

async function insertMedia(tx, orgId, m) {
  await tx.query(
    `INSERT INTO media (id, org_id, name, type, status, file, thumb, hls, url, size, width, height, duration, error, meta, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [m.id, orgId, m.name, m.type, m.status, m.file || null, m.thumb || null, m.hls || null, m.url || null,
      m.size ?? null, m.width ?? null, m.height ?? null, m.duration ?? null, m.error || null, mediaMeta(m),
      new Date(m.createdAt || Date.now())]
  );
}

// grava todos os campos mutáveis (renomear, fim da conversão). false = mídia não existe mais
async function updateMedia(tx, m) {
  const r = await tx.query(
    `UPDATE media SET name = $2, status = $3, file = $4, thumb = $5, hls = $6, size = $7, width = $8,
            height = $9, duration = $10, error = $11, meta = $12
      WHERE id = $1`,
    [m.id, m.name, m.status, m.file || null, m.thumb || null, m.hls || null, m.size ?? null,
      m.width ?? null, m.height ?? null, m.duration ?? null, m.error || null, mediaMeta(m)]
  );
  return (r.affectedRows ?? r.rowCount) > 0;
}

async function deleteMedia(tx, id) {
  const r = (await tx.query('DELETE FROM media WHERE id = $1 RETURNING *', [id])).rows[0];
  return r ? mediaFrom(r) : null;
}

// ---------- playlists ----------

async function listPlaylists(tx, id = null) {
  const lists = (await tx.query(
    `SELECT id, name, created_at FROM playlists ${id ? 'WHERE id = $1' : ''} ORDER BY created_at, id`, id ? [id] : []
  )).rows;
  const items = (await tx.query(
    `SELECT playlist_id, media_id, duration FROM playlist_items ${id ? 'WHERE playlist_id = $1' : ''} ORDER BY playlist_id, position`,
    id ? [id] : []
  )).rows;
  const byList = new Map(lists.map((p) => [p.id, []]));
  for (const it of items) byList.get(it.playlist_id)?.push({ mediaId: it.media_id, duration: it.duration });
  return lists.map((p) => ({ id: p.id, name: p.name, items: byList.get(p.id), createdAt: ms(p.created_at) }));
}

async function getPlaylist(tx, id) {
  return (await listPlaylists(tx, id))[0] || null;
}

async function exists(tx, table, id) {
  if (!id || typeof id !== 'string') return false;
  return (await tx.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rows.length > 0;
}

async function insertPlaylist(tx, orgId, p) {
  await tx.query('INSERT INTO playlists (id, org_id, name, created_at) VALUES ($1, $2, $3, $4)',
    [p.id, orgId, p.name, new Date(p.createdAt || Date.now())]);
  if (p.items?.length) await setPlaylistItems(tx, orgId, p.id, p.items);
}

async function renamePlaylist(tx, id, name) {
  await tx.query('UPDATE playlists SET name = $2, updated_at = now() WHERE id = $1', [id, name]);
}

// Substitui os itens. Itens que apontam para mídia inexistente (ou de outro cliente) são descartados.
async function setPlaylistItems(tx, orgId, id, items) {
  const own = new Set((await tx.query('SELECT id FROM media')).rows.map((r) => r.id));
  const valid = items.filter((it) => own.has(it.mediaId));
  await tx.query('DELETE FROM playlist_items WHERE playlist_id = $1', [id]);
  for (let i = 0; i < valid.length; i++) {
    await tx.query(
      'INSERT INTO playlist_items (org_id, playlist_id, position, media_id, duration) VALUES ($1, $2, $3, $4, $5)',
      [orgId, id, i, valid[i].mediaId, valid[i].duration]
    );
  }
  await tx.query('UPDATE playlists SET updated_at = now() WHERE id = $1', [id]);
}

async function deletePlaylist(tx, id) {
  // telas e grupos ficam sem playlist (SET NULL); regras de agenda dela somem (CASCADE)
  const r = await tx.query('DELETE FROM playlists WHERE id = $1', [id]);
  return (r.affectedRows ?? r.rowCount) > 0;
}

// ---------- grupos ----------

async function listGroups(tx) {
  return (await tx.query('SELECT * FROM device_groups ORDER BY created_at, id')).rows.map(groupFrom);
}

async function getGroup(tx, id) {
  const r = (await tx.query('SELECT * FROM device_groups WHERE id = $1', [id])).rows[0];
  return r ? groupFrom(r) : null;
}

async function insertGroup(tx, orgId, g) {
  await tx.query('INSERT INTO device_groups (id, org_id, name, playlist_id, created_at) VALUES ($1, $2, $3, $4, $5)',
    [g.id, orgId, g.name, g.playlistId || null, new Date(g.createdAt || Date.now())]);
}

async function updateGroup(tx, g) {
  await tx.query('UPDATE device_groups SET name = $2, playlist_id = $3 WHERE id = $1', [g.id, g.name, g.playlistId || null]);
}

async function deleteGroup(tx, id) {
  const r = await tx.query('DELETE FROM device_groups WHERE id = $1', [id]); // telas: group_id SET NULL
  return (r.affectedRows ?? r.rowCount) > 0;
}

// ---------- telas ----------

async function listDevices(tx) {
  return (await tx.query('SELECT * FROM devices ORDER BY created_at, id')).rows.map(deviceFrom);
}

async function getDevice(tx, id) {
  const r = (await tx.query('SELECT * FROM devices WHERE id = $1', [id])).rows[0];
  return r ? deviceFrom(r) : null;
}

async function countDevices(tx) {
  return Number((await tx.query('SELECT count(*)::int AS n FROM devices')).rows[0].n);
}

async function insertDevice(tx, orgId, d, tokenHash) {
  await tx.query(
    `INSERT INTO devices (id, org_id, name, token_hash, playlist_id, group_id, orientation, fit, volume, muted,
                          overlay, power_schedule, status, online, last_seen_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [d.id, orgId, d.name, tokenHash, d.playlistId, d.groupId, d.orientation, d.fit, d.volume, d.muted,
      json(d.overlay), json(d.powerSchedule), json(d.status), d.online, d.lastSeenAt ? new Date(d.lastSeenAt) : null,
      new Date(d.createdAt || Date.now())]
  );
}

async function updateDevice(tx, d) {
  await tx.query(
    `UPDATE devices SET name = $2, playlist_id = $3, group_id = $4, orientation = $5, fit = $6, volume = $7,
            muted = $8, overlay = $9, power_schedule = $10
      WHERE id = $1`,
    [d.id, d.name, d.playlistId, d.groupId, d.orientation, d.fit, d.volume, d.muted, json(d.overlay), json(d.powerSchedule)]
  );
}

// presença e status reportados pelo player (não passam pela auditoria)
async function updateDevicePresence(tx, id, { online, lastSeenAt, status }) {
  const sets = [];
  const params = [id];
  if (online !== undefined) { params.push(online); sets.push(`online = $${params.length}`); }
  if (lastSeenAt !== undefined) { params.push(lastSeenAt ? new Date(lastSeenAt) : null); sets.push(`last_seen_at = $${params.length}`); }
  if (status !== undefined) { params.push(json(status)); sets.push(`status = $${params.length}`); }
  if (!sets.length) return null;
  const r = (await tx.query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params)).rows[0];
  return r ? deviceFrom(r) : null;
}

async function deleteDevice(tx, id) {
  const r = await tx.query('DELETE FROM devices WHERE id = $1', [id]); // agenda da tela: CASCADE
  return (r.affectedRows ?? r.rowCount) > 0;
}

// ---------- agenda ----------

async function listSchedules(tx) {
  return (await tx.query('SELECT * FROM schedules ORDER BY device_id, priority DESC, id')).rows.map(scheduleFrom);
}

async function insertSchedule(tx, orgId, s) {
  await tx.query(
    `INSERT INTO schedules (id, org_id, device_id, playlist_id, days, start_hhmm, end_hhmm, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [s.id, orgId, s.deviceId, s.playlistId, s.days, s.start, s.end, s.priority]
  );
}

async function deleteSchedule(tx, id) {
  await tx.query('DELETE FROM schedules WHERE id = $1', [id]);
}

// ---------- manifesto ----------

// Tudo de que o manifesto precisa, no formato que domain/manifest.js já entende.
async function snapshot(tx) {
  const { settings, emergency } = await getSettings(tx);
  return {
    settings,
    emergency,
    media: await listMedia(tx),
    playlists: await listPlaylists(tx),
    groups: await listGroups(tx),
    schedules: await listSchedules(tx)
  };
}

// ---------- auditoria ----------

async function audit(tx, orgId, userId, action, target = null, details = {}) {
  await tx.query(
    'INSERT INTO audit_log (org_id, user_id, action, target, details) VALUES ($1, $2, $3, $4, $5)',
    [orgId, userId || null, action, target, json(details)]
  );
}

module.exports = {
  mediaFrom, deviceFrom, publicMedia, EMPTY_EMERGENCY,
  getSettings, updateSettings, setEmergency,
  listMedia, getMedia, insertMedia, updateMedia, deleteMedia,
  listPlaylists, getPlaylist, insertPlaylist, renamePlaylist, setPlaylistItems, deletePlaylist,
  listGroups, getGroup, insertGroup, updateGroup, deleteGroup,
  listDevices, getDevice, countDevices, insertDevice, updateDevice, updateDevicePresence, deleteDevice,
  listSchedules, insertSchedule, deleteSchedule,
  snapshot, audit, exists
};
