// Sobe uma instância isolada (pasta de dados temporária, banco em memória, porta livre) para cada suíte.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../server/config');
const { createServer } = require('../server/app');
const { openDatabase } = require('../server/db');

// conta criada no primeiro acesso de cada instância de teste
const ADMIN = { email: 'admin@teste.com.br', password: 'senha-de-teste', name: 'Admin', orgName: 'Loja Teste' };

/**
 * @param overrides  campos de config
 * @param options.seed     data.json da versão anterior, gravado antes de subir
 * @param options.setup    false = não faz o primeiro acesso (instalação nova)
 */
async function startServer(overrides = {}, { seed, setup = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-signage-test-'));
  if (seed) fs.writeFileSync(path.join(dataDir, 'data.json'), JSON.stringify(seed));
  const config = { ...loadConfig({}), dataDir, port: 0, ...overrides };
  const db = await openDatabase({ memory: true });
  const instance = await createServer(config, { db });
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

  let setupResult = null;
  if (setup) {
    const r = await call('/api/setup', { method: 'POST', body: { ...ADMIN, importLegacy: !!seed } });
    if (r.status !== 200) throw new Error(`primeiro acesso falhou: ${r.status} ${r.text}`);
    setupResult = r.json;
  }

  async function login(email = ADMIN.email, password = ADMIN.password) {
    const r = await call('/api/login', { method: 'POST', body: { email, password } });
    if (r.status !== 200) throw new Error(`login falhou: ${r.status} ${r.text}`);
    return r.json.token;
  }

  // Cadastra um usuário na organização ativa do token e devolve a sessão dele, já com senha definitiva.
  async function addUser(token, role, email = `${role}-${Date.now()}@teste.com.br`) {
    const r = await call('/api/users', { method: 'POST', token, body: { email, name: role, role } });
    if (r.status !== 200) throw new Error(`cadastro falhou: ${r.status} ${r.text}`);
    const temp = await login(email, r.json.tempPassword);
    const changed = await call('/api/account/password', { method: 'POST', token: temp, body: { current: r.json.tempPassword, next: 'senha-definitiva' } });
    return { id: r.json.id, email, token: changed.json.token };
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
    await db.close();
    // no Windows, um arquivo recém-liberado (ffmpeg encerrado, remoção assíncrona) pode
    // ainda estar travado por alguns milissegundos: tenta de novo em vez de falhar
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  return { base, config, instance, db, dataDir, setupResult, call, login, addUser, pairDevice, upload, waitMedia, close };
}

module.exports = { startServer, ADMIN };
