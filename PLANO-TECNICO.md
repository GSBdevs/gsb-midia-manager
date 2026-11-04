# Plataforma de Digital Signage — Plano Técnico de Arquitetura

> Documento de referência técnica. Reconstrução moderna de uma plataforma de mídia indoor/DOOH inspirada na **arquitetura** do "Adeus Pendrive" — sem reuso de marca, conteúdo ou identidade visual.
>
> **Status:** v1 — base para iniciar o MVP.
> **Codinome do projeto:** `ADEUSPENDRIVE-CLONE` (interno).
> **Última atualização:** 2026-06-24.

---

## 1. Visão geral do sistema

A plataforma elimina o pendrive físico substituindo-o por um **player conectado** que sincroniza conteúdo com um **CMS web** via nuvem. O fluxo central:

```
Instalar player → player exibe código de pareamento → usuário vincula a tela no
painel (digita o código) → upload de mídia → monta playlist → agenda exibição →
player sincroniza (pull + push em tempo real) → exibe com cache local (offline-first)
```

### Componentes de alto nível

| Componente | Papel | Tecnologia-alvo |
|---|---|---|
| **Player** | Roda na tela (TV Box/Android/Windows), exibe conteúdo, funciona offline | Android nativo (Kotlin) + Windows (Electron) |
| **CMS / Painel** | Onde o usuário gere telas, mídia, playlists e agendamentos | React/Next.js (SPA) |
| **Backend / API** | Regras de negócio, auth, orquestração de sync e jobs | NestJS (Node.js/TypeScript) |
| **Storage + CDN** | Armazena e entrega mídia transcodificada | S3-compatível (Cloudflare R2) + CDN |
| **Transcodificação** | Normaliza/otimiza mídia em background | Fila (BullMQ) + FFmpeg workers |
| **Realtime** | Notifica players sobre mudanças instantaneamente | WebSocket (Socket.IO) |
| **Watchdog** | Processo separado que monitora e reinicia o player | Serviço nativo / segundo app Android |

### Princípios de arquitetura

1. **Offline-first no player.** A tela nunca pode ficar preta porque a internet caiu. Tudo que vai ao ar passa antes pelo cache local.
2. **Pull como fonte de verdade, push como aceleração.** O player decide o que exibir a partir de um *manifesto* que ele baixa; o realtime apenas avisa "há novidade, busque agora". Se o WebSocket falhar, polling garante consistência.
3. **Mídia imutável e versionada.** Um arquivo, uma vez transcodificado, nunca muda — recebe uma URL com hash. Isso torna o cache trivial e invalida nada por engano.
4. **Device != User.** Players autenticam com credenciais de máquina (não-humanas, longa duração, revogáveis). Usuários autenticam com sessão. São dois mundos de auth distintos.

---

## 2. Plano de projeto faseado (MVP → escala)

Quatro fases. Cada uma é entregável e testável de ponta a ponta. Não avance sem fechar o "critério de pronto" da fase anterior.

### Fase 0 — Fundação (1–2 semanas)

Objetivo: esqueleto que compila, deploya e fala consigo mesmo. Nada de feature ainda.

- Monorepo configurado (ver §3) com CI básico (lint + build + test).
- Backend NestJS sobe, conecta no PostgreSQL, expõe `/health`.
- Schema inicial e migrations (devices, users, organizations).
- Bucket R2 provisionado; upload assinado funcionando num teste.
- Painel Next.js com login fake e uma tela em branco.
- Ambientes `dev` e `staging` deployáveis por push.

**Critério de pronto:** consigo logar no painel, e o backend persiste e lê do banco em staging.

### Fase 1 — MVP (núcleo "uma tela exibindo algo") (3–5 semanas)

Objetivo: o ciclo completo funcionando para **uma organização, uma tela, uma playlist de imagens/vídeos**, com pareamento real.

Backend / API:
- Auth de usuário (email+senha, JWT de sessão).
- CRUD de mídia com upload direto pro R2 (presigned URLs).
- CRUD de playlists (lista ordenada de mídias + duração por item).
- **Pareamento de dispositivos:** geração de código curto, endpoint de claim, emissão de credencial de device.
- Endpoint de **manifesto do player**: dado um device, retorna a playlist ativa + URLs de mídia + versão.

Player (começar pelo Android — maior cobertura de hardware barato):
- Tela de pareamento (mostra código, faz long-poll até ser vinculado).
- Download e **cache local** das mídias do manifesto.
- Loop de exibição (imagem por X segundos, vídeo até o fim) via WebView/Media3.
- Reexecução offline a partir do cache.

Painel:
- Upload de mídia (drag-and-drop) com preview.
- Construtor de playlist simples.
- Lista de telas + status (online/offline, última sincronização).

**Critério de pronto:** instalo o player num TV Box, pareio pelo painel, subo um vídeo, monto uma playlist, e o conteúdo aparece na TV em < 1 min — e continua tocando se eu desligar a internet.

### Fase 2 — Produto utilizável (4–6 semanas)

Objetivo: deixar de ser demo e virar algo que opera várias telas de verdade.

- **Agendamento:** playlists por janela de tempo / dia da semana (dayparting). O player passa a resolver "o que tocar agora" a partir de um calendário, não de uma playlist fixa.
- **Realtime (Socket.IO):** mudou playlist/agenda → players afetados recebem `sync` e atualizam em segundos (com fallback de polling).
- **Transcodificação assíncrona (BullMQ + FFmpeg):** todo upload entra numa fila, é normalizado (codec/resolução/bitrate alvo), gera thumbnail e variações. O player só recebe mídia "pronta".
- **Grupos de telas:** aplicar conteúdo a um conjunto de dispositivos de uma vez.
- **Watchdog:** processo separado que reinicia o player se travar/cair, e reporta heartbeat.
- **Player Windows (Electron):** reaproveita a camada web do player Android.
- **Multi-tenant real:** isolamento por organização em todas as queries (row-level).
- **Telemetria básica:** heartbeats, logs de reprodução, status de cache.

**Critério de pronto:** 10–20 telas reais, com agendamento por horário, sincronizando em tempo real, e mídia sempre transcodificada antes de ir ao ar.

### Fase 3 — Escala e robustez (contínuo)

Objetivo: aguentar centenas/milhares de telas e operar sem babá.

- **Proof-of-play / analytics:** registro confiável do que foi exibido, quando e por quanto tempo (requisito DOOH). Ingestão em batch, agregação, dashboards.
- **Entrega otimizada:** CDN na frente do R2, pré-cache agendado (player baixa o conteúdo de amanhã durante a madrugada), downloads incrementais (só o delta).
- **Resiliência de sync:** backoff, deduplicação, reconciliação de estado, detecção de device "fantasma".
- **Observabilidade:** métricas (Prometheus/Grafana), tracing, alertas de fleet (X% das telas offline).
- **Conteúdo avançado:** zonas/layouts (dividir a tela em regiões), widgets (clima, RSS, hora), conteúdo dinâmico.
- **Workers de transcode escaláveis:** autoscaling por profundidade de fila.
- **Gestão de frota:** atualização remota de app, rollout em fases, comandos remotos (reiniciar, screenshot, limpar cache).
- **Hardening:** rotação de credenciais de device, rate limiting, auditoria.

**Critério de pronto:** é um alvo móvel — esta fase nunca "fecha", evolui com a operação.

### Resumo das fases

| Fase | Foco | Entrega-chave | Duração estimada |
|---|---|---|---|
| 0 | Fundação | Esqueleto deployável | 1–2 sem |
| 1 | MVP | Ciclo pareamento→exibição offline | 3–5 sem |
| 2 | Produto | Agendamento + realtime + transcode + multi-tela | 4–6 sem |
| 3 | Escala | Analytics, frota, resiliência, observabilidade | Contínuo |

> Estimativas assumem 1–2 devs em ritmo focado. Ajuste conforme realidade.

---

## 3. Arquitetura de repositórios

### Recomendação: **Monorepo**

Para este projeto, monorepo vence claramente:

- **Tipos compartilhados.** O contrato do manifesto, DTOs de API e tipos de domínio são usados por backend, painel e camada web do player. Num monorepo, um pacote `shared` garante que um breaking change na API quebre o build do painel imediatamente — em vez de em produção.
- **Atomicidade.** Uma mudança no protocolo de sync toca API + player + painel num único PR/commit.
- **Tooling unificado.** Um lint, um test runner, uma config de CI.

A exceção legítima são os **apps nativos** (Android Kotlin). Eles têm toolchain próprio (Gradle) e ciclo de release diferente (lojas/APK). Opções:

- **(A) Monorepo único** com o Android dentro (`apps/player-android`), buildado por um job de CI separado. Mais simples de manter o contrato sincronizado.
- **(B) Monorepo TS + repo Android separado**, com os tipos compartilhados publicados como artefato/schema. Mais limpo, porém exige disciplina de versionamento do contrato.

**Recomendo (A)** até a Fase 2; migre para (B) só se o repo Android começar a atrapalhar o fluxo dos devs web.

Ferramenta de monorepo: **pnpm workspaces + Turborepo** (cache de build, simples). Nx é alternativa se quiser mais estrutura/geradores.

### Estrutura de pastas proposta

```
adeuspendrive-clone/
├── apps/
│   ├── api/                    # Backend NestJS
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── auth/           # login usuário + JWT
│   │   │   │   ├── devices/        # pareamento, credenciais, heartbeat
│   │   │   │   ├── media/          # upload, presigned URLs, metadata
│   │   │   │   ├── playlists/
│   │   │   │   ├── schedules/      # dayparting / calendário
│   │   │   │   ├── manifest/       # "o que tocar agora" pro player
│   │   │   │   ├── sync/           # gateway Socket.IO + lógica de push
│   │   │   │   └── organizations/  # multi-tenant
│   │   │   ├── jobs/               # produtores/consumidores BullMQ
│   │   │   ├── common/             # guards, interceptors, pipes
│   │   │   └── main.ts
│   │   ├── prisma/                 # schema + migrations
│   │   └── test/
│   │
│   ├── web/                    # Painel/CMS (Next.js)
│   │   ├── app/                    # rotas (App Router)
│   │   │   ├── (auth)/
│   │   │   ├── screens/            # gestão de telas
│   │   │   ├── media/
│   │   │   ├── playlists/
│   │   │   └── schedules/
│   │   ├── components/
│   │   ├── lib/                    # api client, hooks de realtime
│   │   └── public/
│   │
│   ├── player-web/             # Camada web do player (compartilhada Android WebView + Electron)
│   │   ├── src/
│   │   │   ├── engine/             # loop de exibição, resolver de agenda
│   │   │   ├── cache/              # gestão de cache local de mídia
│   │   │   ├── sync/               # cliente de manifesto + socket
│   │   │   ├── pairing/            # UI de pareamento
│   │   │   └── renderers/          # imagem, vídeo, layout/zonas
│   │   └── index.html
│   │
│   ├── player-android/        # Wrapper Kotlin (WebView + Media3 + watchdog)
│   │   ├── app/
│   │   │   └── src/main/
│   │   │       ├── java/.../player/
│   │   │       └── java/.../watchdog/
│   │   └── build.gradle.kts
│   │
│   └── player-windows/        # Wrapper Electron
│       ├── electron/              # main process, watchdog, auto-update
│       └── package.json
│
├── packages/
│   ├── shared/                 # tipos TS compartilhados (DTOs, manifesto, enums)
│   ├── api-client/             # client tipado da API (usado por web e player-web)
│   ├── config/                 # eslint, tsconfig, prettier compartilhados
│   └── ui/                     # design system / componentes (opcional)
│
├── infra/
│   ├── docker/                 # Dockerfiles (api, worker)
│   ├── compose/                # docker-compose dev (postgres, redis, minio)
│   ├── terraform/              # ou pulumi — R2, DB, hosting
│   └── ci/                     # workflows
│
├── docs/
│   ├── PLANO-TECNICO.md        # este documento
│   ├── api/                    # contratos, OpenAPI
│   └── protocols/              # protocolo de sync, formato do manifesto
│
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

**Notas de design:**

- `player-web` é o coração do player e é **compartilhado** entre Android (dentro de WebView) e Windows (dentro do Electron). Você escreve a engine de exibição uma vez. Os wrappers nativos só fornecem: tela cheia, persistência de cache em disco, watchdog e auto-update.
- `packages/shared` é o que justifica o monorepo. O tipo do manifesto vive aqui.
- `infra/compose` permite subir todo o backend local (Postgres + Redis + MinIO como R2 fake) com um comando.

---

## 4. Decisões técnicas a tomar ANTES de codar

Cada decisão abaixo com recomendação objetiva. Trave-as antes de escrever a primeira linha de feature — refazê-las depois é caro.

### 4.1 Linguagem/framework do backend
**Opções:** Node.js/NestJS vs Python/FastAPI.
**Recomendação: NestJS (Node/TypeScript).**
**Por quê:** TypeScript de ponta a ponta. Os mesmos tipos de domínio fluem do backend para o painel React e para a `player-web` — isso é o maior multiplicador de produtividade num sistema com contrato compartilhado (manifesto). NestJS dá estrutura opinativa (módulos, DI, guards) que envelhece bem. BullMQ (filas) é nativo do ecossistema Node. FastAPI só venceria se houvesse forte componente de ML/visão computacional — não é o caso aqui.

### 4.2 Banco de dados
**Opções:** PostgreSQL vs MySQL vs Mongo.
**Recomendação: PostgreSQL.**
**Por quê:** o domínio é fortemente relacional (org → telas → playlists → mídias → agendas). Você quer integridade referencial e queries de agendamento com JOINs. JSONB cobre os casos semi-estruturados (metadata de mídia, config de layout) sem precisar de um Mongo. Postgres também escala para analytics inicial e tem extensões (particionamento, TimescaleDB) se proof-of-play crescer.
**ORM:** Prisma (DX e migrations excelentes) ou Drizzle (mais leve/SQL-first). Recomendo **Prisma** para começar.

### 4.3 Provedor de storage de mídia
**Opções:** AWS S3 vs Cloudflare R2 vs Backblaze B2.
**Recomendação: Cloudflare R2.**
**Por quê:** **egress zero**. Digital signage é egress-pesado (players baixam vídeos repetidamente, em escala). No S3 o custo de saída te mata; no R2 a saída é gratuita e ele já integra com a CDN Cloudflare na frente. API compatível com S3, então o código não acopla — você pode trocar depois. Em dev, use **MinIO** (S3 local) para não depender de nuvem.

### 4.4 CDN e entrega
**Recomendação: Cloudflare (CDN + R2 juntos).**
**Por quê:** mantém um fornecedor só, cache de borda perto dos players, e Workers disponíveis se precisar de lógica na borda (ex: URLs assinadas). Mídia servida com URL versionada por hash → cache imutável, sem invalidação.

### 4.5 Mecanismo de pareamento de dispositivos
**Opções:** código curto digitado vs QR code vs OAuth device flow.
**Recomendação: código curto (6–8 caracteres) + claim no painel, modelado no OAuth 2.0 Device Authorization Grant.**
**Como funciona:**
1. Player no primeiro boot gera um par de chaves / device_id e chama `POST /devices/pairing-code`. Backend retorna um código curto + um `device_token` temporário.
2. Player exibe o código na tela e faz long-poll/socket aguardando vínculo.
3. Usuário logado no painel digita o código → `POST /devices/claim` vincula o device à organização.
4. Backend troca o token temporário por uma **credencial de device de longa duração** (revogável). Player passa a autenticar com ela.

**Por quê:** funciona em qualquer hardware (até TV sem câmera), é familiar ao usuário, e o modelo device-flow já resolve a separação device/user com segurança. Adicione QR code como atalho opcional (o QR só pré-preenche o código). **Não** reutilize JWT de usuário no device.

### 4.6 Autenticação (usuários × dispositivos)
**Recomendação: dois sistemas separados.**
- **Usuários do painel:** sessão via JWT de curta duração + refresh token, ou Auth.js/Clerk se quiser terceirizar. Comece simples (email+senha + JWT), adicione OAuth depois.
- **Dispositivos:** credencial de máquina de longa duração emitida no pareamento, **revogável** individualmente (kill switch por tela). Escopo restrito (só lê manifesto/mídia da própria org, reporta heartbeat).

### 4.7 Sincronização em tempo real
**Opções:** WebSocket (Socket.IO) vs MQTT vs polling puro.
**Recomendação: Socket.IO como push + polling como rede de segurança.**
**Por quê:** Socket.IO traz reconexão, rooms (um room por device/grupo) e fallback HTTP prontos — ideal para "avise os players X que há novo conteúdo". MQTT é tecnicamente superior para frotas enormes (milhares de devices, conexões leves), mas adiciona um broker e complexidade que não se paga no MVP. **Regra de ouro:** o realtime nunca é fonte de verdade — ele só dispara um *pull* do manifesto. Se o socket cair, o player faz polling do manifesto a cada N minutos e nada se perde. Reavalie MQTT na Fase 3 se passar de ~mil telas.

### 4.8 Transcodificação
**Recomendação: BullMQ (Redis) + workers FFmpeg em container.**
**Por quê:** mantém tudo no ecossistema Node, Redis você já terá (Socket.IO/cache), e separar os workers da API permite escalar transcode independentemente. Defina **perfis de saída fixos** (ex: 1080p H.264 + thumbnail) para previsibilidade. Mídia é processada uma vez, marcada como `ready`, e só então entra em manifestos.

### 4.9 Modelo do player: nativo vs web-em-wrapper
**Recomendação: engine web compartilhada (`player-web`) dentro de wrappers nativos finos.**
**Por quê:** evita reescrever a lógica de exibição/cache/sync três vezes (Android, Windows, futuro web). O wrapper nativo cuida só do que exige sistema operacional: fullscreen/kiosk, escrita de cache em disco, watchdog e auto-update. Vídeo no Android usa **Media3/ExoPlayer** nativo (a `<video>` da WebView é fraca em TV Boxes baratos) — a engine web orquestra, o nativo reproduz.

### 4.10 Estratégia do watchdog
**Recomendação: processo/serviço separado do player.**
**Por quê:** se o watchdog vive dentro do player, ele morre junto quando o player trava — inútil. No Android, um segundo componente (foreground service / app companheiro) monitora heartbeat e reinicia. No Windows, um serviço/processo Electron separado faz o mesmo. Reporta status ao backend para você ver "telas com problema" no painel.

### 4.11 Formato e versionamento do manifesto
**Recomendação: defina o schema do manifesto cedo, em `packages/shared`, versionado.**
**Por quê:** o manifesto é o contrato mais crítico do sistema — é o que o player consome para saber o que tocar. Deve conter: versão, lista resolvida de itens (mídia + duração + ordem), URLs versionadas por hash, janela de validade/agenda, e um `etag`/hash do manifesto inteiro para o player detectar mudança barata. Versione o formato (`v1`) desde o início para evoluir sem quebrar players antigos no campo.

### 4.12 Hosting / deploy
**Recomendação (MVP):** API e workers em containers num PaaS simples (Railway/Render/Fly.io) ou um VPS com Docker Compose; painel Next.js na Vercel ou Cloudflare Pages; Postgres gerenciado (Neon/Supabase/RDS); Redis gerenciado (Upstash). Suba a complexidade (Kubernetes) só quando a operação justificar — não antes.

### Tabela-resumo das decisões

| # | Decisão | Recomendação |
|---|---|---|
| 4.1 | Backend | NestJS (Node/TS) |
| 4.2 | Banco | PostgreSQL + Prisma |
| 4.3 | Storage | Cloudflare R2 (MinIO em dev) |
| 4.4 | CDN | Cloudflare |
| 4.5 | Pareamento | Código curto estilo device-flow |
| 4.6 | Auth | Separado: sessão (user) × credencial (device) |
| 4.7 | Realtime | Socket.IO + polling de fallback |
| 4.8 | Transcode | BullMQ + FFmpeg em workers |
| 4.9 | Player | Engine web compartilhada + wrappers nativos |
| 4.10 | Watchdog | Processo separado |
| 4.11 | Manifesto | Schema versionado em `shared` |
| 4.12 | Hosting | PaaS + serviços gerenciados no MVP |

---

## 5. Modelo de dados inicial (esboço)

Entidades núcleo para a Fase 1, a refinar:

- **Organization** — tenant. Tudo pendura aqui.
- **User** — pertence a uma org; tem papel (owner/editor/viewer).
- **Device** — uma tela. `id`, `org_id`, `name`, `status`, `last_seen_at`, `credential`, `current_manifest_version`.
- **Media** — `id`, `org_id`, `type`, `original_url`, `processed_url`, `hash`, `status` (uploading/processing/ready/failed), `metadata` (JSONB).
- **Playlist** — `id`, `org_id`, `name`. Tem muitos **PlaylistItem** (`media_id`, `order`, `duration`).
- **Schedule** — vincula playlist a device/grupo com janela temporal (dayparting). Fase 2.
- **DeviceGroup** — agrupamento de telas. Fase 2.
- **PlaybackLog** — proof-of-play. Fase 3.

Regra transversal: **toda query filtra por `org_id`** (multi-tenant por row-level desde o início, mesmo que só haja uma org no MVP).

---

## 6. Riscos técnicos e armadilhas conhecidas

- **WebView de TV Box barato é traiçoeira.** Versões antigas de Android System WebView, codecs faltando, performance ruim de `<video>`. Mitigue com Media3 nativo para vídeo e teste no hardware-alvo real cedo.
- **Tela preta = falha crítica de produto.** Toda a arquitetura offline-first existe por isso. Nunca exiba conteúdo que não esteja 100% no cache local.
- **Gestão de cache.** Disco de TV Box é pequeno. Precisa de política de evicção (LRU), pré-cache do conteúdo agendado, e limpeza de mídia órfã.
- **Relógio do device.** Agendamento depende de hora correta; TV Boxes perdem hora. Sincronize via NTP e/ou ofereça hora do servidor no manifesto.
- **Deriva de estado (state drift).** Player pode achar que está numa versão e o servidor noutra. Reconcilie sempre pelo hash do manifesto, não por suposição.
- **Atualização de app no campo.** Atualizar player em centenas de telas sem acesso físico é difícil — planeje auto-update e rollout em fases desde a Fase 2.

---

## 7. Como usar este documento com o Claude Code

Ao iniciar a implementação do MVP, este arquivo serve como contexto-mestre. Sugestão de sequência de prompts:

1. "Inicialize o monorepo conforme a §3 (pnpm + Turborepo), com `apps/api`, `apps/web`, `packages/shared`, `infra/compose`."
2. "Implemente o módulo `devices` da API com o fluxo de pareamento da §4.5."
3. "Defina o schema do manifesto (§4.11) em `packages/shared` e o endpoint `manifest` da API."
4. "Crie a engine de exibição em `player-web` (loop + cache local) consumindo o manifesto."
5. Itere por feature seguindo os critérios de pronto da Fase 1 (§2).

Mantenha as decisões da §4 travadas. Se alguma mudar, atualize a tabela em §4 e a data no topo — este documento é a fonte de verdade da arquitetura.
