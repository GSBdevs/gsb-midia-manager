// Fase A, etapa 2: papéis e isolamento entre clientes pela API (rotas sobre o banco).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN } = require('./helpers');

test('papéis: cada um faz só o que o papel permite', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const owner = await s.login();
  const admin = await s.addUser(owner, 'admin');
  const editor = await s.addUser(owner, 'editor');
  const viewer = await s.addUser(owner, 'viewer');
  const { device } = await s.pairDevice(owner, 'Vitrine');
  const page = (await s.call('/api/media/webpage', { method: 'POST', token: owner, body: { url: 'https://exemplo.com' } })).json;

  await t.test('viewer só lê', async () => {
    assert.equal((await s.call('/api/media', { token: viewer.token })).status, 200);
    assert.equal((await s.call('/api/playlists', { method: 'POST', token: viewer.token, body: { name: 'x' } })).status, 403);
    assert.equal((await s.call(`/api/media/${page.id}`, { method: 'DELETE', token: viewer.token })).status, 403);
    assert.equal((await s.call('/api/users', { token: viewer.token })).status, 403);
  });

  await t.test('editor mexe no conteúdo e troca a playlist da tela, mas não configura nem remove telas', async () => {
    const pl = await s.call('/api/playlists', { method: 'POST', token: editor.token, body: { name: 'Do editor' } });
    assert.equal(pl.status, 200);
    assert.equal((await s.call(`/api/devices/${device.id}`, { method: 'PATCH', token: editor.token, body: { playlistId: pl.json.id } })).status, 200);
    assert.equal((await s.call(`/api/devices/${device.id}`, { method: 'PATCH', token: editor.token, body: { volume: 10 } })).status, 403);
    assert.equal((await s.call(`/api/devices/${device.id}`, { method: 'DELETE', token: editor.token })).status, 403);
    assert.equal((await s.call('/api/settings', { method: 'PATCH', token: editor.token, body: { brandName: 'x' } })).status, 403);
    const code = (await s.call('/api/pair/request', { method: 'POST' })).json.code;
    assert.equal((await s.call('/api/devices/claim', { method: 'POST', token: editor.token, body: { code } })).status, 403);
  });

  await t.test('admin gerencia usuários, mas não mexe em donos', async () => {
    assert.equal((await s.call('/api/users', { token: admin.token })).status, 200);
    const ownerId = (await s.call('/api/me', { token: owner })).json.user.id;
    assert.equal((await s.call(`/api/users/${ownerId}`, { method: 'PATCH', token: admin.token, body: { role: 'viewer' } })).status, 403);
    assert.equal((await s.call(`/api/users/${ownerId}`, { method: 'DELETE', token: admin.token })).status, 403);
    assert.equal((await s.call('/api/users', { method: 'POST', token: admin.token, body: { email: 'novo-dono@teste.com.br', role: 'owner' } })).status, 403);
    assert.equal((await s.call(`/api/users/${editor.id}`, { method: 'PATCH', token: admin.token, body: { role: 'viewer' } })).status, 200);
    // o rebaixamento vale na hora, sem novo login
    assert.equal((await s.call('/api/playlists', { method: 'POST', token: editor.token, body: { name: 'y' } })).status, 403);
  });

  await t.test('a organização nunca fica sem dono', async () => {
    const ownerId = (await s.call('/api/me', { token: owner })).json.user.id;
    const r = await s.call(`/api/users/${ownerId}`, { method: 'PATCH', token: owner, body: { role: 'admin' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /dono/);
  });

  await t.test('remover o acesso derruba a sessão', async () => {
    assert.equal((await s.call(`/api/users/${viewer.id}`, { method: 'DELETE', token: owner })).status, 200);
    assert.equal((await s.call('/api/media', { token: viewer.token })).status, 401);
  });

  await t.test('ações que alteram dados ficam na auditoria', async () => {
    const rows = (await s.db.system((tx) => tx.query('SELECT action, user_id FROM audit_log ORDER BY id'))).rows;
    assert.ok(rows.some((r) => r.action === 'POST /playlists' && r.user_id === editor.id));
    assert.ok(rows.every((r) => !/^GET /.test(r.action)), 'leituras não são registradas');
  });
});

test('senha provisória: obrigatória a troca antes de usar o painel', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const owner = await s.login();
  const created = (await s.call('/api/users', { method: 'POST', token: owner, body: { email: 'Nova@Teste.com.br', name: 'Nova', role: 'editor' } })).json;
  assert.match(created.tempPassword, /^[A-Za-z2-9]{10}$/);

  const temp = await s.login('nova@teste.com.br', created.tempPassword);
  const blocked = await s.call('/api/media', { token: temp });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.mustChangePassword, true);
  assert.equal((await s.call('/api/me', { token: temp })).json.user.mustChangePassword, true);

  const changed = await s.call('/api/account/password', { method: 'POST', token: temp, body: { current: created.tempPassword, next: 'minha-senha-1' } });
  assert.equal((await s.call('/api/media', { token: changed.json.token })).status, 200);

  await t.test('redefinir gera nova provisória e derruba as sessões', async () => {
    const r = await s.call(`/api/users/${created.id}/reset-password`, { method: 'POST', token: owner });
    assert.equal(r.status, 200);
    assert.equal((await s.call('/api/media', { token: changed.json.token })).status, 401);
    await s.login('nova@teste.com.br', r.json.tempPassword);
  });
});

test('isolamento entre organizações pela API', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const gruposb = await s.login(); // equipe da plataforma (primeira conta)

  // segunda organização, com o próprio dono
  const org = (await s.call('/api/organizations', { method: 'POST', token: gruposb, body: { name: 'Padaria Bia' } })).json;
  await s.call('/api/organizations/switch', { method: 'POST', token: gruposb, body: { orgId: org.id } });
  const bia = await s.addUser(gruposb, 'owner', 'bia@padaria.com.br');
  await s.call('/api/organizations/switch', { method: 'POST', token: gruposb, body: { orgId: (await s.call('/api/organizations', { token: gruposb })).json.find((o) => o.name === ADMIN.orgName).id } });
  const loja = gruposb;

  const lojaPage = (await s.call('/api/media/webpage', { method: 'POST', token: loja, body: { name: 'Só da loja', url: 'https://loja.com' } })).json;
  const lojaList = (await s.call('/api/playlists', { method: 'POST', token: loja, body: { name: 'Loja' } })).json;
  const biaTv = await s.pairDevice(bia.token, 'TV da padaria');

  await t.test('cada cliente só vê o que é dele', async () => {
    assert.deepEqual((await s.call('/api/media', { token: bia.token })).json, []);
    assert.deepEqual((await s.call('/api/playlists', { token: bia.token })).json, []);
    assert.deepEqual((await s.call('/api/devices', { token: loja })).json, []);
    assert.equal((await s.call('/api/devices', { token: bia.token })).json.length, 1);
  });

  await t.test('ids de outro cliente não funcionam, nem por referência', async () => {
    assert.equal((await s.call(`/api/media/${lojaPage.id}`, { method: 'DELETE', token: bia.token })).status, 404);
    assert.equal((await s.call(`/api/devices/${biaTv.device.id}`, { method: 'PATCH', token: bia.token, body: { playlistId: lojaList.id } })).status, 400);
    const own = (await s.call('/api/playlists', { method: 'POST', token: bia.token, body: { name: 'Padaria' } })).json;
    const r = await s.call(`/api/playlists/${own.id}`, { method: 'PATCH', token: bia.token, body: { items: [{ mediaId: lojaPage.id, duration: 10 }] } });
    assert.deepEqual(r.json.items, [], 'mídia de outro cliente não entra na playlist');
  });

  await t.test('a tela só recebe o conteúdo do próprio cliente', async () => {
    const m = await s.call('/api/player/manifest', { device: biaTv.deviceToken });
    assert.equal(m.status, 200);
    assert.deepEqual(m.json.items, []);
  });

  await t.test('marca é por organização', async () => {
    await s.call('/api/settings', { method: 'PATCH', token: bia.token, body: { brandName: 'Padaria Bia' } });
    assert.equal((await s.call('/api/me', { token: bia.token })).json.branding.brandName, 'Padaria Bia');
    assert.equal((await s.call('/api/me', { token: loja })).json.branding.brandName, 'SB Mídias');
    // com dois clientes, a tela de login não sabe quem vai entrar: marca padrão
    assert.equal((await s.call('/api/branding')).json.brandName, 'SB Mídias');
  });

  await t.test('cliente não troca para organização alheia nem cria organizações', async () => {
    const other = (await s.call('/api/organizations', { token: loja })).json.find((o) => o.name === ADMIN.orgName);
    assert.equal((await s.call('/api/organizations/switch', { method: 'POST', token: bia.token, body: { orgId: other.id } })).status, 403);
    assert.equal((await s.call('/api/organizations', { method: 'POST', token: bia.token, body: { name: 'Nova' } })).status, 403);
    assert.deepEqual((await s.call('/api/organizations', { token: bia.token })).json.map((o) => o.name), ['Padaria Bia']);
  });
});
