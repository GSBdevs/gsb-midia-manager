// Utilitários compartilhados pelo servidor.
const crypto = require('crypto');

const PAIR_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const newId = () => crypto.randomBytes(8).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
// Credenciais (sessões, telas) ficam no disco só como hash: vazar o data.json não entrega acesso.
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function pairCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += PAIR_CHARSET[crypto.randomInt(PAIR_CHARSET.length)];
  return c;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function validDays(days) {
  return [...new Set((Array.isArray(days) ? days : []).map(Number))]
    .filter((x) => Number.isInteger(x) && x >= 0 && x <= 6)
    .sort();
}

// Janela [start, end) em "HH:MM"; janelas que cruzam a meia-noite (22:00→06:00) são suportadas.
function inWindow(hhmm, start, end) {
  if (start === end) return true; // janela de 24 h
  if (start < end) return hhmm >= start && hhmm < end;
  return hhmm >= start || hhmm < end;
}

// Regra semanal ativa? Os dias marcados são os dias em que a janela COMEÇA:
// "quarta 22:00→06:00" vale de quarta 22:00 até quinta 06:00.
function weeklyWindowActive(days, start, end, { hhmm, day }) {
  if (start === end) return days.includes(day);
  if (start < end) return days.includes(day) && hhmm >= start && hhmm < end;
  const previous = (day + 6) % 7;
  return (days.includes(day) && hhmm >= start) || (days.includes(previous) && hhmm < end);
}

// Limitador de taxa em memória por chave (IP); entradas vencidas são descartadas periodicamente.
function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, start }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
  }, windowMs);
  timer.unref();
  return {
    // true = ainda permitido; registra a tentativa
    hit(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || now - entry.start >= windowMs) {
        entry = { count: 0, start: now };
        hits.set(key, entry);
      }
      entry.count++;
      return entry.count <= max;
    },
    blocked(key) {
      const entry = hits.get(key);
      return !!entry && Date.now() - entry.start < windowMs && entry.count >= max;
    },
    reset(key) {
      hits.delete(key);
    },
    close() {
      clearInterval(timer);
    }
  };
}

module.exports = {
  HHMM_RE, DATE_RE, newId, newToken, sha1, hashToken, pairCode, safeEqual,
  clampInt, validDays, inWindow, weeklyWindowActive, createLimiter
};
