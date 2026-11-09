# SB Signage

Plataforma de **digital signage** (mídia indoor): um painel web gerencia telas, mídias, playlists e agendas; players conectados exibem o conteúdo em quantas TVs você quiser, com sincronização em tempo real e **cache offline** — a tela nunca fica preta porque a internet caiu.

Implementa o núcleo de `../PLANO-TECNICO.md`: pareamento por código (device flow), manifesto versionado com ETag, pull como fonte de verdade + push via WebSocket, mídia imutável com hash e transcodificação automática para um perfil fixo de saída.

## Como rodar

```powershell
cd sb-signage
npm install
npm start
```

- **Painel**: `http://localhost:4000/` — senha inicial `admin` (troque em **Configurações → Senha**)
- **Player**: `http://<IP-da-máquina>:4000/player` em qualquer navegador, ou um app instalado, que dispensa navegador (em fase de testes): [Windows](windows-player/README.md) e [Android](android-player/README.md). Os instaladores ficam em `http://<IP>:4000/downloads/`.

**Primeiro teste com dois computadores:** [TESTE-RAPIDO.md](TESTE-RAPIDO.md).
- **Testes**: `npm test` (43 testes, ~10 s; usam o ffmpeg real)
- **Guia de testes manuais**: [`TESTES.md`](TESTES.md)

## Configuração (variáveis de ambiente)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `4000` | Porta do servidor |
| `ADMIN_PASSWORD` | `admin` | Senha inicial. Depois de trocada no painel, a do painel vale |
| `DATA_DIR` | `./data` (ou ao lado do `.exe`) | Banco JSON, mídia, logs |
| `SIGNAGE_TZ` | `America/Sao_Paulo` | Fuso da agenda, da energia e dos relatórios — **independe do fuso do servidor** |
| `TRUST_PROXY` | desligado | Nº de proxies na frente (ex.: `1` para Cloudflare Tunnel/nginx). Desligado = IP do socket, não forjável |
| `MAX_UPLOAD_MB` | `2048` | Tamanho máximo por arquivo |
| `MEDIA_BASE_URL` | vazio | Prefixo de CDN para `/m` e `/hls` no manifesto |
| `HLS_MIN_MINUTES` | `10` | Vídeos acima disso ganham variante HLS (streaming imediato) |
| `SESSION_IDLE_DAYS` / `SESSION_MAX_DAYS` | `7` / `30` | Sessão do painel expira sem uso / no máximo |

## O que o sistema faz

**Painel** — Visão geral (telas online, armazenamento, exibições do dia, o que pede atenção, o que está no ar agora); Telas (busca, filtros, miniatura do que está passando, armazenamento da TV, configurações e comandos remotos); Grupos (playlist por grupo, membros); Mídias (envio com progresso, grade/lista, busca, filtros, pré-visualização, uso em playlists); Playlists (arrastar-e-soltar, duração total, pré-visualização da sequência, aviso de alterações não salvas, duplicar); Agenda (linha do tempo semanal, regras que cruzam a meia-noite); Relatórios (proof-of-play por período/tela, gráfico por dia, CSV); Configurações (marca: nome, logo, cor, tema claro/escuro, densidade; senha; sistema). Emergência global em um clique.

**Player** — pareamento por código; cache offline em IndexedDB com evicção antes do download; download com progresso e retomada automática; pré-carregamento do próximo item; crossfade; HLS para vídeos longos; detecção de vídeo travado; rodapé com letreiro e relógio; orientação; volume; agenda de energia; emergência; marca do cliente no pareamento; relógio e fuso vindos do servidor (TV box costuma ter hora errada); registro de exibição que sobrevive a recargas.

**Processamento de mídia** — perfil fixo de saída: H.264 8-bit em MP4, até 1920×1080 ou **1080×1920 em retrato**, respeitando a rotação gravada pelo celular. Vídeo já adequado passa direto. Fotos são endireitadas pela orientação EXIF e reduzidas ao tamanho da tela.

## Segurança

- Senha comparada em tempo constante; troca de senha pelo painel (hash scrypt) encerra as outras sessões.
- Sessões expiram e o logout revoga no servidor; credenciais de sessão e de tela ficam no disco **só como hash**.
- Rate limit de login e de geração de códigos por IP; `TRUST_PROXY` controla quando confiar em `X-Forwarded-For`.
- CSP no painel e no player; mídia servida em *sandbox* (um SVG com script não executa se aberto direto).
- `data.json` com backup automático; arquivo corrompido vai para quarentena em vez de ser sobrescrito.

## Exportar como .exe (sem Electron)

```powershell
npm install
npm run build:exe    # gera dist/sb-signage.exe + ffmpeg.exe + ffprobe.exe + licenças
```

Distribua a pasta `dist/` inteira. O FFmpeg é **GPL-3.0** — veja [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) antes de vender ou instalar em cliente.

## Telas fora da rede local

O player só precisa de uma URL alcançável:

1. **VPS/nuvem** com o `Dockerfile` incluído:
   ```bash
   docker build -t sb-signage .
   docker run -d -p 4000:4000 -v sb-data:/data -e ADMIN_PASSWORD=suaSenha sb-signage
   ```
   A imagem já vem com `TRUST_PROXY=1` (PaaS sempre tem proxy na frente). Exposto direto, sem proxy, use `-e TRUST_PROXY=0`.
2. **Cloudflare Tunnel** (`cloudflared tunnel --url http://localhost:4000`) — HTTPS sem abrir porta; rode com `TRUST_PROXY=1`.
3. **Tailscale/VPN** — rede privada entre TVs e servidor.

Com HTTPS o player também ganha armazenamento persistente e mantém a tela acordada (Wake Lock).

## Estrutura

```
sb-signage/
├── server/
│   ├── index.js            # ponto de entrada
│   ├── app.js              # monta HTTP + Socket.IO + rotas (createServer, testável)
│   ├── config.js           # variáveis de ambiente
│   ├── store.js            # JSON atômico + backup + migração de esquema
│   ├── auth.js             # sessões, senha, credenciais de tela
│   ├── realtime.js         # Socket.IO (painel e players)
│   ├── time.js / util.js   # fuso horário, utilitários
│   ├── domain/manifest.js  # "o que cada tela exibe agora" (funções puras)
│   ├── media/              # ffmpeg (spawn com tempo limite) e fila de transcode
│   └── routes/             # session, devices, content, player, reports, settings
├── public/
│   ├── panel/              # painel: módulos ES nativos, sem build (js/views/*)
│   └── player/             # player web
├── test/                   # node:test — domínio, store, API e mídia real
├── scripts/                # vendor.js (ícones/libs), copy-ffmpeg.js (build)
├── android-player/         # app Android nativo: validado em emulador, falta aparelho real
├── windows-player/         # app Windows (Electron) com o player web embutido
├── downloads/              # instaladores oferecidos em /downloads (gerado)
└── data/                   # criado em runtime
```

## Limites conhecidos

- Um administrador por instalação (sem usuários/papéis/clientes) — ver o plano de escala em `docs/ESCALA-MULTIUSUARIO.md`.
- Os apps instalados (Windows e Android) estão em fase de testes — ver `docs/PLAYER-NATIVO.md`.
- Persistência em JSON — suficiente para dezenas de telas e centenas de mídias.
- Fila de transcode com concorrência 1, no mesmo processo do servidor.
