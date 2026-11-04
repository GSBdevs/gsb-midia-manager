// Copia os binários do FFmpeg para a pasta dist/ — o .exe empacotado (pkg)
// não consegue executar binários de dentro do snapshot, então eles precisam
// existir ao lado do executável.
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
fs.mkdirSync(dist, { recursive: true });

const ext = process.platform === 'win32' ? '.exe' : '';
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;

fs.copyFileSync(ffmpeg, path.join(dist, 'ffmpeg' + ext));
fs.copyFileSync(ffprobe, path.join(dist, 'ffprobe' + ext));
console.log('ffmpeg/ffprobe copiados para dist/.');
