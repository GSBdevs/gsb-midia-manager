// Copia os binários do FFmpeg para a pasta dist/ — o .exe empacotado (pkg)
// não consegue executar binários de dentro do snapshot, então eles precisam
// existir ao lado do executável. Junto vão a licença (GPL-3.0) e os avisos de
// terceiros, obrigatórios ao distribuir esses binários.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const ext = process.platform === 'win32' ? '.exe' : '';
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;

fs.copyFileSync(ffmpeg, path.join(dist, 'ffmpeg' + ext));
fs.copyFileSync(ffprobe, path.join(dist, 'ffprobe' + ext));

const ffmpegDir = path.dirname(ffmpeg);
const licenseSrc = [path.join(ffmpegDir, 'ffmpeg.exe.LICENSE'), path.join(ffmpegDir, 'LICENSE')].find(fs.existsSync);
if (licenseSrc) fs.copyFileSync(licenseSrc, path.join(dist, 'FFMPEG-LICENSE.txt'));
const readmeSrc = path.join(ffmpegDir, 'ffmpeg.exe.README');
if (fs.existsSync(readmeSrc)) fs.copyFileSync(readmeSrc, path.join(dist, 'FFMPEG-BUILD-INFO.txt'));
fs.copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(dist, 'THIRD_PARTY_NOTICES.md'));

console.log('ffmpeg/ffprobe, licença GPL e avisos de terceiros copiados para dist/.');
