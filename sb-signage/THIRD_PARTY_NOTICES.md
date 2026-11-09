# Componentes de terceiros

O SB Signage usa os componentes abaixo. Cada um mantém sua própria licença.

## Distribuídos junto com o executável (`dist/`)

| Componente | Versão | Licença | Observação |
|---|---|---|---|
| FFmpeg (`ffmpeg.exe`) | 6.1.1 — build "essentials" de www.gyan.dev | **GPL-3.0** | Programa independente, executado como processo separado. Fonte: https://github.com/FFmpeg/FFmpeg/commit/e38092ef93 |
| FFprobe (`ffprobe.exe`) | 4.0.2 | **GPL-3.0** | Programa independente, executado como processo separado. Fonte: https://ffmpeg.org/releases/ffmpeg-4.0.2.tar.xz |
| Node.js (embutido no `.exe` pelo pkg) | 22.x | MIT e licenças de suas dependências | https://github.com/nodejs/node/blob/main/LICENSE |

**Sobre a GPL do FFmpeg/FFprobe:** o SB Signage chama esses binários como processos
separados (não os incorpora ao próprio código), por isso o código do SB Signage não é
afetado pela GPL. Ao **distribuir** a pasta `dist/` (venda, instalação em cliente), é
preciso: (1) entregar junto o texto da GPL-3.0 (`FFMPEG-LICENSE.txt`, copiado pelo build);
(2) oferecer o código-fonte correspondente — os links acima, ou uma cópia do fonte sob
pedido por no mínimo 3 anos; (3) não impor restrições adicionais ao uso desses binários.
Os codecs H.264 (libx264) e H.265 (libx265) incluídos também estão sujeitos a patentes
administradas por pools (Via LA / Access Advance) em alguns países — avalie antes de
distribuir em escala comercial. Alternativa sem essas obrigações: transcodificar só no
servidor (instalação SaaS, sem entregar binários) ou usar um build LGPL com codificador
de hardware.

## Bibliotecas de servidor (npm)

| Pacote | Licença |
|---|---|
| express | MIT |
| socket.io | MIT |
| multer | MIT |
| ffmpeg-static (instalador do binário) | GPL-3.0-or-later |
| ffprobe-static (instalador do binário) | MIT |

## App Windows (`windows-player/`)

| Pacote | Licença |
|---|---|
| Electron (inclui Chromium e Node.js) | MIT; o Chromium traz licenças próprias, listadas em `LICENSES.chromium.html` dentro da instalação |
| Player web e Socket.IO client (os mesmos do navegador) | ver abaixo |

## App Android (`android-player/`)

| Pacote | Licença |
|---|---|
| AndroidX (core, appcompat) e Media3 (ExoPlayer) | Apache-2.0 |
| OkHttp | Apache-2.0 |
| kotlinx.coroutines e Kotlin | Apache-2.0 |
| Socket.IO client Java | MIT |

## Bibliotecas de navegador (copiadas para `public/` por `npm run vendor`)

| Pacote | Licença | Onde |
|---|---|---|
| Socket.IO client | MIT | servido pelo próprio socket.io |
| hls.js 1.5.20 | Apache-2.0 | `public/player/vendor/hls.min.js` |
| SortableJS 1.15 | MIT | `public/panel/vendor/sortable.esm.js` |
| Lucide (ícones) | ISC | `public/panel/js/icons.js` |
