// Fila de processamento de mídia (in-process, sequencial).
// Perfil de saída fixo (decisão §4.8 do plano): o que vai para a tela é H.264 8-bit em MP4,
// no máximo 1920×1080 (ou 1080×1920 em retrato) — decodificado por hardware em qualquer TV box.
// Imagens: endireitadas pela orientação EXIF e reduzidas ao tamanho da tela.
// Tudo recebe thumbnail e nome final com hash (URL imutável → cache trivial).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runFfmpeg, probe, displayDims, jpegOrientation, EXIF_FILTERS, killAll } = require('./ffmpeg');

const BOX_LONG = 1920;
const BOX_SHORT = 1080;
const MAX_PASSTHROUGH_BITRATE = 20_000_000; // bps
const PASSTHROUGH_AUDIO = new Set(['aac', 'mp3']);
// Imagens que o navegador renderiza direto e que perderiam algo se convertidas (animação, vetor).
const PASSTHROUGH_IMAGES = new Set(['gif', 'webp', 'avif', 'svg']);

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// Caixa de destino conforme a orientação do conteúdo exibido.
function boxFor(width, height) {
  return height > width ? [BOX_SHORT, BOX_LONG] : [BOX_LONG, BOX_SHORT];
}

function scaleFilter(width, height) {
  const [bw, bh] = boxFor(width || 1, height || 0);
  return `scale='min(iw,${bw})':'min(ih,${bh})':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

function fits(width, height) {
  const [bw, bh] = boxFor(width, height);
  return width <= bw && height <= bh;
}

// Decide se o vídeo pode ir direto para a tela. Retorna os motivos para transcodificar.
function planVideo(info, ext) {
  const v = info?.streams?.find((s) => s.codec_type === 'video');
  const a = info?.streams?.find((s) => s.codec_type === 'audio');
  const reasons = [];
  if (!v) return { transcode: true, reasons: ['sem trilha de vídeo legível'] };
  const { width, height } = displayDims(v);
  if (!['mp4', 'm4v'].includes(ext)) reasons.push(`container ${ext}`);
  if (v.codec_name !== 'h264') reasons.push(`codec ${v.codec_name}`);
  if (!['yuv420p', 'yuvj420p'].includes(v.pix_fmt)) reasons.push(`pixel ${v.pix_fmt}`);
  if (width && height && !fits(width, height)) reasons.push(`resolução ${width}x${height}`);
  const bitrate = parseInt(v.bit_rate || info.format?.bit_rate, 10);
  if (bitrate > MAX_PASSTHROUGH_BITRATE) reasons.push(`bitrate ${Math.round(bitrate / 1e6)} Mbps`);
  if (a && !PASSTHROUGH_AUDIO.has(a.codec_name)) reasons.push(`áudio ${a.codec_name}`);
  return { transcode: reasons.length > 0, reasons };
}

function frameRate(stream) {
  const [n, d] = String(stream?.avg_frame_rate || stream?.r_frame_rate || '0/1').split('/').map(Number);
  return d ? n / d : 0;
}

class Transcoder {
  constructor({ store, dirs, onUpdate, hlsMinSeconds = 600 }) {
    this.store = store;
    this.dirs = dirs;
    this.onUpdate = onUpdate; // (media) => void — notifica painel/players
    this.hlsMinSeconds = hlsMinSeconds;
    this.queue = [];
    this.running = false;
    this.closed = false;
  }

  enqueue(mediaId) {
    if (this.closed) return;
    this.queue.push(mediaId);
    this.next();
  }

  // Reprocessa itens que ficaram pendurados numa queda do servidor.
  recover() {
    for (const m of this.store.data.media) {
      if (m.status === 'processing') this.enqueue(m.id);
    }
  }

  // Tira da fila um item ainda não iniciado. true = cancelado (o chamador limpa os arquivos).
  cancel(mediaId) {
    const before = this.queue.length;
    this.queue = this.queue.filter((id) => id !== mediaId);
    return this.queue.length !== before;
  }

  close() {
    this.closed = true;
    this.queue = [];
    killAll();
  }

  get pending() {
    return this.queue.length + (this.running ? 1 : 0);
  }

  async next() {
    if (this.running || this.closed) return;
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
        if (!this.closed) console.error(`[transcode] falha em ${media.name}:`, err.message);
        media.status = 'failed';
        media.error = err.message;
      }
      if (this.store.data.media.includes(media)) {
        this.store.save();
        this.onUpdate(media);
      } else {
        // excluída durante o processamento: nada de arquivo órfão no disco
        this.removeFiles(media);
      }
    }
    this.running = false;
    this.next();
  }

  removeFiles(media) {
    for (const f of [
      media.original,
      media.file && path.join(this.dirs.processed, media.file),
      media.thumb && path.join(this.dirs.thumbs, media.thumb)
    ]) {
      if (f) fs.rm(f, { force: true }, () => {});
    }
    if (media.hls) fs.rm(path.join(this.dirs.hls, path.dirname(media.hls)), { recursive: true, force: true }, () => {});
  }

  async process(media) {
    const src = media.original;
    if (!fs.existsSync(src)) throw new Error('arquivo original não encontrado');

    const info = await probe(src);
    if (!info) throw new Error('arquivo ilegível ou corrompido');
    const vstream = info.streams?.find((s) => s.codec_type === 'video');
    const dims = displayDims(vstream);
    media.duration = Math.round(parseFloat(info.format?.duration) || 0) || null;
    media.width = dims.width;
    media.height = dims.height;

    const tmpBase = path.join(this.dirs.processed, `${media.id}.tmp`);
    let outFile = src;
    let outExt = media.ext;

    if (media.type === 'video') {
      const plan = planVideo(info, media.ext);
      if (plan.transcode) {
        media.transcodeReasons = plan.reasons;
        const fps = frameRate(vstream);
        outFile = `${tmpBase}.mp4`;
        outExt = 'mp4';
        await runFfmpeg([
          '-i', src,
          '-map', '0:v:0', '-map', '0:a:0?',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', fps > 30.5 ? '4.2' : '4.1',
          '-fpsmax', '60',
          '-vf', scaleFilter(dims.width, dims.height),
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
          '-movflags', '+faststart',
          outFile
        ], { timeoutMs: Math.min(6 * 3600, Math.max(600, (media.duration || 60) * 4)) * 1000 });
      } else {
        media.transcodeReasons = [];
      }
    } else if (media.type === 'image' && !PASSTHROUGH_IMAGES.has(media.ext)) {
      const orientation = ['jpg', 'jpeg'].includes(media.ext) ? jpegOrientation(src) : 1;
      // parte das dimensões brutas: a rotação é aplicada só pelo filtro EXIF abaixo
      media.width = vstream?.width || null;
      media.height = vstream?.height || null;
      if (orientation >= 5 && orientation <= 8 && media.width && media.height) {
        [media.width, media.height] = [media.height, media.width];
      }
      const needsWork = media.ext === 'bmp' || orientation !== 1 ||
        (media.width && media.height && !fits(media.width, media.height));
      if (needsWork) {
        outExt = ['png', 'bmp'].includes(media.ext) ? 'png' : 'jpg';
        outFile = `${tmpBase}.${outExt}`;
        const filters = [EXIF_FILTERS[orientation], scaleFilter(media.width, media.height)].filter(Boolean);
        await runFfmpeg([
          ...(orientation !== 1 ? ['-noautorotate'] : []),
          '-i', src, '-vf', filters.join(','), '-frames:v', '1',
          ...(outExt === 'jpg' ? ['-q:v', '3'] : []),
          outFile
        ], { timeoutMs: 120 * 1000 });
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

    if (outFile !== src) {
      // dimensões reais do que vai para a tela
      const out = await probe(finalPath);
      const d2 = displayDims(out?.streams?.find((s) => s.codec_type === 'video'));
      if (d2.width) Object.assign(media, d2);
    }

    await this.makeThumb(media, finalPath);
    await this.makeHls(media, finalPath);
  }

  // Vídeos longos ganham variante HLS: o player começa a exibir imediatamente
  // (streaming em segmentos) enquanto o MP4 completo baixa para o cache offline.
  // Só segmenta (-c copy, sem re-encode) — barato. Exige MP4 com H.264.
  async makeHls(media, srcPath) {
    media.hls = null;
    if (media.type !== 'video') return;
    if (!media.duration || media.duration < this.hlsMinSeconds) return;
    if (!['mp4', 'm4v'].includes(media.ext)) return;

    const dirName = path.basename(media.file, path.extname(media.file)); // id-hash → imutável
    const outDir = path.join(this.dirs.hls, dirName);
    try {
      fs.mkdirSync(outDir, { recursive: true });
      await runFfmpeg([
        '-i', srcPath, '-c', 'copy', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
        '-hls_segment_filename', path.join(outDir, 'seg%04d.ts'),
        path.join(outDir, 'index.m3u8')
      ], { timeoutMs: Math.max(300, media.duration) * 1000 });
      media.hls = `${dirName}/index.m3u8`;
    } catch (err) {
      console.error(`[transcode] HLS falhou em ${media.name} (segue sem streaming):`, err.message);
      fs.rm(outDir, { recursive: true, force: true }, () => {});
    }
  }

  async makeThumb(media, srcPath) {
    const thumbName = `${media.id}.jpg`;
    try {
      await runFfmpeg([
        ...(media.type === 'video' ? ['-ss', String(Math.min(1, (media.duration || 2) / 2))] : []),
        '-i', srcPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5',
        path.join(this.dirs.thumbs, thumbName)
      ], { timeoutMs: 60 * 1000 });
      media.thumb = thumbName;
    } catch {
      // SVG e afins: o ffmpeg não decodifica; o painel usa a própria mídia como preview.
      media.thumb = null;
    }
  }
}

module.exports = { Transcoder, planVideo, scaleFilter, boxFor };
