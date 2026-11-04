// Processamento de mídia com o ffmpeg real: orientação, dimensões e perfil de saída.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { FFMPEG, FFPROBE } = require('../server/media/ffmpeg');
const { planVideo } = require('../server/media/transcode');
const { startServer } = require('./helpers');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-media-'));
test.after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function make(name, args) {
  const out = path.join(work, name);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args, out]);
  return out;
}

function dims(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,codec_name,pix_fmt', '-of', 'json', file]).toString();
  return JSON.parse(out).streams[0];
}

// Insere um segmento EXIF mínimo (só a tag Orientation) logo após o SOI de um JPEG.
function withExifOrientation(jpegFile, orientation) {
  const jpeg = fs.readFileSync(jpegFile);
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);           // 1 entrada
  tiff.writeUInt16LE(0x0112, 10);     // Orientation
  tiff.writeUInt16LE(3, 12);          // SHORT
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);          // próximo IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  const out = jpegFile.replace(/\.jpg$/, `-exif${orientation}.jpg`);
  fs.writeFileSync(out, Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]));
  return out;
}

test('política de passthrough: só H.264 8-bit dentro da caixa da tela vai direto', () => {
  const ok = { streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080 }], format: {} };
  assert.equal(planVideo(ok, 'mp4').transcode, false);
  const tenBit = structuredClone(ok);
  tenBit.streams[0].pix_fmt = 'yuv420p10le';
  assert.equal(planVideo(tenBit, 'mp4').transcode, true);
  const fourK = structuredClone(ok);
  Object.assign(fourK.streams[0], { width: 3840, height: 2160 });
  assert.equal(planVideo(fourK, 'mp4').transcode, true);
  const portrait = structuredClone(ok);
  Object.assign(portrait.streams[0], { width: 1080, height: 1920 });
  assert.equal(planVideo(portrait, 'mp4').transcode, false, 'retrato 1080x1920 cabe na caixa');
  assert.equal(planVideo(ok, 'webm').transcode, true);
});

test('processamento real', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const token = await s.login();

  async function process(file, uploadName) {
    const r = await s.upload(token, uploadName || path.basename(file), fs.readFileSync(file));
    const m = await s.waitMedia(token, r.json.created[0].id);
    assert.equal(m.status, 'ready', m.error || '');
    return { media: m, out: dims(path.join(s.dataDir, 'processed', m.file)) };
  }

  await t.test('vídeo vertical não é forçado para paisagem (antes: 1080x1920 → 608x1080)', async () => {
    const src = make('vertical.mkv', ['-f', 'lavfi', '-i', 'color=c=red:s=1080x1920:d=1:r=10', '-c:v', 'mpeg4']);
    const { media, out } = await process(src);
    assert.deepEqual([out.width, out.height], [1080, 1920]);
    assert.deepEqual([media.width, media.height], [1080, 1920], 'painel registra o que vai para a tela');
    assert.equal(out.codec_name, 'h264');
  });

  await t.test('vídeo vertical 4K é reduzido para 1080x1920', async () => {
    const src = make('vertical4k.mkv', ['-f', 'lavfi', '-i', 'color=c=blue:s=2160x3840:d=1:r=5', '-c:v', 'mpeg4', '-q:v', '20']);
    const { out } = await process(src);
    assert.deepEqual([out.width, out.height], [1080, 1920]);
  });

  await t.test('vídeo 10-bit é normalizado para 8-bit (TV box não decodifica 10-bit)', async () => {
    const src = make('dezbits.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=640x360:d=1:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le']);
    const { out } = await process(src);
    assert.equal(out.pix_fmt, 'yuv420p');
  });

  await t.test('foto de celular com EXIF "girar 90°" é endireitada', async () => {
    const base = make('foto.jpg', ['-f', 'lavfi', '-i', 'color=c=green:s=400x200', '-frames:v', '1']);
    const { media, out } = await process(withExifOrientation(base, 6), 'foto-celular.jpg');
    assert.deepEqual([out.width, out.height], [200, 400]);
    assert.deepEqual([media.width, media.height], [200, 400]);
  });

  await t.test('imagem gigante em retrato é reduzida pela altura', async () => {
    const src = make('cartaz.png', ['-f', 'lavfi', '-i', 'color=c=white:s=1500x4000', '-frames:v', '1']);
    const { out } = await process(src);
    assert.ok(out.height <= 1920 && out.width <= 1080, `${out.width}x${out.height}`);
    assert.equal(path.extname(src), '.png');
  });

  await t.test('H.264 já adequado passa direto, sem reprocessar', async () => {
    const src = make('pronto.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=1280x720:d=1:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
    const { media } = await process(src);
    assert.deepEqual(media.transcodeReasons, []);
  });
});
