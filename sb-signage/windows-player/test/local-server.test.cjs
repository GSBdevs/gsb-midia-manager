// O servidor local do player Windows contra o servidor SB Signage de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLocalServer, normalizeServer } = require('../local-server.cjs');
const { startServer } = require('../../test/helpers');

const app = path.join(__dirname, '..', 'app');

async function local(getUpstream) {
  const server = createLocalServer({
    playerDir: path.join(app, 'player'),
    socketClient: path.join(app, 'socket.io.min.js'),
    getUpstream
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('player, API e tempo real passam pelo servidor local', async (t) => {
  const upstream = await startServer();
  const { server, base } = await local(() => upstream.base);
  t.after(async () => {
    server.close();
    await upstream.close();
  });

  await t.test('entrega o player embutido, com CSP', async () => {
    const res = await fetch(`${base}/player/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /player\.js/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).headers.get('location'), '/player/');
  });

  await t.test('pareamento atravessa o túnel e a tela fica autorizada', async () => {
    const pair = await (await fetch(`${base}/api/pair/request`, { method: 'POST' })).json();
    assert.match(pair.code, /^[A-Z0-9]{6}$/);
    const token = await upstream.login();
    await upstream.call('/api/devices/claim', { method: 'POST', token, body: { code: pair.code, name: 'Notebook' } });
    const status = await (await fetch(`${base}/api/pair/status`, { headers: { 'X-Device-Token': pair.token } })).json();
    assert.equal(status.claimed, true);
    const manifest = await fetch(`${base}/api/player/manifest`, { headers: { 'X-Device-Token': pair.token } });
    assert.equal(manifest.status, 200);
    assert.ok(manifest.headers.get('date'), 'hora do servidor chega ao player');
  });

  await t.test('WebSocket do Socket.IO abre pelo túnel', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket`);
    const first = await new Promise((resolve, reject) => {
      ws.onmessage = (m) => resolve(String(m.data));
      ws.onerror = () => reject(new Error('websocket falhou'));
      setTimeout(() => reject(new Error('sem resposta')), 5000);
    });
    ws.close();
    assert.match(first, /^0\{"sid"/, 'pacote de abertura do Engine.IO');
  });

  await t.test('arquivo fora da pasta do player é recusado', async () => {
    const res = await fetch(`${base}/player/..%2F..%2Fmain.cjs`);
    assert.ok([403, 404].includes(res.status));
  });
});

test('servidor fora do ar: o player ainda abre e a API falha como rede caída', async (t) => {
  const { server, base } = await local(() => 'http://127.0.0.1:9'); // porta sem ninguém
  t.after(() => server.close());

  assert.equal((await fetch(`${base}/player/`)).status, 200, 'página do player');
  assert.equal((await fetch(`${base}/socket.io/socket.io.js`)).status, 200, 'cliente do tempo real embutido');
  await assert.rejects(fetch(`${base}/api/player/manifest`), 'fetch rejeita: o player entra em modo offline');
});

test('endereço do servidor', () => {
  assert.equal(normalizeServer(' 192.168.0.10:4000/ '), 'http://192.168.0.10:4000');
  assert.equal(normalizeServer('https://telas.cliente.com.br/'), 'https://telas.cliente.com.br');
  assert.equal(normalizeServer('192.168.0.10:4000/player'), null, 'sem /player: o app acrescenta sozinho');
  assert.equal(normalizeServer('ftp://x'), null);
  assert.equal(normalizeServer(''), null);
});
