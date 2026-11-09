// Configuração via variáveis de ambiente, validada num só lugar.
const path = require('path');

// Quando empacotado como .exe (pkg), __dirname aponta para o snapshot somente-leitura;
// dados de runtime vão para a pasta ao lado do executável.
const isPackaged = typeof process.pkg !== 'undefined';
const baseDir = isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');

function int(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// TRUST_PROXY: vazio/false → não confia em X-Forwarded-For (padrão seguro).
// Número → quantidade de proxies na frente (ex.: 1 para Cloudflare Tunnel ou nginx).
// Texto → lista aceita pelo Express ('loopback', 'uniquelocal', CIDRs separados por vírgula).
function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false' || value === '0') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (value === 'true') {
    console.warn('[config] TRUST_PROXY=true confia em qualquer X-Forwarded-For; use o número de proxies.');
    return 1;
  }
  return value;
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function loadConfig(env = process.env) {
  const timezone = env.SIGNAGE_TZ || env.TZ || 'America/Sao_Paulo';
  if (!validTimeZone(timezone)) throw new Error(`fuso horário inválido: ${timezone}`);

  return {
    port: int(env.PORT, 4000, { min: 0, max: 65535 }),
    adminPassword: env.ADMIN_PASSWORD || 'admin',
    dataDir: env.DATA_DIR || path.join(baseDir, 'data'),
    // instaladores dos players (ex.: SBSignagePlayer-Setup.exe), baixados pelas telas em /downloads
    downloadsDir: env.DOWNLOADS_DIR || path.join(baseDir, 'downloads'),
    maxUploadMB: int(env.MAX_UPLOAD_MB, 2048, { min: 1 }),
    // CDN: prefixo absoluto para /m e /hls no manifesto (ex.: https://cdn.seudominio.com)
    mediaBaseUrl: (env.MEDIA_BASE_URL || '').replace(/\/+$/, ''),
    // vídeos com duração acima deste limite ganham variante HLS (streaming imediato)
    hlsMinMinutes: int(env.HLS_MIN_MINUTES, 10, { min: 1 }),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    timezone,
    sessionIdleDays: int(env.SESSION_IDLE_DAYS, 7, { min: 1 }),
    sessionMaxDays: int(env.SESSION_MAX_DAYS, 30, { min: 1 }),
    isPackaged
  };
}

module.exports = { loadConfig, parseTrustProxy };
