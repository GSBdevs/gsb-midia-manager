// Sobe uma instância isolada (pasta de dados temporária, porta livre) para cada suíte.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../server/config');
const { createServer } = require('../server/app');

async function startServer(overrides = {}, { seed } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-signage-test-'));
  if (seed) fs.writeFileSync(path.join(dataDir, 'data.json'), JSON.stringify(seed));
  const config = { ...loadConfig({}), dataDir, port: 0, ...overrides };
  const instance = createServer(config);
  const port = await instance.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  async function call(pathname, { method = 'GET', body, token, device, headers = {} } = {}) {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-Auth-Token': token } : {}),
        ...(device ? { 'X-Device-Token': device } : {}),
        ...headers
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* corpo não-JSON */ }
    return { status: res.status, headers: res.headers, json, text };
  }

  async function login(password = config.adminPassword) {
    const r = await call('/api/login', { method: 'POST', body: { password } });
    if (r.status !== 200) throw new Error(`login falhou: ${r.status}`);
    return r.json.token;
  }

  // Pareia uma tela de ponta a ponta e devolve a credencial dela.
  async function pairDevice(token, name = 'Tela de teste') {
    const req = await call('/api/pair/request', { method: 'POST' });
    const claim = await call('/api/devices/claim', { method: 'POST', token, body: { code: req.json.code, name } });
    return { deviceToken: req.json.token, device: claim.json };
  }

  async function upload(token, name, bytes, type = 'application/octet-stream') {
    const fd = new FormData();
    fd.append('files', new File([bytes], name, { type }));
    return call('/api/media', { method: 'POST', token, body: fd });
  }

  async function waitMedia(token, id, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const list = (await call('/api/media', { token })).json;
      const m = list.find((x) => x.id === id);
      if (m && m.status !== 'processing') return m;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('timeout aguardando processamento');
  }

  async function close() {
    await instance.close();
    // no Windows, um arquivo recém-liberado (ffmpeg encerrado, remoção assíncrona) pode
    // ainda estar travado por alguns milissegundos: tenta de novo em vez de falhar
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  return { base, config, instance, dataDir, call, login, pairDevice, upload, waitMedia, close };
}

module.exports = { startServer };
