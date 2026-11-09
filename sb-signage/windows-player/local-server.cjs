// Servidor local do player Windows (só em 127.0.0.1).
//
// Entrega o player web embutido no app e encaminha API, mídia e tempo real ao servidor
// SB Signage. Para a página tudo vem da mesma origem, então o player.js roda sem alteração.
// Ganhos sobre abrir http://servidor/player num navegador:
//   - o player abre mesmo com o servidor fora do ar (exibe o que já está no cache);
//   - origem fixa em localhost: cache e pareamento sobrevivem a troca de IP do servidor.
// Não depende do Electron, para poder ser testado com node:test.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const PROXIED = ['/api/', '/m/', '/hls/', '/branding/', '/thumbs/', '/socket.io/'];
const SOCKET_CLIENT = '/socket.io/socket.io.js';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};
// mesma política do servidor; mídia e páginas web podem vir de CDN ou de outro domínio
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' blob: http: https:",
  "connect-src 'self' ws: wss: http: https:",
  "worker-src 'self' blob:",
  'frame-src http: https:',
  "base-uri 'self'"
].join('; ');

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function upstreamOptions(upstream, req) {
  const url = new URL(upstream);
  return {
    module: url.protocol === 'https:' ? https : http,
    options: {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: url.host }
    }
  };
}

/**
 * @param {object} opts
 * @param {string} opts.playerDir     pasta com index.html/player.js/vendor do player web
 * @param {string} opts.socketClient  arquivo socket.io.min.js da mesma versão do servidor
 * @param {() => string|null} opts.getUpstream  endereço atual do servidor SB Signage
 */
function createLocalServer({ playerDir, socketClient, getUpstream }) {
  const root = path.resolve(playerDir);

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);

    // o cliente do tempo real vem do app: sem ele o player não liga quando o servidor está fora
    if (pathname === SOCKET_CLIENT) return sendFile(res, socketClient);
    if (PROXIED.some((p) => pathname.startsWith(p))) return proxy(req, res);
    if (pathname === '/' || pathname === '/player') {
      res.writeHead(302, { Location: '/player/' }).end();
      return;
    }
    if (pathname.startsWith('/player/')) {
      const rel = pathname.slice('/player/'.length) || 'index.html';
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      return sendFile(res, file);
    }
    res.writeHead(404).end();
  });

  function proxy(req, res) {
    const upstream = getUpstream();
    if (!upstream) {
      res.destroy();
      return;
    }
    const { module, options } = upstreamOptions(upstream, req);
    const out = module.request(options, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    // servidor fora do ar: a conexão cai e o fetch da página falha, como em rede real.
    // O player entende isso como offline e segue tocando do cache.
    out.on('error', () => res.destroy());
    req.on('aborted', () => out.destroy());
    req.pipe(out);
  }

  // WebSocket do Socket.IO: túnel de bytes depois do aperto de mão
  server.on('upgrade', (req, socket, head) => {
    const upstream = getUpstream();
    if (!upstream || !req.url.startsWith('/socket.io/')) {
      socket.destroy();
      return;
    }
    const { module, options } = upstreamOptions(upstream, req);
    const out = module.request(options);
    out.on('upgrade', (up, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      const close = () => {
        socket.destroy();
        upSocket.destroy();
      };
      upSocket.on('error', close).on('close', close);
      socket.on('error', close).on('close', close);
      upSocket.pipe(socket).pipe(upSocket);
    });
    out.on('response', (up) => {
      socket.end(`HTTP/1.1 ${up.statusCode} ${up.statusMessage}\r\n\r\n`);
    });
    out.on('error', () => socket.destroy());
    out.end();
  });

  return server;
}

/** Aceita "192.168.0.10:4000" ou "https://telas.cliente.com.br/"; null se for inválido. */
function normalizeServer(input) {
  const text = String(input || '').trim().replace(/\/+$/, '');
  if (!text) return null;
  const full = /^[a-z]+:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(full);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

module.exports = { createLocalServer, normalizeServer, CSP };
