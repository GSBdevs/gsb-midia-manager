// Fase A: banco multiusuário. O teste mais importante de um SaaS: um cliente não enxerga o outro.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../server/db');
const { createAccounts, can, hashPassword } = require('../server/accounts');
const { importFromJson } = require('../server/db/import-json');
const { hashToken } = require('../server/util');

async function setup() {
  const db = await openDatabase({ memory: true });
  const accounts = createAccounts(db);
  const lojaA = await accounts.createOrganization({ name: 'Loja Ângelo' });
  const lojaB = await accounts.createOrganization({ name: 'Loja Bia' });
  const addMedia = (org, id, name) => db.withOrg(org.id, (tx) => tx.query(
    "INSERT INTO media (id, org_id, name, type, status) VALUES ($1, $2, $3, 'image', 'ready')", [id, org.id, name]
  ));
  await addMedia(lojaA, 'a1', 'Promoção A');
  await addMedia(lojaB, 'b1', 'Promoção B');
  return { db, accounts, lojaA, lojaB };
}

test('isolamento entre clientes (RLS no próprio banco)', async (t) => {
  const { db, lojaA, lojaB } = await setup();
  t.after(() => db.close());

  await t.test('consulta SEM filtro de organização só devolve o próprio cliente', async () => {
    const rows = (await db.withOrg(lojaA.id, (tx) => tx.query('SELECT id FROM media'))).rows;
    assert.deepEqual(rows.map((r) => r.id), ['a1']);
  });

  await t.test('não altera nem apaga dados de outro cliente, mesmo pelo id', async () => {
    const upd = await db.withOrg(lojaA.id, (tx) => tx.query("UPDATE media SET name = 'invadido' WHERE id = 'b1'"));
    const del = await db.withOrg(lojaA.id, (tx) => tx.query("DELETE FROM media WHERE id = 'b1'"));
    assert.equal(upd.affectedRows ?? upd.rowCount, 0);
    assert.equal(del.affectedRows ?? del.rowCount, 0);
    const b = (await db.withOrg(lojaB.id, (tx) => tx.query("SELECT name FROM media WHERE id = 'b1'"))).rows[0];
    assert.equal(b.name, 'Promoção B');
  });

  await t.test('não insere dados em nome de outro cliente', async () => {
    await assert.rejects(db.withOrg(lojaA.id, (tx) => tx.query(
      "INSERT INTO media (id, org_id, name, type, status) VALUES ('x', $1, 'falsa', 'image', 'ready')", [lojaB.id]
    )), /row-level security/);
  });

  await t.test('sem organização definida não há dados', async () => {
    const rows = await db.system(async (tx) => {
      await tx.query('SET LOCAL ROLE sb_app');
      return (await tx.query('SELECT id FROM media')).rows;
    });
    assert.equal(rows.length, 0);
  });

  await t.test('organização com formato inválido é recusada antes do banco', async () => {
    assert.throws(() => db.withOrg("x' OR 1=1 --", () => {}), /organização inválida/);
  });
});

test('usuários, papéis e sessões', async (t) => {
  const { db, accounts, lojaA, lojaB } = await setup();
  t.after(() => db.close());
  const ana = await accounts.createUser({ email: ' Ana@Loja.com ', name: 'Ana', password: 'senha-forte-1' });
  await accounts.setMembership(lojaA.id, ana.id, 'owner');

  await t.test('permissões por papel', () => {
    assert.equal(can('viewer', 'content.read'), true);
    assert.equal(can('viewer', 'content.write'), false);
    assert.equal(can('editor', 'content.write'), true);
    assert.equal(can('editor', 'devices.write'), false);
    assert.equal(can('admin', 'users.manage'), true);
    assert.equal(can('admin', 'org.delete'), false);
    assert.equal(can('owner', 'org.delete'), true);
  });

  await t.test('e-mail normalizado, senha curta e e-mail repetido são recusados', async () => {
    assert.equal(ana.email, 'ana@loja.com');
    await assert.rejects(accounts.createUser({ email: 'b@b.com', password: 'curta' }), /8 caracteres/);
    await assert.rejects(accounts.createUser({ email: 'ANA@loja.com', password: 'outra-senha-1' }), /já cadastrado/);
  });

  await t.test('login abre a sessão na organização do usuário; token só como hash', async () => {
    await assert.rejects(accounts.login('ana@loja.com', 'errada'), /e-mail ou senha incorretos/);
    await assert.rejects(accounts.login('ninguem@x.com', 'senha-forte-1'), /e-mail ou senha incorretos/);
    const { token } = await accounts.login('ANA@loja.com', 'senha-forte-1');
    const s = await accounts.validateSession(token);
    assert.equal(s.org.id, lojaA.id);
    assert.equal(s.role, 'owner');
    const stored = await db.system((tx) => tx.query('SELECT token_hash FROM user_sessions'));
    assert.equal(stored.rows[0].token_hash, hashToken(token));
  });

  await t.test('usuário de duas organizações troca de uma para outra; sem acesso, é recusado', async () => {
    const { token } = await accounts.login('ana@loja.com', 'senha-forte-1');
    await assert.rejects(accounts.switchOrganization(token, lojaB.id), /sem acesso/);
    await accounts.setMembership(lojaB.id, ana.id, 'viewer');
    const s = await accounts.switchOrganization(token, lojaB.id);
    assert.equal(s.org.id, lojaB.id);
    assert.equal(s.role, 'viewer');
  });

  await t.test('organização nunca fica sem dono', async () => {
    await assert.rejects(accounts.setMembership(lojaA.id, ana.id, 'admin'), /ao menos um dono/);
    await assert.rejects(accounts.removeMembership(lojaA.id, ana.id), /ao menos um dono/);
  });

  await t.test('remover o acesso derruba a sessão naquela organização', async () => {
    const bia = await accounts.createUser({ email: 'bia@loja.com', password: 'senha-forte-2' });
    await accounts.setMembership(lojaA.id, bia.id, 'editor');
    const { token } = await accounts.login('bia@loja.com', 'senha-forte-2');
    assert.equal((await accounts.validateSession(token)).role, 'editor');
    await accounts.removeMembership(lojaA.id, bia.id);
    assert.equal(await accounts.validateSession(token), null);
  });

  await t.test('organização suspensa bloqueia o acesso', async () => {
    const { token } = await accounts.login('ana@loja.com', 'senha-forte-1');
    await accounts.switchOrganization(token, lojaA.id);
    await db.system((tx) => tx.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [lojaA.id]));
    assert.equal(await accounts.validateSession(token), null);
    await db.system((tx) => tx.query("UPDATE organizations SET status = 'active' WHERE id = $1", [lojaA.id]));
  });

  await t.test('trocar a senha derruba todas as sessões', async () => {
    const { token } = await accounts.login('ana@loja.com', 'senha-forte-1');
    await accounts.changePassword(ana.id, 'senha-forte-1', 'senha-nova-123');
    assert.equal(await accounts.validateSession(token), null);
    await accounts.login('ana@loja.com', 'senha-nova-123');
  });

  await t.test('auditoria fica na organização', async () => {
    await accounts.audit(lojaA.id, ana.id, 'media.delete', 'a1');
    const a = (await db.withOrg(lojaA.id, (tx) => tx.query('SELECT action FROM audit_log'))).rows;
    const b = (await db.withOrg(lojaB.id, (tx) => tx.query('SELECT action FROM audit_log'))).rows;
    assert.deepEqual(a.map((r) => r.action), ['media.delete']);
    assert.equal(b.length, 0);
  });
});

test('importação do data.json atual', async (t) => {
  const db = await openDatabase({ memory: true });
  const accounts = createAccounts(db);
  t.after(() => db.close());
  const salt = 'abc123';
  const fromPanel = hashPassword('senha-do-painel', salt).split('$')[2];
  const data = {
    settings: { brandName: 'SB Signage', accent: '#00e5ff' },
    auth: { passwordHash: fromPanel, salt },
    media: [
      { id: 'm1', name: 'foto.jpg', type: 'image', status: 'ready', file: 'm1-x.jpg', ext: 'jpg', original: 'C:/x', size: 10, width: 736, height: 421, duration: 0, createdAt: 1783702136310 },
      { id: 'm2', name: 'filme.mp4', type: 'video', status: 'ready', file: 'm2-y.mp4', duration: 12.5 }
    ],
    playlists: [{ id: 'p1', name: 'Vitrine', items: [{ mediaId: 'm2', duration: 10 }, { mediaId: 'apagada', duration: 5 }, { mediaId: 'm1', duration: 7 }] }],
    groups: [{ id: 'g1', name: 'Térreo', playlistId: 'p1' }],
    devices: [{ id: 'd1', name: 'TV Entrada', tokenHash: hashToken('credencial-da-tv'), playlistId: 'p1', groupId: 'g1', orientation: 90, volume: 20, overlay: { ticker: 'Oi', showClock: true } }],
    schedules: [{ id: 's1', deviceId: 'd1', playlistId: 'p1', days: [1, 5], start: '22:00', end: '02:00', priority: 1 }],
    emergency: { active: false }
  };

  const result = await importFromJson(db, accounts, data, { orgName: 'GrupoSB', ownerEmail: 'dono@gruposb.com' });
  assert.deepEqual(result.counts, { media: 2, playlists: 1, items: 2, groups: 1, devices: 1, schedules: 1 });

  await t.test('o dono entra com a senha que já usava no painel', async () => {
    const { token, mustChangePassword } = await accounts.login('dono@gruposb.com', 'senha-do-painel');
    assert.equal(mustChangePassword, false);
    assert.equal((await accounts.validateSession(token)).role, 'owner');
  });

  await t.test('a TV já pareada continua reconhecida pela mesma credencial', async () => {
    const dev = (await db.system((tx) => tx.query('SELECT id, org_id FROM devices WHERE token_hash = $1', [hashToken('credencial-da-tv')]))).rows[0];
    assert.equal(dev.id, 'd1');
    assert.equal(dev.org_id, result.org.id);
  });

  await t.test('ordem da playlist preservada, item de mídia apagada descartado', async () => {
    const rows = (await db.withOrg(result.org.id, (tx) => tx.query(
      "SELECT media_id, duration FROM playlist_items WHERE playlist_id = 'p1' ORDER BY position"
    ))).rows;
    assert.deepEqual(rows.map((r) => [r.media_id, r.duration]), [['m2', 10], ['m1', 7]]);
  });

  await t.test('marca: nome antigo padrão vira SB Mídias, cor mantida', async () => {
    const s = (await db.withOrg(result.org.id, (tx) => tx.query('SELECT brand_name, accent FROM org_settings'))).rows[0];
    assert.deepEqual([s.brand_name, s.accent], ['SB Mídias', '#00e5ff']);
  });

  await t.test('excluir a mídia tira ela da playlist (integridade no banco)', async () => {
    await db.withOrg(result.org.id, (tx) => tx.query("DELETE FROM media WHERE id = 'm2'"));
    const n = (await db.withOrg(result.org.id, (tx) => tx.query('SELECT count(*)::int AS n FROM playlist_items'))).rows[0].n;
    assert.equal(n, 1);
  });

  await t.test('sem senha no painel antigo: dono com senha provisória e troca obrigatória', async () => {
    const r = await importFromJson(db, accounts, { media: [], playlists: [], devices: [] }, { orgName: 'Outro', ownerEmail: 'b@x.com' });
    assert.equal(r.mustChangePassword, true);
    const { mustChangePassword } = await accounts.login('b@x.com', 'admin1234');
    assert.equal(mustChangePassword, true);
  });
});

test('banco em disco: reabrir não reaplica migrações nem perde dados', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-db-'));
  try {
    let db = await openDatabase({ dataDir: dir });
    assert.deepEqual(db.applied, ['001_multiusuario.sql']);
    await createAccounts(db).createOrganization({ name: 'Persistente' });
    await db.close();
    db = await openDatabase({ dataDir: dir });
    assert.deepEqual(db.applied, []);
    const n = (await db.system((tx) => tx.query('SELECT count(*)::int AS n FROM organizations'))).rows[0].n;
    assert.equal(n, 1);
    await db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
