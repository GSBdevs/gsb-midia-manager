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

// Banco embutido (PGlite, Apache-2.0): usa import() dinâmico internamente, o que o código de
// dentro do .exe não pode fazer; vai numa pasta ao lado e é carregado do disco (server/db/index.js).
// As extensões opcionais do PostgreSQL (*.tar.gz) não são usadas e ficam de fora.
const pgliteSrc = path.join(root, 'node_modules', '@electric-sql', 'pglite'); // o pacote não exporta package.json
const pgliteDest = path.join(dist, 'pglite');
fs.rmSync(pgliteDest, { recursive: true, force: true });
fs.cpSync(pgliteSrc, pgliteDest, {
  recursive: true,
  filter: (src) => !src.endsWith('.tar.gz') && !src.endsWith('.map') && !src.endsWith('.d.ts') && !src.endsWith('.d.cts')
});

console.log('ffmpeg/ffprobe, banco embutido (pglite/), licença GPL e avisos de terceiros copiados para dist/.');
