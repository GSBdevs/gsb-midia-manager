// Estado central do painel + carregadores + consultas derivadas.
import { api } from './api.js';

export const state = {
  me: null,
  settings: { brandName: 'SB Signage', accent: '#ffd60a', theme: 'dark', density: 'comfortable', logoUrl: null },
  devices: [],
  media: [],
  playlists: [],
  schedules: [],
  groups: [],
  emergency: null,
  overview: null
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(...keys) {
  for (const fn of listeners) fn(new Set(keys));
}

const loaders = {
  me: async () => { state.me = await api('/me'); },
  devices: async () => { state.devices = await api('/devices'); },
  media: async () => { state.media = await api('/media'); },
  playlists: async () => { state.playlists = await api('/playlists'); },
  schedules: async () => { state.schedules = await api('/schedules'); },
  groups: async () => { state.groups = await api('/groups'); },
  emergency: async () => { state.emergency = await api('/emergency'); },
  overview: async () => { state.overview = await api('/overview'); }
};

// Recarrega coleções; evita disparos repetidos simultâneos da mesma coleção.
const inflight = new Map();
export async function load(...keys) {
  await Promise.all(keys.map((k) => {
    if (!inflight.has(k)) {
      inflight.set(k, loaders[k]().finally(() => inflight.delete(k)));
    }
    return inflight.get(k);
  }));
  emit(...keys);
}
export const loadAll = () => load('devices', 'media', 'playlists', 'schedules', 'groups', 'emergency', 'overview');

// Atualização pontual de status vinda do socket (sem recarregar a lista inteira).
export function patchDeviceStatus({ id, online, lastSeenAt, status }) {
  const dev = state.devices.find((d) => d.id === id);
  if (!dev) return false;
  Object.assign(dev, { online, lastSeenAt, status });
  emit('device-status');
  return true;
}

// ---------- consultas ----------
export const mediaById = (id) => state.media.find((m) => m.id === id);
export const playlistById = (id) => state.playlists.find((p) => p.id === id);
export const groupById = (id) => state.groups.find((g) => g.id === id);
export const deviceById = (id) => state.devices.find((d) => d.id === id);

// duração total de itens (vídeo: duração da mídia; imagem/página: duração configurada)
export function itemsTotal(items) {
  return items.reduce((sum, it) => {
    const m = mediaById(it.mediaId);
    if (!m) return sum;
    return sum + (m.type === 'video' ? (m.duration || 0) : (it.duration || 10));
  }, 0);
}

// Playlist que a tela usa quando nenhuma regra de agenda está ativa.
export function basePlaylistOf(device) {
  if (device.playlistId) return { playlist: playlistById(device.playlistId), source: 'tela' };
  const group = groupById(device.groupId);
  if (group?.playlistId) return { playlist: playlistById(group.playlistId), source: `grupo ${group.name}` };
  return { playlist: null, source: null };
}

// Onde uma playlist é usada (para avisar antes de excluir e mostrar no editor).
export function playlistUsage(id) {
  return {
    devices: state.devices.filter((d) => d.playlistId === id),
    groups: state.groups.filter((g) => g.playlistId === id),
    schedules: state.schedules.filter((s) => s.playlistId === id)
  };
}

export function mediaUsage(id) {
  return state.playlists.filter((p) => p.items.some((it) => it.mediaId === id));
}

// Problemas que pedem atenção numa tela.
export function deviceIssues(dev) {
  const issues = [];
  const s = dev.status || {};
  if (!dev.online) issues.push({ kind: 'danger', text: 'offline' });
  if (s.cacheErrors > 0 && s.missing > 0) issues.push({ kind: 'warn', text: s.lastError || 'falha ao baixar conteúdo' });
  else if (s.missing > 0 && dev.online) issues.push({ kind: 'info', text: `baixando ${s.missing} ${s.missing === 1 ? 'item' : 'itens'}` });
  if (s.storageQuota && s.storageUsage / s.storageQuota > 0.9) issues.push({ kind: 'warn', text: 'armazenamento quase cheio' });
  if (!basePlaylistOf(dev).playlist && !state.schedules.some((r) => r.deviceId === dev.id)) {
    issues.push({ kind: 'info', text: 'sem playlist' });
  }
  return issues;
}

export const thumbUrl = (m) => {
  if (!m) return null;
  if (m.thumb) return `/thumbs/${m.thumb}`;
  if (m.status === 'ready' && m.type === 'image' && m.file) return `/m/${m.file}`;
  return null;
};
