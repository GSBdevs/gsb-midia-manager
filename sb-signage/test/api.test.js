// API ponta a ponta: autenticação, pareamento, manifesto, mídia, relatórios.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, ADMIN } = require('./helpers');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('primeiro acesso, login por e-mail e sessões', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  await t.test('rotas protegidas exigem sessão', async () => {
    assert.equal((await s.call('/api/devices')).status, 401);
  });

  await t.test('primeiro acesso só acontece uma vez', async () => {
    assert.equal((await s.call('/api/setup')).json.needed, false);
    const again = await s.call('/api/setup', { method: 'POST', body: { orgName: 'Invasor', email: 'x@x.com', password: 'qualquer123' } });
    assert.equal(again.status, 409);
  });

  await t.test('e-mail inexistente e senha errada dão a mesma resposta', async () => {
    const a = await s.call('/api/login', { method: 'POST', body: { email: 'ninguem@teste.com.br', password: 'errada123' } });
    const b = await s.call('/api/login', { method: 'POST', body: { email: ADMIN.email, password: 'errada123' } });
    assert.equal(a.status, 401);
    assert.deepEqual(a.json, b.json);
  });

  await t.test('rate limit de login não é contornável com X-Forwarded-For', async () => {
    let blocked = 0;
    for (let i = 0; i < 14; i++) {
      const r = await s.call('/api/login', {
        method: 'POST', body: { email: ADMIN.email, password: 'errada' }, headers: { 'X-Forwarded-For': `10.0.${i}.1` }
      });
      if (r.status === 429) blocked++;
    }
    assert.ok(blocked >= 4, `esperava bloqueio após 10 falhas, bloqueou ${blocked}`);
  });
});

test('sessão: /me, logout, expiração e troca de senha', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  await t.test('/me traz usuário, organização, papel e permissões', async () => {
    const me = (await s.call('/api/me', { token: await s.login() })).json;
    assert.equal(me.user.email, ADMIN.email);
    assert.equal(me.user.platformAdmin, true, 'a primeira conta administra a instalação');
    assert.equal(me.org.name, ADMIN.orgName);
    assert.equal(me.role, 'owner');
    assert.ok(me.permissions.includes('users.manage'));
    assert.equal(me.branding.brandName, 'SB Mídias');
  });

  await t.test('logout revoga a sessão no servidor', async () => {
    const token = await s.login();
    assert.equal((await s.call('/api/me', { token })).status, 200);
    await s.call('/api/logout', { method: 'POST', token });
    assert.equal((await s.call('/api/me', { token })).status, 401);
  });

  await t.test('sessão expirada é recusada', async () => {
    const token = await s.login();
    await s.db.system((tx) => tx.query("UPDATE user_sessions SET expires_at = now() - interval '1 second'"));
    assert.equal((await s.call('/api/me', { token })).status, 401);
  });

  await t.test('troca de senha derruba as outras sessões e não grava a senha em texto', async () => {
    const a = await s.login();
    const b = await s.login();
    const pw = (body) => s.call('/api/account/password', { method: 'POST', token: a, body });
    assert.equal((await pw({ current: 'x', next: 'novasenha123' })).status, 403);
    assert.equal((await pw({ current: ADMIN.password, next: 'curta' })).status, 400);
    const ok = await pw({ current: ADMIN.password, next: 'novasenha123' });
    assert.equal(ok.status, 200);
    assert.equal((await s.call('/api/me', { token: b })).status, 401, 'sessão antiga derrubada');
    assert.equal((await s.call('/api/me', { token: ok.json.token })).status, 200, 'a nova sessão vale');
    assert.equal((await s.call('/api/login', { method: 'POST', body: { email: ADMIN.email, password: ADMIN.password } })).status, 401);
    const hash = (await s.db.system((tx) => tx.query('SELECT password_hash FROM users WHERE email = $1', [ADMIN.email]))).rows[0].password_hash;
    assert.equal(hash.includes('novasenha'), false);
    assert.match(hash, /^scrypt\$/);
  });
});

test('pareamento, manifesto e credencial da tela', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const token = await s.login();
  const { deviceToken, device } = await s.pairDevice(token, 'Recepção');

  await t.test('credencial da tela fica só como hash', async () => {
    const rows = (await s.db.system((tx) => tx.query('SELECT token_hash FROM devices'))).rows;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, deviceToken);
    assert.equal(device.tokenHash, undefined, 'hash não vaza na API');
    assert.equal((await s.call('/api/devices', { token })).json[0].tokenHash, undefined);
  });

  await t.test('manifesto com ETag entre aspas e 304 quando nada mudou', async () => {
    const m = await s.call('/api/player/manifest', { device: deviceToken });
    assert.equal(m.status, 200);
    assert.equal(m.json.deviceName, 'Recepção');
    assert.match(m.headers.get('etag'), /^"[0-9a-f]{40}"$/);
    const again = await s.call('/api/player/manifest', { device: deviceToken, headers: { 'If-None-Match': m.headers.get('etag') } });
    assert.equal(again.status, 304);
    // player antigo envia a versão sem aspas
    const legacy = await s.call('/api/player/manifest', { device: deviceToken, headers: { 'If-None-Match': m.json.version } });
    assert.equal(legacy.status, 304);
  });

  await t.test('renomear a tela muda o manifesto (antes ficava o nome antigo)', async () => {
    const before = (await s.call('/api/player/manifest', { device: deviceToken })).json.version;
    await s.call(`/api/devices/${device.id}`, { method: 'PATCH', token, body: { name: 'Recepção Norte' } });
    const after = (await s.call('/api/player/manifest', { device: deviceToken })).json;
    assert.notEqual(after.version, before);
    assert.equal(after.deviceName, 'Recepção Norte');
  });

  await t.test('validação: playlist e agenda de energia inválidas são recusadas', async () => {
    assert.equal((await s.call(`/api/devices/${device.id}`, { method: 'PATCH', token, body: { playlistId: 'nao-existe' } })).status, 400);
    assert.equal((await s.call(`/api/devices/${device.id}`, { method: 'PATCH', token, body: { powerSchedule: { on: '25:00', off: '10:00', days: [1] } } })).status, 400);
    assert.equal((await s.call(`/api/devices/${device.id}`, { method: 'PATCH', token, body: { powerSchedule: null } })).status, 200);
  });

  await t.test('ajuste da mídia: padrão inteira; "preencher" chega ao player e muda o manifesto', async () => {
    const before = (await s.call('/api/player/manifest', { device: deviceToken })).json;
    assert.equal(before.settings.fit, 'contain');
    assert.equal((await s.call(`/api/devices/${device.id}`, { method: 'PATCH', token, body: { fit: 'esticar' } })).status, 400);
    assert.equal((await s.call(`/api/devices/${device.id}`, { method: 'PATCH', token, body: { fit: 'cover' } })).status, 200);
    const after = (await s.call('/api/player/manifest', { device: deviceToken })).json;
    assert.equal(after.settings.fit, 'cover');
    assert.notEqual(after.version, before.version, 'a tela recebe a mudança');
  });

  await t.test('editar a playlist em uso muda o manifesto da tela (itens e duração)', async () => {
    const page = (await s.call('/api/media/webpage', { method: 'POST', token, body: { name: 'Site', url: 'https://example.com' } })).json;
    const pl = (await s.call('/api/playlists', { method: 'POST', token, body: { name: 'Vitrine' } })).json;
    await s.call(`/api/devices/${device.id}`, { method: 'PATCH', token, body: { playlistId: pl.id } });
    const empty = (await s.call('/api/player/manifest', { device: deviceToken })).json;
    await s.call(`/api/playlists/${pl.id}`, { method: 'PATCH', token, body: { items: [{ mediaId: page.id, duration: 10 }] } });
    const one = (await s.call('/api/player/manifest', { device: deviceToken })).json;
    assert.equal(one.items.length, 1);
    assert.notEqual(one.version, empty.version);
    await s.call(`/api/playlists/${pl.id}`, { method: 'PATCH', token, body: { items: [{ mediaId: page.id, duration: 25 }] } });
    const longer = (await s.call('/api/player/manifest', { device: deviceToken })).json;
    assert.equal(longer.items[0].duration, 25);
    assert.notEqual(longer.version, one.version, 'só a duração mudou e a tela recebe');
  });

  await t.test('proof-of-play: evento vai para o dia em que aconteceu, no fuso configurado', async () => {
    // 23:30 de 03/11 em São Paulo = 02:30Z de 04/11
    const ts = Date.parse('2026-11-04T02:30:00Z');
    const r = await s.call('/api/player/logs', {
      method: 'POST', device: deviceToken,
      body: { events: [{ mediaId: 'm1', name: 'Vídeo', ts: Math.min(ts, Date.now()), dur: 30 }] }
    });
    assert.equal(r.json.saved, 1);
    const orgId = (await s.call('/api/me', { token })).json.org.id;
    const files = fs.readdirSync(path.join(s.dataDir, 'logs', orgId)); // uma pasta por organização
    if (ts <= Date.now()) assert.deepEqual(files, ['plays-2026-11-03.jsonl']);
    const rep = await s.call('/api/logs?from=2026-11-01&to=2026-11-30', { token });
    assert.equal(rep.json.totalPlays, 1);
    assert.equal(rep.json.perDay.length, 30);
  });

  await t.test('remover a tela revoga a credencial', async () => {
    await s.call(`/api/devices/${device.id}`, { method: 'DELETE', token });
    assert.equal((await s.call('/api/player/manifest', { device: deviceToken })).status, 401);
  });
});

test('mídia: nomes, formatos e segurança', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const token = await s.login();

  await t.test('nome com acento chega intacto', async () => {
    const r = await s.upload(token, 'promoção de verão.png', PNG_1X1, 'image/png');
    assert.equal(r.status, 200);
    assert.equal(r.json.created[0].name, 'promoção de verão.png');
    await s.waitMedia(token, r.json.created[0].id);
  });

  await t.test('formato não suportado é recusado e nem chega ao disco', async () => {
    const before = fs.readdirSync(path.join(s.dataDir, 'original')).length;
    const r = await s.upload(token, 'planilha.xlsx', Buffer.from('xx'));
    assert.equal(r.status, 415);
    assert.deepEqual(r.json.rejected, ['planilha.xlsx']);
    assert.equal(fs.readdirSync(path.join(s.dataDir, 'original')).length, before);
  });

  await t.test('SVG é servido em sandbox (script não executa se aberto direto)', async () => {
    const r = await s.upload(token, 'x.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml');
    const m = await s.waitMedia(token, r.json.created[0].id);
    const res = await fetch(`${s.base}/m/${m.file}`);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('painel e player saem com CSP', async () => {
    const panel = await fetch(`${s.base}/`);
    assert.match(panel.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(panel.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const player = await fetch(`${s.base}/player/`);
    assert.match(player.headers.get('content-security-policy'), /worker-src 'self' blob:/);
  });

  await t.test('página web: só http(s)', async () => {
    assert.equal((await s.call('/api/media/webpage', { method: 'POST', token, body: { url: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await s.call('/api/media/webpage', { method: 'POST', token, body: { url: 'https://exemplo.com/cardapio' } })).status, 200);
  });

  await t.test('arquivo corrompido falha com mensagem, sem derrubar a fila', async () => {
    const r = await s.upload(token, 'quebrado.mp4', Buffer.from('isto não é um vídeo'));
    const m = await s.waitMedia(token, r.json.created[0].id);
    assert.equal(m.status, 'failed');
    assert.ok(m.error);
  });

  await t.test('excluir mídia apaga os arquivos e tira das playlists', async () => {
    const r = await s.upload(token, 'apagar.png', PNG_1X1, 'image/png');
    const m = await s.waitMedia(token, r.json.created[0].id);
    const pl = (await s.call('/api/playlists', { method: 'POST', token, body: { name: 'P' } })).json;
    await s.call(`/api/playlists/${pl.id}`, { method: 'PATCH', token, body: { items: [{ mediaId: m.id, duration: 5 }] } });
    await s.call(`/api/media/${m.id}`, { method: 'DELETE', token });
    // a remoção do arquivo é assíncrona; sob carga (testes de vídeo em paralelo) pode demorar
    const file = path.join(s.dataDir, 'processed', m.file);
    for (let i = 0; i < 50 && fs.existsSync(file); i++) await new Promise((res) => setTimeout(res, 100));
    assert.equal(fs.existsSync(file), false);
    const after = (await s.call('/api/playlists', { token })).json.find((p) => p.id === pl.id);
    assert.deepEqual(after.items, []);
  });

  await t.test('visão geral do painel', async () => {
    const o = await s.call('/api/overview', { token });
    assert.equal(o.status, 200);
    assert.ok(o.json.media.total >= 3);
    assert.equal(typeof o.json.media.bytes, 'number');
  });
});

test('instaladores dos players são baixados em /downloads', async (t) => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-downloads-'));
  fs.writeFileSync(path.join(downloadsDir, 'Player-Setup.exe'), 'MZ-teste');
  const s = await startServer({ downloadsDir });
  t.after(async () => {
    await s.close();
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  });
  const ok = await s.call('/downloads/Player-Setup.exe');
  assert.equal(ok.status, 200);
  assert.equal(ok.text, 'MZ-teste');
  assert.match(ok.headers.get('content-disposition'), /attachment/);
  assert.equal((await s.call('/downloads/')).status, 404, 'sem listagem da pasta');
  const escape = await s.call('/downloads/..%2Fdata.json');
  assert.ok([403, 404].includes(escape.status), `fora da pasta: ${escape.status}`);
});

test('primeiro acesso importa a instalação anterior (até da v1) sem parear as telas de novo', async () => {
  const seed = {
    devices: [{ id: 'd1', name: 'TV antiga', token: 'tok-antigo', playlistId: 'p1' }],
    sessions: [{ token: 'sess-antiga', createdAt: Date.now() }],
    media: [{ id: 'w1', name: 'Cardápio', type: 'webpage', url: 'https://exemplo.com', status: 'ready', createdAt: 1 },
      { id: 'f1', name: 'falhou.mp4', type: 'video', status: 'failed', error: 'x', createdAt: 2 }],
    playlists: [{ id: 'p1', name: 'Loja', items: [{ mediaId: 'w1', duration: 15 }], createdAt: 1 }],
    schedules: [], pairings: []
  };
  const s = await startServer({}, { setup: false, seed });
  try {
    fs.mkdirSync(path.join(s.dataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(s.dataDir, 'logs', 'plays-2026-10-01.jsonl'), '{"ts":1,"deviceId":"d1","mediaId":"w1","dur":15}\n');
    const status = (await s.call('/api/setup')).json;
    assert.equal(status.needed, true);
    assert.deepEqual([status.legacy.devices, status.legacy.media], [1, 2], 'a tela de primeiro acesso mostra o que vai importar');

    const r = await s.call('/api/setup', { method: 'POST', body: { ...ADMIN, importLegacy: true } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.imported.devices, 1);
    assert.equal(r.json.imported.logs, 1);

    const m = await s.call('/api/player/manifest', { device: 'tok-antigo' });
    assert.equal(m.status, 200, 'tela continua pareada');
    assert.deepEqual(m.json.items.map((i) => [i.id, i.duration]), [['w1', 15]]);
    assert.equal((await s.call('/api/me', { token: 'sess-antiga' })).status, 401, 'sessões antigas não valem no login por e-mail');
    const rep = await s.call('/api/logs?date=2026-10-01', { token: r.json.token });
    assert.equal(rep.json.totalPlays, 1, 'relatórios antigos acompanham a organização');
    assert.ok(fs.existsSync(path.join(s.dataDir, 'data.json')), 'o data.json não é alterado');
  } finally {
    await s.close();
  }
});
