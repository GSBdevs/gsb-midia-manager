// Persistência simples em JSON com escrita atômica e debounce.
// Volume de dados de controle (telas, playlists, agendas) é pequeno;
// os arquivos de mídia ficam no disco, fora daqui.
const fs = require('fs');
const path = require('path');

const EMPTY = {
  devices: [],    // { id, name, token, playlistId, groupId, orientation, volume, muted, overlay, powerSchedule, online, lastSeenAt, createdAt, status }
  media: [],      // { id, name, type, ext, status, original, file, hls, thumb, size, width, height, duration, error, createdAt } | type 'webpage': { id, name, type, url, status, createdAt }
  playlists: [],  // { id, name, items: [{ mediaId, duration }] , createdAt }
  schedules: [],  // { id, deviceId, playlistId, days:[0..6], start:"HH:MM", end:"HH:MM", priority }
  groups: [],     // { id, name, playlistId, createdAt }
  emergency: { active: false, mediaId: null, message: '', startedAt: null },
  sessions: [],   // { token, createdAt }
  pairings: []    // { code, token, createdAt, expiresAt, claimedDeviceId }
};

class Store {
  constructor(file) {
    this.file = file;
    this.saveTimer = null;
    this.data = structuredClone(EMPTY);
    if (fs.existsSync(file)) {
      try {
        this.data = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (err) {
        console.error('[store] arquivo de dados corrompido, iniciando vazio:', err.message);
      }
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.saveTimer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
