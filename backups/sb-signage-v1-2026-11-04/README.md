# SB Signage

Plataforma de **digital signage** (mídia indoor): um painel web gerencia telas, mídias, playlists e agendas; players conectados exibem o conteúdo em quantas TVs você quiser, com sincronização em tempo real e **cache offline** — a tela nunca fica preta porque a internet caiu.

Implementa o núcleo descrito em `../PLANO-TECNICO.md`: pareamento por código (device flow), manifesto versionado com ETag, pull como fonte de verdade + push via WebSocket, mídia imutável com hash e transcodificação automática.

## Como rodar

```powershell
cd sb-signage
npm install
npm start
```

- **Painel**: `http://localhost:4000/` — senha padrão `admin`
- **Player**: `http://<IP-da-máquina>:4000/player` — abra na TV / TV Box / qualquer navegador

Configuração por variáveis de ambiente:

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `4000` | Porta do servidor |
| `ADMIN_PASSWORD` | `admin` | Senha do painel — **troque em produção** |
| `DATA_DIR` | `./data` | Onde ficam banco (JSON) e arquivos de mídia |
| `MAX_UPLOAD_MB` | `2048` | Tamanho máximo por arquivo |
| `MEDIA_BASE_URL` | *(vazio)* | Prefixo CDN para `/m` e `/hls` no manifesto (ex.: `https://cdn.seudominio.com`). CORS já liberado nas rotas de mídia |
| `HLS_MIN_MINUTES` | `10` | Vídeos acima disso ganham variante HLS (streaming imediato) |

## Fluxo de uso

1. Abra o player na TV → ele exibe um **código de 6 caracteres**.
2. No painel, **Telas → + Parear tela** → digite o código e um nome.
3. Em **Mídias**, arraste fotos e vídeos. Formatos não-web (MKV, AVI, WMV, MOV, FLV…) são **transcodificados automaticamente** para H.264/MP4 1080p via FFmpeg; imagens gigantes são reduzidas.
4. Em **Playlists**, monte a sequência (duração por imagem; vídeo toca até o fim).
5. No card da tela, escolha a playlist padrão — o player sincroniza em segundos.
6. (Opcional) Em **Agenda**, crie regras por dia da semana e horário (suporta janelas que cruzam a meia-noite). Regra ativa vence a playlist padrão.

Você pode conectar **quantas telas quiser simultaneamente** — cada uma tem credencial própria, revogável ao remover a tela no painel.

## Funcionalidades de operação

- **Grupos de telas** — telas herdam a playlist do grupo quando não têm playlist própria. Prioridade de resolução: agenda ativa > playlist da tela > playlist do grupo.
- **Configurações por tela** (⚙ no card): orientação (0/90/180/270°), volume/mudo, rodapé com **letreiro (ticker)** e **relógio**, e **agenda de energia** (a tela fica preta fora do horário — desligamento real via HDMI-CEC exige o player Android).
- **Página web como mídia** (🌐 em Mídias): dashboards, cardápios, feeds — entra na rotação como qualquer item (exige tela online; sites com X-Frame-Options podem bloquear).
- **Conteúdo de emergência** (🚨 na barra lateral): mensagem de texto ou mídia que **substitui imediatamente todas as telas**, inclusive as em janela de energia, até ser desativada.
- **Proof-of-play** (📊 Relatórios): cada exibição é registrada pelos players e agregada por dia (mídia × tela, contagem e tempo). Exportação CSV detalhada — útil para comprovar veiculação de anúncios. Logs em `data/logs/plays-AAAA-MM-DD.jsonl`, fora do banco.
- **HLS para vídeos longos** — vídeos acima de `HLS_MIN_MINUTES` (padrão 10 min) ganham variante HLS segmentada (sem re-encode): o player começa a exibir por streaming enquanto o MP4 completo baixa para o cache offline.

## Formatos aceitos

- **Imagens**: JPG, JPEG, PNG, GIF (animado), WEBP, AVIF, BMP, SVG
- **Vídeos**: MP4, M4V, WEBM, MOV, MKV, AVI, WMV, FLV, MPG, MPEG, 3GP, VOB, TS, MTS, M2TS, OGV, RM, RMVB

Vídeos já em MP4/WEBM com codec web (H.264/VP8/VP9/AV1 + AAC/MP3/Opus) passam direto, sem reprocessar. O resto é normalizado.

## Otimizações embutidas

- **URLs imutáveis com hash** + `Cache-Control: immutable, 1 ano` — o navegador/player nunca rebaixa a mesma mídia duas vezes.
- **ETag no manifesto** — o polling dos players custa um 304 vazio quando nada mudou.
- **Push via Socket.IO** — mudanças chegam em segundos; o polling (60s) é só rede de segurança.
- **Cache offline em IndexedDB** no player — funciona até em `http://` na LAN (Cache API/Service Worker exigiriam HTTPS). O player só exibe o que está 100% baixado e faz evicção do que saiu do manifesto.
- **Transcodificação assíncrona em fila** — a API nunca bloqueia; mídia só entra em manifesto quando `ready`.
- **Crossfade com duas camadas** + liberação de decoder/objectURL após cada transição.
- **Pré-carregamento do próximo item** — o player decodifica a próxima imagem (`img.decode()`, com timeout de segurança) e pré-bufferiza o próximo vídeo **antes** da transição; a troca nunca engasga.
- **Camadas com compositing em GPU** (`will-change`/`translateZ`) para crossfade suave.
- **H.264 High\@4.1** na transcodificação — perfil com decodificação por hardware em TVs e TV boxes.
- **Download sequencial** de mídia no player, para não competir com o vídeo em exibição.

## Telas fora da rede local (acesso remoto)

O player só precisa de **uma URL alcançável** — nada no código depende de LAN. Três caminhos, do mais recomendado ao mais simples:

1. **VPS/nuvem (recomendado para produção)** — rode o servidor num host com IP público (Oracle Cloud Free, Railway, Fly.io, VPS barata). Use o `Dockerfile` incluído:
   ```bash
   docker build -t sb-signage .
   docker run -d -p 4000:4000 -v sb-data:/data -e ADMIN_PASSWORD=suaSenha sb-signage
   ```
   As TVs apontam para `https://seu-dominio/player` de qualquer rede.
2. **Cloudflare Tunnel (grátis, servidor continua na sua máquina)** — `cloudflared tunnel --url http://localhost:4000` gera uma URL pública com HTTPS sem abrir porta no roteador. Com domínio próprio no Cloudflare, o túnel vira permanente (serviço do Windows).
3. **Tailscale/VPN** — junta as TVs e o servidor numa rede privada virtual. Bom para poucas telas próprias; exige instalar o Tailscale em cada dispositivo.

Com HTTPS (opções 1 e 2) o player ganha acesso a APIs melhores do navegador e o tráfego sai criptografado — **troque a `ADMIN_PASSWORD` antes de expor publicamente**. O servidor já está preparado (`trust proxy`, rate limit no login, pareamento com TTL).

## Exportar como .exe (sem Electron)

O servidor empacota como executável único com [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) — Node.js embutido, sem instalação na máquina de destino:

```powershell
npm install          # inclui a devDependency @yao-pkg/pkg
npm run build:exe    # gera dist/sb-signage.exe + ffmpeg.exe + ffprobe.exe
```

Distribua a pasta `dist/` inteira (o ffmpeg precisa ficar ao lado do .exe). Dados ficam em `dist/data/` (ou onde `DATA_DIR` apontar). O *player* não precisa de exe: qualquer navegador em modo kiosk cumpre o papel — Electron só valeria a pena para watchdog nativo em frota grande.

## Dicas para as TVs (modo kiosk)

- **Android TV / TV Box**: use o app *Fully Kiosk Browser* apontando para a URL do player (tem auto-start no boot e watchdog embutidos), ou o navegador em tela cheia.
- **Windows**: `chrome --kiosk --autoplay-policy=no-user-gesture-required http://SERVIDOR:4000/player`
- Vídeos com som: navegadores podem bloquear autoplay com áudio; o player tenta com som e cai para mudo se bloqueado. A flag acima (ou Fully Kiosk) libera o som.

## Estrutura

```
sb-signage/
├── server/
│   ├── index.js      # HTTP + Socket.IO + estáticos + watchdog de status
│   ├── api.js        # REST: auth, pareamento, mídia, playlists, agenda, manifesto
│   ├── transcode.js  # fila FFmpeg (transcodificação, resize, thumbnails, hash)
│   └── store.js      # persistência JSON atômica
├── public/
│   ├── panel/        # SPA do painel (vanilla JS, tema escuro + amarelo)
│   └── player/       # player web (pareamento, IndexedDB, loop, ticker/relógio, emergência)
├── scripts/          # copy-ffmpeg.js (usado pelo build:exe)
├── android-player/   # scaffold do player Android nativo (ExoPlayer) — ver README próprio
├── Dockerfile        # deploy em VPS/nuvem
└── data/             # criado em runtime: data.json + mídia + hls/ + logs/ (proof-of-play)
```

## Limites conhecidos (e caminho de evolução)

- Single-tenant e senha única de admin — multiusuário/organizações é a Fase 2/3 do plano.
- Persistência em JSON — suficiente para dezenas de telas e centenas de mídias; migre para PostgreSQL se a frota crescer.
- Player web em navegador — para frota grande, empacote como app Android (WebView + watchdog nativo), conforme §4.9/§4.10 do plano.
- Fila de transcode com concorrência 1 — aumente/externalize (BullMQ) se o volume de upload justificar.
