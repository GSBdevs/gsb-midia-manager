// Execução direta do ffmpeg/ffprobe (substitui o fluent-ffmpeg, descontinuado).
// Cada execução tem tempo limite e pode ser encerrada no desligamento do servidor.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Resolução dos binários: variável de ambiente > binário ao lado do .exe (build empacotado) > ffmpeg-static.
// Dentro de um .exe (pkg), o caminho do ffmpeg-static aponta para o snapshot e não é executável —
// o script de build copia ffmpeg.exe/ffprobe.exe para a pasta dist/.
function resolveBin(envVar, name, fallback) {
  if (process.env[envVar]) return process.env[envVar];
  if (typeof process.pkg !== 'undefined') {
    const local = path.join(path.dirname(process.execPath), name + (process.platform === 'win32' ? '.exe' : ''));
    if (!fs.existsSync(local)) console.error(`[ffmpeg] ${name} não encontrado ao lado do executável — processamento de mídia vai falhar.`);
    return local;
  }
  return fallback();
}

const FFMPEG = resolveBin('FFMPEG_PATH', 'ffmpeg', () => require('ffmpeg-static'));
const FFPROBE = resolveBin('FFPROBE_PATH', 'ffprobe', () => require('ffprobe-static').path);

const active = new Set();

function exec(bin, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    active.add(child);
    const out = [];
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => { err = (err + b).slice(-4000); });
    child.on('error', (e) => {
      clearTimeout(timer);
      active.delete(child);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      active.delete(child);
      if (timedOut) return reject(new Error(`tempo limite excedido (${Math.round(timeoutMs / 1000)} s)`));
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-3).join(' | ') || `saiu com código ${code}`));
      resolve(Buffer.concat(out));
    });
  });
}

function runFfmpeg(args, options) {
  return exec(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], options);
}

async function probe(file) {
  try {
    const out = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeoutMs: 60 * 1000 });
    return JSON.parse(out.toString('utf8'));
  } catch {
    return null;
  }
}

// Rotação declarada pelo arquivo (celulares gravam "deitado" + metadado de rotação).
function streamRotation(stream) {
  const side = (stream?.side_data_list || []).find((s) => typeof s.rotation === 'number');
  const raw = side ? side.rotation : parseInt(stream?.tags?.rotate, 10) || 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

// Dimensões como o quadro é EXIBIDO (após aplicar a rotação).
function displayDims(stream) {
  if (!stream?.width || !stream?.height) return { width: null, height: null };
  const rot = streamRotation(stream);
  return rot === 90 || rot === 270
    ? { width: stream.height, height: stream.width }
    : { width: stream.width, height: stream.height };
}

// Orientação EXIF de um JPEG (1 = normal). Lê só o cabeçalho.
function jpegOrientation(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(128 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    buf = buf.subarray(0, n);
  } catch {
    return 1;
  }
  if (buf.readUInt16BE(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 < buf.length) {
    const marker = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xffe1 && buf.toString('ascii', off + 4, off + 8) === 'Exif') {
      const tiff = off + 10;
      const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
      const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = tiff + u32(tiff + 4);
      const entries = u16(ifd);
      for (let i = 0; i < entries; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > buf.length) break;
        if (u16(e) === 0x0112) return u16(e + 8) || 1;
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
    off += 2 + len;
  }
  return 1;
}

// Filtro que endireita a imagem segundo a orientação EXIF.
const EXIF_FILTERS = {
  2: 'hflip', 3: 'hflip,vflip', 4: 'vflip',
  5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2'
};

function killAll() {
  for (const child of active) child.kill('SIGKILL');
  active.clear();
}

module.exports = {
  runFfmpeg, probe, displayDims, streamRotation, jpegOrientation, EXIF_FILTERS, killAll, FFMPEG, FFPROBE
};
