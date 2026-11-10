// Persistência: migração de esquema e recuperação de arquivo corrompido.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, migrate, SCHEMA_VERSION } = require('../server/store');
const { hashToken } = require('../server/util');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-store-'));

test('migração v1 → atual: tokens viram hash e campos novos ganham padrão', () => {
  const v1 = {
    devices: [{ id: 'd1', name: 'TV', token: 'segredo-da-tela', playlistId: null }],
    sessions: [{ token: 'segredo-da-sessao', createdAt: 1000 }],
    pairings: [{ code: 'ABC234', token: 'segredo-do-par', claimedDeviceId: 'd1' }],
    media: [], playlists: [], schedules: []
  };
  const d = migrate(v1);
  assert.equal(d.schemaVersion, SCHEMA_VERSION);
  assert.equal(d.devices[0].token, undefined, 'token em texto puro não fica no disco');
  assert.equal(d.devices[0].tokenHash, hashToken('segredo-da-tela'));
  assert.equal(d.devices[0].volume, 100);
  assert.deepEqual(d.devices[0].overlay, { ticker: '', showClock: false });
  assert.equal(d.sessions[0].tokenHash, hashToken('segredo-da-sessao'));
  assert.ok(d.sessions[0].expiresAt > 1000);
  assert.equal(d.pairings[0].tokenHash, hashToken('segredo-do-par'));
  assert.equal(d.settings.brandName, 'SB Mídias', 'nome antigo padrão vira o novo');
  assert.deepEqual(d.groups, []);
  // idempotente
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(d))), d);
});

test('arquivo corrompido não é sobrescrito: vai para quarentena e o backup é usado', () => {
  const dir = tmp();
  const file = path.join(dir, 'data.json');
  const store = new Store(file);
  store.data.playlists.push({ id: 'p1', name: 'Original', items: [] });
  store.flush();
  store.data.playlists[0].name = 'Segunda versão';
  store.flush(); // .bak agora contém "Original"

  fs.writeFileSync(file, '{ isto não é json');
  const recovered = new Store(file);
  assert.equal(recovered.data.playlists[0].name, 'Original');
  const quarantined = fs.readdirSync(dir).filter((f) => f.includes('corrompido'));
  assert.equal(quarantined.length, 1, 'arquivo ilegível preservado para análise');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
