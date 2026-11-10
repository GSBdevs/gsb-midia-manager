// Coloca os instaladores onde o servidor os oferece em /downloads:
//   sb-signage/downloads       (servidor rodando com npm start)
//   sb-signage/dist/downloads  (servidor rodando pelo sb-signage.exe)
// O latest.yml diz aos players instalados qual é a versão nova (atualização remota).
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, '..', 'dist');
const { version } = require('../package.json');
const setup = `SBMidias-Setup-${version}.exe`;
const files = [
  path.join(out, setup),
  path.join(out, `${setup}.blockmap`),
  path.join(out, 'latest.yml'),
  path.join(root, 'dist', 'SBSignagePlayer-2.0.0-debug.apk') // app Android, se já foi gerado
].filter((f) => fs.existsSync(f));

for (const dir of [path.join(root, 'downloads'), path.join(root, 'dist', 'downloads')]) {
  fs.mkdirSync(dir, { recursive: true });
  // versões antigas do instalador saem: a página de download e o latest.yml apontam só a atual
  for (const old of fs.readdirSync(dir)) {
    if (/^SB(Signage)?(Player|Midias)-Setup-.*\.exe(\.blockmap)?$/.test(old) && !old.startsWith(setup)) fs.rmSync(path.join(dir, old));
  }
  for (const file of files) fs.copyFileSync(file, path.join(dir, path.basename(file)));
}
console.log(`publicado em downloads/: ${files.map((f) => path.basename(f)).join(', ')}`);
