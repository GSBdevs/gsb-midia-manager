// Fila de processamento de mídia (in-process, sequencial).
// - Vídeos em formato/codec não-web são transcodificados para H.264/AAC MP4 (faststart).
// - Imagens gigantes são reduzidas para no máximo 1920px de largura.
// - Tudo recebe thumbnail e nome final com hash (URL imutável → cache trivial).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');

// Resolução dos binários: env var > binário ao lado do .exe (build empacotado) > ffmpeg-static.
// Dentro de um .exe (pkg), o caminho do ffmpeg-static aponta para o snapshot e não é executável —
// o script de build copia ffmpeg.exe/ffprobe.exe para a pasta dist/.
function resolveBin(envVar, name, fallback) {
  if (process.env[envVar]) return process.env[envVar];
  if (typeof process.pkg !== 'undefined') {
    const local = path.join(path.dirname(process.execPath), name + (process.platform === 'win32' ? '.exe' : ''));
    if (fs.existsSync(local)) return local;
    console.error(`[transcode] AVISO: ${name} não encontrado ao lado do executável — transcodificação vai falhar.`);
    return local;
  }
  return fallback;
}
const ffmpegPath = resolveBin('FFMPEG_PATH', 'ffmpeg', require('ffmpeg-static'));
const ffprobePath = resolveBin('FFPROBE_PATH', 'ffprobe', require('ffprobe-static').path);
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Codecs que os navegadores modernos reproduzem nativamente.
const WEB_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const WEB_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
// Containers que o <video> aceita direto.
const WEB_CONTAINERS = new Set(['mp4', 'm4v', 'webm']);
// Imagens que passam direto (o navegador renderiza nativamente).
const PASSTHROUGH_IMAGES = new Set(['gif', 'webp', 'avif', 'svg', 'bmp']);

const MAX_IMAGE_WIDTH = 1920;
const TARGET_VIDEO_HEIGHT = 1080;

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function probe(file) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, data) => resolve(err ? null : data));
  });
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    cmd.on('end', resolve).on('error', reject).run();
  });
}

class Transcoder {
  constructor({ store, dirs, onUpdate, hlsMinSeconds = 600 }) {
    this.store = store;
    this.dirs = dirs;
    this.onUpdate = onUpdate; // (media) => void — notifica painel/players
    this.hlsMinSeconds = hlsMinSeconds;
    this.queue = [];
    this.running = false;
  }

  enqueue(mediaId) {
    this.queue.push(mediaId);
    this.next();
  }

  // Reprocessa itens que ficaram pendurados numa queda do servidor.
  recover() {
    for (const m of this.store.data.media) {
      if (m.status === 'processing') this.enqueue(m.id);
    }
  }

  async next() {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) return;
    this.running = true;
    const media = this.store.data.media.find((m) => m.id === id);
    if (media) {
      try {
        await this.process(media);
        media.status = 'ready';
        media.error = null;
      } catch (err) {
        console.error(`[transcode] falha em ${media.name}:`, err.message);
        media.status = 'failed';
        media.error = err.message;
      }
      this.store.save();
      this.onUpdate(media);
    }
    this.running = false;
    this.next();
  }

  async process(media) {
    const src = media.original;
    if (!fs.existsSync(src)) throw new Error('arquivo original não encontrado');

    const info = await probe(src);
    const videoStream = info?.streams?.find((s) => s.codec_type === 'video');
    const audioStream = info?.streams?.find((s) => s.codec_type === 'audio');
    if (info) {
      media.duration = Math.round(parseFloat(info.format?.duration) || 0);
      media.width = videoStream?.width || null;
      media.height = videoStream?.height || null;
    }

    const tmpOut = path.join(this.dirs.processed, `${media.id}.tmp`);
    let outFile = src;
    let outExt = media.ext;

    if (media.type === 'video') {
      const containerOk = WEB_CONTAINERS.has(media.ext);
      const codecOk = videoStream && WEB_VIDEO_CODECS.has(videoStream.codec_name);
      const audioOk = !audioStream || WEB_AUDIO_CODECS.has(audioStream.codec_name);
      if (!(containerOk && codecOk && audioOk)) {
        // Normaliza: H.264 + AAC em MP4, limitado a 1080p, pronto pra streaming.
        const cmd = ffmpeg(src)
          .videoCodec('libx264')
          .outputOptions([
            '-preset veryfast',
            '-crf 23',
            '-pix_fmt yuv420p',
            '-profile:v high',   // perfil compatível com aceleração de hardware em TVs/TV boxes
            '-level 4.1',
            `-vf scale='min(iw,${Math.round((TARGET_VIDEO_HEIGHT * 16) / 9)})':'min(ih,${TARGET_VIDEO_HEIGHT})':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
            '-movflags +faststart'
          ])
          .audioCodec('aac')
          .audioBitrate('128k')
          .format('mp4')
          .output(tmpOut + '.mp4');
        await run(cmd);
        outFile = tmpOut + '.mp4';
        outExt = 'mp4';
      }
    } else if (media.type === 'image') {
      const needsResize =
        !PASSTHROUGH_IMAGES.has(media.ext) && media.width && media.width > MAX_IMAGE_WIDTH;
      if (needsResize) {
        const cmd = ffmpeg(src)
          .outputOptions([`-vf scale=${MAX_IMAGE_WIDTH}:-2`, '-q:v 3'])
          .output(tmpOut + '.jpg');
        await run(cmd);
        outFile = tmpOut + '.jpg';
        outExt = 'jpg';
      }
    }

    // Nome final com hash → URL imutável, cache agressivo sem risco.
    const hash = await sha1File(outFile);
    const finalName = `${media.id}-${hash.slice(0, 12)}.${outExt}`;
    const finalPath = path.join(this.dirs.processed, finalName);
    if (outFile === src) fs.copyFileSync(src, finalPath);
    else fs.renameSync(outFile, finalPath);

    media.file = finalName;
    media.size = fs.statSync(finalPath).size;
    media.ext = outExt;

    await this.makeThumb(media, finalPath);
    await this.makeHls(media, finalPath);
  }

  // Vídeos longos ganham variante HLS: o player começa a exibir imediatamente
  // (streaming em segmentos) enquanto o MP4 completo baixa para o cache offline.
  // Só segmenta (-c copy, sem re-encode) — barato. Exige container MP4 (H.264/AAC).
  async makeHls(media, srcPath) {
    media.hls = media.hls || null;
    if (media.type !== 'video') return;
    if (!media.duration || media.duration < this.hlsMinSeconds) return;
    if (!['mp4', 'm4v'].includes(media.ext)) return; // vp8/vp9 em webm não segmenta com -c copy

    const dirName = path.basename(media.file, path.extname(media.file)); // id-hash → imutável
    const outDir = path.join(this.dirs.hls, dirName);
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const cmd = ffmpeg(srcPath)
        .outputOptions([
          '-c copy',
          '-f hls',
          '-hls_time 6',
          '-hls_list_size 0',
          '-hls_segment_filename', path.join(outDir, 'seg%04d.ts')
        ])
        .output(path.join(outDir, 'index.m3u8'));
      await run(cmd);
      media.hls = `${dirName}/index.m3u8`;
    } catch (err) {
      console.error(`[transcode] HLS falhou em ${media.name} (segue sem streaming):`, err.message);
      fs.rm(outDir, { recursive: true, force: true }, () => {});
      media.hls = null;
    }
  }

  async makeThumb(media, srcPath) {
    const thumbName = `${media.id}.jpg`;
    const thumbPath = path.join(this.dirs.thumbs, thumbName);
    try {
      const cmd = ffmpeg(srcPath);
      if (media.type === 'video') {
        cmd.seekInput(Math.min(1, (media.duration || 2) / 2));
        cmd.outputOptions(['-vframes 1']);
      }
      cmd.outputOptions(['-vf scale=320:-2', '-q:v 5']).output(thumbPath);
      await run(cmd);
      media.thumb = thumbName;
    } catch {
      // SVG e afins: ffmpeg não decodifica; o painel usa a própria mídia como preview.
      media.thumb = null;
    }
  }
}

module.exports = { Transcoder };
