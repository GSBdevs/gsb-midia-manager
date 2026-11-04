# Investigação Técnica: adeuspendrive.com / meu.adeuspendrive.com

## TL;DR
- O **"Adeus Pendrive"** é uma plataforma SaaS de **digital signage (mídia indoor / DOOH)** da Vanguarda Visionaria LTDA (Sete Lagoas-MG): um app *player* roda na TV/TV Box/Windows e busca conteúdo de um painel web (meu.adeuspendrive.com), substituindo o pendrive físico por sincronização remota via internet — com cache local que mantém a exibição funcionando offline.
- A stack tecnicamente **confirmada** inclui **Cloudinary** como CDN/transformação de imagens, **Let's Encrypt** para SSL, **Google Analytics + FullStory** no painel, app **Android nativo** (`vv.adeuspendrive.app`), player **Windows (.exe)** e um app **"watchdog"** separado; o site institucional tem padrões consistentes com WordPress e o painel é uma SPA protegida por login.
- Para clonar a funcionalidade central você precisa de 4 blocos: **app player multiplataforma** (com auto-start + cache offline), **painel web/CMS**, **object storage + CDN com transcodificação**, e uma camada de **sincronização em tempo real (WebSocket/MQTT)** com pareamento de telas por código.

## Key Findings
1. **Categoria**: Digital signage / mídia indoor e outdoor digital (DOOH). Gerencia TVs corporativas, totens, videowall, outdoor digital, mídia bus e cinemas.
2. **Mecânica central (o "pulo do gato")**: instalar o app → o app exibe um **código de pareamento** → o usuário vincula a tela no painel (página "TVs") digitando o código → envia arquivos → cria playlist → agenda → o player sincroniza e exibe. Funciona offline reproduzindo a última sincronização.
3. **Fingerprints confirmados**: **Cloudinary** com dois *cloud names* (`adeuspendrive` e `vanguardavisionaria`) e transformações on-the-fly; **Google Analytics** e **FullStory** (declarados na política de privacidade); **Let's Encrypt** (SSL).
4. **Localização dos servidores**: a própria política de privacidade afirma que os servidores ficam **"no Brasil e nos Estados Unidos"** e que todas as transferências são **criptografadas por SSL**.
5. **Apps**: Android (Google Play, Amazon Appstore, APK direto via `download.adeuspendrive.com`), Windows (.exe) e Smart TVs com Android TV/Google TV/Fire TV. Conforme a página oficial de Download: *"TVs das marcas LG, Panasonic, Samsung ou aparelhos ROKU não são compatíveis, pois utilizam sistemas próprios"* — compatível preferencialmente com AIWA, Philips, Sony BRAVIA, Sharp AQUOS, Toshiba Fire TV e Semp/TCL Android TV.

## Details

### 1. O que é e o que faz tecnicamente
**Operador**: Vanguarda Visionaria LTDA — CNPJ 16.838.300/0001-84, fundada em 12/09/2012, capital social R$10.000, CNAE principal 7312-2/00 ("Agenciamento de espaços para publicidade"), Rua Professor Abeylard 279, Sala 13, Centro, Sete Lagoas-MG, 35700-069. Contato oficial: `falecom@vanguardavisionaria.com.br` e +55 31 3026-2100 (perfil do desenvolvedor na Google Play / Receita Federal).

O nome resume a proposta: eliminar o pendrive físico que técnicos usavam para atualizar TVs em estabelecimentos. O conteúdo passa a ser gerenciado remotamente pelo navegador e distribuído aos dispositivos via internet. É um modelo clássico **CMS (servidor) + player (cliente)**:

- **Player (app)**: instalado em TV Box Android, Smart TV Android/Google TV, Amazon Fire TV ou Windows. Na primeira execução mostra um **código de ativação**; inicia automaticamente junto com o aparelho; faz **cache local** de mídia — "mesmo sem internet, continuará funcionando".
- **Painel web (meu.adeuspendrive.com)**: onde se vinculam TVs (por código), envia-se arquivos, cria-se playlists/sub-playlists, agenda-se exibições, gerencia-se múltiplas empresas/usuários e monitora-se status em tempo real.
- **Watchdog**: app Android separado (`vv.adeuspendrive.watchdog`, 100+ instalações), descrito como: *"This Monitor Application does not display content or image, only auto Monitors the Adeus Pendrive Application to check if it is working correctly. The install is optional."* — ou seja, um vigia que reinicia o player se ele travar. Detalhe não-óbvio e inteligente para confiabilidade em campo.

### 2. Funcionalidade e formatos suportados
- **Imagens**: JPG, JPEG, GIF, PNG, GIF animado. **Vídeos**: MP4, FLV, 3GP, AVI, M4V, MKV, MOV, MPG, RM, RMVB, VOB, WEBM, WMV. Suporta HD/FullHD/4k e até **8k/60fps**. A promessa "seu arquivo será exibido" independentemente do formato indica **transcodificação no servidor** (normalização para um formato/resolução que o device toque).
- **Entretenimentos (widgets dinâmicos)**: notícias (parceiros + RSS/XML customizado), futebol (Brasileirão), clima, horóscopo, cotações de câmbio/cripto/metais, painel de voos, loteria, top músicas, frases, "hoje na história", versículos, Waze (tráfego), YouTube/Vimeo (inclusive ao vivo), websites/links, Power BI, GIPHY, AllRecipes/Tastemade, adMooH (mídia programática) e criação direta com **Canva** e **Adobe Express** integrados ao painel.
- **Gestão**: agendamento (por período/dia/hora/dia da semana/mês), sub-playlists, relatório de exibição em tempo real, notificações por e-mail quando uma TV cai e quando volta, multiusuário com permissões granulares (Corporativo) e **white label** (app + painel + domínio próprio do cliente, ex.: `painel.suaempresa.com`).
- **Limites por plano**: Gratuito 125MB / 1 TV; **Premium 10GB** (não 15GB — conforme Termos de Serviço: *"Para os planos Premium e Corporativo há os limites iniciais de 10gb e 50gb respectivamente que poderão ser aumentados caso seja solicitados"*); Corporativo 50GB.

### 3. Stack e fingerprints
- **CDN / mídia**: **Cloudinary**, confirmado pelos caminhos `res.cloudinary.com/adeuspendrive/...` e `res.cloudinary.com/vanguardavisionaria/...`, com transformações on-the-fly (`w_`, `h_`, `c_fit`, `c_fill`, `dpr_auto`). Indica uso de serviço gerenciado de mídia para o material institucional/marketing.
- **SSL**: **Let's Encrypt** (selo HTTPS gratuito/automatizado, padrão da indústria).
- **Analytics**: **Google Analytics** e **FullStory** — declarados textualmente na política de privacidade como usados para entender o uso do painel de controle (FullStory = *session replay*).
- **Site institucional (adeuspendrive.com)**: padrões **consistentes com WordPress** (bloco rico de meta tags de plugin de SEO; estrutura de upload por data `/arquivos/2019/03/...`, sendo "arquivos" o equivalente PT do `/uploads/` do WP). **Não confirmado diretamente** (não se observou `wp-content`/`generator` no HTML extraído) — tratar como inferência forte.
- **Painel (meu.adeuspendrive.com)**: **SPA** protegida por login, com *tracking* de origem via query params (`source_id`, `source_url`, `source_type`). O framework exato (React/Vue/Angular) **não pôde ser confirmado** porque o subdomínio bloqueia acesso automatizado.
- **Servidores**: Brasil e EUA (declarado). **Suporte**: Freshdesk (`vanguardavisionaria.freshdesk.com`).
- **Versão/alcance do app**: atualizado em **25/10/2025**; APK mais recente listado em 3.12.73–3.12.78; análise da apkgk.com: *"Atualizada Em 25/10/2025... Alcançados Sobre Instalações 35 Mil... 89 Críticas, Classificação Média De 4.0 Estrelas."*

### 4. APIs, autenticação e entrega de arquivos (inferido do comportamento)
> Os itens abaixo são **inferências** a partir do comportamento observável e de como sistemas de digital signage tipicamente funcionam — não foram verificados em código/headers.
- **Pareamento por código**: sugere um endpoint de ativação que troca o código exibido na tela por credenciais/token persistente do dispositivo (padrão: JWT/token de device de longa duração).
- **API do painel**: a SPA provavelmente consome uma API REST/JSON autenticada por sessão+cookie ou JWT.
- **Sincronização/monitoramento em tempo real**: o status "em tempo real" das TVs e a sincronização "a todo segundo" apontam para **WebSocket** (ou MQTT, ou polling com heartbeat) entre player e servidor.
- **Arquivos do usuário**: armazenamento em **object storage** com entrega via CDN, possivelmente com **URLs assinadas**; a mídia institucional usa Cloudinary, mas os arquivos enviados por clientes provavelmente residem em storage próprio/objeto (a política diz que exclusão é "imediata e irreversível").

## Recommendations

### Roadmap de clonagem — stack moderno equivalente
1. **Player (cliente) — comece por aqui, é o coração do produto**
   - **Android** (Kotlin) usando WebView para layouts/widgets + ExoPlayer/Media3 para vídeo; empacotar para Android TV/Fire TV/TV Box.
   - **Windows**: Electron (reaproveita o mesmo front de renderização) ou app nativo.
   - Recursos essenciais a replicar: **auto-start no boot**, **cache local** de mídia para playback offline, **watchdog separado**, exibição de **código de pareamento**, e *graceful fallback* para a última sincronização quando offline.
2. **Painel web (CMS)**: SPA em **React/Next.js** (ou Vue) + backend **Node.js/NestJS** ou **Python/FastAPI**. Funções: upload, playlists/sub-playlists, agendamento, vínculo de telas por código, relatórios de exibição, multiempresa/permissões e white label (tema + domínio por cliente).
3. **Storage e entrega**: object storage (**S3 / Cloudflare R2 / Backblaze B2**) + CDN. Use **Cloudinary** (ou Mux/Coconut para vídeo) para transformação/transcodificação — esse é o componente que entrega o "qualquer formato funciona".
4. **Sincronização e telemetria**: **WebSocket (Socket.IO)** ou **MQTT** para comandos em tempo real, heartbeat de status e alertas de queda; **fila de jobs** (BullMQ/Celery) acionando **FFmpeg** para transcodificação assíncrona.
5. **Auth**: **JWT** para devices (token longo emitido no pareamento) + sessão/OAuth para usuários do painel. **Supabase/Firebase Auth** acelera o bootstrap.
6. **Widgets/entretenimentos**: microserviços que agregam feeds externos (RSS, clima, notícias, câmbio, esportes) e os entregam como HTML/JSON renderizável no player — isolando dependências de terceiros do core.

### Sequência sugerida (MVP → escala)
- **Fase 1 (MVP)**: player Android + painel com upload/playlist + pareamento por código + storage S3 + sync por polling. Prova o loop completo.
- **Fase 2**: WebSocket/MQTT para tempo real, transcodificação por fila, agendamento e relatórios.
- **Fase 3**: multiempresa, permissões, white label, widgets dinâmicos, versão Windows/Electron e watchdog.

### Benchmarks que mudam as decisões
- **> alguns milhares de telas**: migre de WebSocket puro para **MQTT** (mais leve para frota grande) e use storage/CDN de borda (R2/CloudFront).
- **Transcodificação virando gargalo**: pipeline 100% assíncrono com FFmpeg + fila e **pré-geração de renditions por classe de device** no momento do upload.
- **Custo de banda alto**: empurre o máximo de cache para o player e use *immutable cache* + CDN na entrega de mídia.

## Caveats
- **Hosting/infra não confirmados**: provedor cloud, IP/ASN, nameservers, headers HTTP (`Server`, `X-Powered-By`), nomes de cookies e emissor exato do certificado via crt.sh **não puderam ser verificados** — BuiltWith/crt.sh/urlscan bloquearam acesso automatizado e o site bloqueia *fetch*. O único CDN confirmado é o Cloudinary (mídia); Let's Encrypt e a localização Brasil/EUA vêm de fontes declaradas (verificação externa, política de privacidade).
- **WordPress (site) e framework do painel são inferências**, não confirmações.
- **Camada de API, mecanismo de auth e URLs assinadas são inferidos** do comportamento observável; não há acesso ao código.
- **Banco de dados**: nenhum dado público identifica a tecnologia usada.
- Para fechar as lacunas de infra, rode localmente: `curl -I https://adeuspendrive.com` e `https://meu.adeuspendrive.com` (headers); `https://crt.sh/?q=adeuspendrive.com&output=json` (certificados/subdomínios); `dig`/DoH para A e NS; BuiltWith/Wappalyzer no navegador; e inspecione o bundle JS do painel (DevTools → Network) para identificar o framework e os endpoints reais da API.