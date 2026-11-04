// Copia as bibliotecas de front-end para public/ (o painel e o player funcionam offline na LAN,
// sem CDN) e gera o conjunto de ícones usado pelo painel. Rodar após atualizar as dependências:
//   npm run vendor
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = (p) => path.join(root, 'node_modules', p);

const ICONS = [
  'layout-dashboard', 'monitor', 'boxes', 'images', 'film', 'image', 'globe', 'list-video', 'calendar-clock',
  'chart-column', 'settings', 'siren', 'log-out', 'plus', 'search', 'upload', 'play', 'trash-2', 'pencil',
  'copy', 'ellipsis-vertical', 'grip-vertical', 'x', 'check', 'chevron-down', 'chevron-left', 'chevron-right',
  'refresh-cw', 'scan-eye', 'eraser', 'sun', 'moon', 'sun-moon', 'rotate-cw', 'volume-2', 'volume-x', 'power',
  'clock', 'wifi', 'wifi-off', 'circle-alert', 'info', 'eye', 'download', 'link', 'palette', 'key-round',
  'server', 'menu', 'list', 'layout-grid', 'hard-drive', 'triangle-alert', 'save', 'arrow-left', 'tv',
  'square-play', 'type', 'user-round', 'loader-circle', 'external-link', 'circle-check', 'circle-x'
];

function iconInner(name) {
  const file = path.join(nm('lucide-static'), 'icons', `${name}.svg`);
  if (!fs.existsSync(file)) throw new Error(`ícone inexistente no lucide-static: ${name}`);
  const svg = fs.readFileSync(file, 'utf8');
  return svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
    .replace(/\s*\n\s*/g, '').trim();
}

const lucideVersion = require(path.join(nm('lucide-static'), 'package.json')).version;
const entries = ICONS.map((n) => `  '${n}': '${iconInner(n).replace(/'/g, "\\'")}'`).join(',\n');
const out = `// Gerado por scripts/vendor.js — não editar à mão.
// Ícones: Lucide v${lucideVersion} (ISC) — https://lucide.dev
export const ICONS = {
${entries}
};
`;
fs.writeFileSync(path.join(root, 'public', 'panel', 'js', 'icons.js'), out);

const copies = [
  [nm('sortablejs/modular/sortable.esm.js'), 'public/panel/vendor/sortable.esm.js'],
  [nm('hls.js/dist/hls.min.js'), 'public/player/vendor/hls.min.js']
];
for (const [src, dest] of copies) {
  fs.mkdirSync(path.dirname(path.join(root, dest)), { recursive: true });
  fs.copyFileSync(src, path.join(root, dest));
}
console.log(`ícones: ${ICONS.length} | copiados: ${copies.map((c) => c[1]).join(', ')}`);
