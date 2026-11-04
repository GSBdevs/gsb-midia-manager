// Autenticação: sessões do painel (usuário) e credenciais de tela (device) — dois mundos separados.
const crypto = require('crypto');
const { newToken, hashToken, safeEqual } = require('./util');

const MIN_PASSWORD_LENGTH = 8;

function scrypt(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 50;
const TOUCH_INTERVAL_MS = 60 * 1000; // grava lastUsedAt no máximo 1x/min por sessão

function createAuth({ store, config }) {
  const d = store.data;
  const idleMs = config.sessionIdleDays * DAY_MS;
  const maxMs = config.sessionMaxDays * DAY_MS;

  const alive = (s, now) => s.expiresAt > now && now - s.lastUsedAt < idleMs;

  function purgeSessions(now = Date.now()) {
    const before = d.sessions.length;
    d.sessions = d.sessions.filter((s) => alive(s, now));
    if (d.sessions.length > MAX_SESSIONS) d.sessions.splice(0, d.sessions.length - MAX_SESSIONS);
    return before !== d.sessions.length;
  }

  // Senha definida pelo painel (hash scrypt no data.json) tem precedência sobre ADMIN_PASSWORD.
  function checkPassword(password) {
    const stored = d.auth?.passwordHash;
    if (stored) return safeEqual(scrypt(password || '', d.auth.salt), stored);
    return safeEqual(password || '', config.adminPassword);
  }

  return {
    checkPassword,
    get usingDefaultPassword() {
      return !d.auth?.passwordHash && config.adminPassword === 'admin';
    },

    // Troca a senha e derruba todas as outras sessões. Retorna o token da nova sessão.
    changePassword(current, next) {
      if (!checkPassword(current)) throw Object.assign(new Error('senha atual incorreta'), { status: 401 });
      if (String(next || '').length < MIN_PASSWORD_LENGTH) {
        throw Object.assign(new Error(`a nova senha precisa de ao menos ${MIN_PASSWORD_LENGTH} caracteres`), { status: 400 });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      d.auth = { passwordHash: scrypt(next, salt), salt, changedAt: Date.now() };
      d.sessions = [];
      store.save();
      return this.createSession();
    },

    createSession() {
      const token = newToken();
      const now = Date.now();
      purgeSessions(now);
      d.sessions.push({ tokenHash: hashToken(token), createdAt: now, lastUsedAt: now, expiresAt: now + maxMs });
      store.save();
      return token;
    },

    // Devolve a sessão válida (renovando o uso) ou null.
    validateSession(token) {
      if (!token) return null;
      const now = Date.now();
      const h = hashToken(token);
      const session = d.sessions.find((s) => s.tokenHash === h);
      if (!session) return null;
      if (!alive(session, now)) {
        d.sessions = d.sessions.filter((s) => s !== session);
        store.save();
        return null;
      }
      if (now - session.lastUsedAt > TOUCH_INTERVAL_MS) {
        session.lastUsedAt = now;
        store.save();
      }
      return session;
    },

    revokeSession(token) {
      const h = hashToken(token || '');
      const before = d.sessions.length;
      d.sessions = d.sessions.filter((s) => s.tokenHash !== h);
      if (before !== d.sessions.length) store.save();
      return before !== d.sessions.length;
    },

    revokeAllSessions() {
      d.sessions = [];
      store.save();
    },

    findDevice(token) {
      if (!token) return null;
      const h = hashToken(token);
      return d.devices.find((dev) => dev.tokenHash === h) || null;
    },

    purgeSessions
  };
}

module.exports = { createAuth };
