// Coloca os instaladores onde o servidor os oferece em /downloads:
//   sb-signage/downloads       (servidor rodando com npm start)
//   sb-signage/dist/downloads  (servidor rodando pelo sb-signage.exe)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const { version } = require('../package.json');
const files = [
  path.join(__dirname, '..', 'dist', `SBSignagePlayer-Setup-${version}.exe`),
  path.join(root, 'dist', 'SBSignagePlayer-2.0.0-debug.apk') // app Android, se já foi gerado
].filter((f) => fs.existsSync(f));

for (const dir of [path.join(root, 'downloads'), path.join(root, 'dist', 'downloads')]) {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) fs.copyFileSync(file, path.join(dir, path.basename(file)));
}
console.log(`publicado em downloads/: ${files.map((f) => path.basename(f)).join(', ')}`);
