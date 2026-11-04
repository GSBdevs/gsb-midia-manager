// Persistência em JSON com escrita atômica, debounce, backup e migração de esquema.
// Volume de dados de controle (telas, playlists, agendas) é pequeno;
// os arquivos de mídia ficam no disco, fora daqui.
const fs = require('fs');
const { hashToken } = require('./util');

const SCHEMA_VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  brandName: 'SB Signage',
  accent: '#ffd60a',
  theme: 'dark',       // 'dark' | 'light' | 'system'
  density: 'comfortable', // 'comfortable' | 'compact'
  logo: null           // nome do arquivo em data/branding
};

function emptyData() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    devices: [],    // { id, name, tokenHash, playlistId, groupId, orientation, volume, muted, overlay, powerSchedule, online, lastSeenAt, createdAt, status }
    media: [],      // { id, name, type, ext, status, original, file, hls, thumb, size, width, height, duration, error, createdAt } | webpage: { id, name, type, url, status, createdAt }
    playlists: [],  // { id, name, items: [{ mediaId, duration }], createdAt }
    schedules: [],  // { id, deviceId, playlistId, days:[0..6], start:"HH:MM", end:"HH:MM", priority }
    groups: [],     // { id, name, playlistId, createdAt }
    emergency: { active: false, mediaId: null, message: '', startedAt: null },
    sessions: [],   // { tokenHash, createdAt, lastUsedAt, expiresAt }
    pairings: []    // { code, tokenHash, createdAt, expiresAt, claimedDeviceId }
  };
}

// Leva dados de qualquer versão anterior ao esquema atual. Idempotente.
function migrate(raw, { sessionMaxDays = 30 } = {}) {
  const data = { ...emptyData(), ...raw };
  data.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  data.emergency = { ...emptyData().emergency, ...(raw.emergency || {}) };

  for (const dev of data.devices) {
    if (dev.token && !dev.tokenHash) dev.tokenHash = hashToken(dev.token);
    delete dev.token;
    dev.groupId ??= null;
    dev.orientation ??= 0;
    dev.volume ??= 100;
    dev.muted ??= false;
    dev.overlay ??= { ticker: '', showClock: false };
    dev.powerSchedule ??= null;
    dev.status ??= null;
  }
  for (const p of data.pairings) {
    if (p.token && !p.tokenHash) p.tokenHash = hashToken(p.token);
    delete p.token;
  }
  data.sessions = data.sessions.map((s) => {
    const createdAt = s.createdAt || Date.now();
    return {
      tokenHash: s.tokenHash || hashToken(s.token),
      createdAt,
      lastUsedAt: s.lastUsedAt || createdAt,
      expiresAt: s.expiresAt || createdAt + sessionMaxDays * DAY_MS
    };
  });
  data.schemaVersion = SCHEMA_VERSION;
  return data;
}

class Store {
  constructor(file, options = {}) {
    this.file = file;
    this.saveTimer = null;
    this.data = migrate(this.load(), options);
  }

  load() {
    for (const candidate of [this.file, this.file + '.bak']) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (candidate !== this.file) console.warn('[store] arquivo principal ilegível; recuperado do backup.');
        return parsed;
      } catch (err) {
        // Nunca sobrescreve um arquivo ilegível: guarda para análise antes de seguir.
        const quarantine = `${candidate}.corrompido-${Date.now()}`;
        fs.renameSync(candidate, quarantine);
        console.error(`[store] ${candidate} corrompido (${err.message}); movido para ${quarantine}`);
      }
    }
    return emptyData();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, migrate, emptyData, DEFAULT_SETTINGS, SCHEMA_VERSION };
