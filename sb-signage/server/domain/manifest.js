// Regras de "o que cada tela exibe agora" — funções puras, sem I/O, cobertas por testes.
const { sha1, weeklyWindowActive } = require('../util');
const { zonedParts } = require('../time');

const DEFAULT_IMAGE_DURATION = 10; // segundos
const MANIFEST_FORMAT = 2;

// Prioridade: regra de agenda ativa (maior prioridade vence) > playlist da tela > playlist do grupo.
function resolvePlaylist(data, device, { now = new Date(), timeZone }) {
  const parts = zonedParts(now, timeZone);
  const active = data.schedules
    .filter((s) => s.deviceId === device.id && weeklyWindowActive(s.days, s.start, s.end, parts))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const group = device.groupId ? data.groups.find((g) => g.id === device.groupId) : null;
  const playlistId = active[0]?.playlistId ?? device.playlistId ?? group?.playlistId ?? null;
  return data.playlists.find((p) => p.id === playlistId) || null;
}

function manifestItem(media, item, mediaBaseUrl = '') {
  if (media.type === 'webpage') {
    return {
      id: media.id, name: media.name, type: 'webpage', url: media.url,
      duration: item?.duration || DEFAULT_IMAGE_DURATION
    };
  }
  return {
    id: media.id,
    name: media.name,
    type: media.type,
    url: `${mediaBaseUrl}/m/${media.file}`,
    hls: media.type === 'video' && media.hls ? `${mediaBaseUrl}/hls/${media.hls}` : null,
    duration: media.type === 'video' ? null : (item?.duration || DEFAULT_IMAGE_DURATION),
    mediaDuration: media.duration || null
  };
}

function buildEmergency(data, mediaBaseUrl) {
  if (!data.emergency?.active) return null;
  if (data.emergency.mediaId) {
    const m = data.media.find((x) => x.id === data.emergency.mediaId && x.status === 'ready');
    if (m) return manifestItem(m, { duration: DEFAULT_IMAGE_DURATION }, mediaBaseUrl);
  }
  return { type: 'message', message: data.emergency.message || 'ATENÇÃO' };
}

function brandingOf(settings = {}) {
  return {
    brandName: settings.brandName || 'SB Signage',
    accent: settings.accent || '#ffd60a',
    logoUrl: settings.logo ? `/branding/${settings.logo}` : null
  };
}

function buildManifest(data, device, { now = new Date(), timeZone, mediaBaseUrl = '' }) {
  const playlist = resolvePlaylist(data, device, { now, timeZone });
  const items = (playlist?.items || [])
    .map((it) => {
      const m = data.media.find((x) => x.id === it.mediaId);
      return m && m.status === 'ready' ? manifestItem(m, it, mediaBaseUrl) : null;
    })
    .filter(Boolean);
  const settings = {
    orientation: device.orientation || 0,
    fit: device.fit === 'cover' ? 'cover' : 'contain',
    volume: device.volume ?? 100,
    muted: !!device.muted,
    overlay: device.overlay || { ticker: '', showClock: false },
    powerSchedule: device.powerSchedule || null,
    timezone: timeZone
  };
  const emergency = buildEmergency(data, mediaBaseUrl);
  const branding = brandingOf(data.settings);
  // A versão cobre tudo que muda a exibição — inclusive o nome (aparece no standby/identificar).
  const version = sha1(JSON.stringify([
    MANIFEST_FORMAT,
    device.name,
    items.map((i) => [i.id, i.url, i.hls, i.duration]),
    settings,
    branding,
    emergency && [emergency.url, emergency.message]
  ]));
  return {
    format: MANIFEST_FORMAT,
    version,
    deviceName: device.name,
    playlistName: playlist?.name || null,
    serverTime: now.toISOString(),
    settings,
    branding,
    emergency,
    items
  };
}

module.exports = { resolvePlaylist, buildManifest, manifestItem, DEFAULT_IMAGE_DURATION };
