# Guia de testes — SB Signage 2.0

Roteiro completo, recurso por recurso. Para o primeiro teste com um notebook servindo de tela,
comece por [TESTE-RAPIDO.md](TESTE-RAPIDO.md) (~15 minutos).

## 0. Testes automatizados (2 minutos)

```powershell
cd C:\Users\GRUPOSB\Documents\CODES\propaganda-software\sb-signage
npm install
npm test
```

**Esperado:** `ℹ pass 43` e `ℹ fail 0`. Cobrem autenticação, sessões, pareamento, manifesto,
agenda (inclusive madrugada e fuso), uploads, segurança e processamento real de vídeo/foto.

## 1. Subir o servidor

```powershell
npm start
```

**Esperado:** o terminal mostra o endereço do painel, o do player (com o IP da rede) e o fuso.

> Para testar com a **TV de verdade**, use o endereço `Player : http://192.168.x.x:4000/player`
> do terminal. Para testar só no PC, abra o player numa **janela anônima** (sessão separada).

## 2. Painel e senha

| Passo | Esperado |
|---|---|
| Abrir `http://localhost:4000` e entrar com `admin` | Abre a **Visão geral**; aparece o aviso amarelo de senha padrão |
| **Configurações → Senha**: atual `admin`, nova com 8+ caracteres | "Senha alterada"; o aviso amarelo some |
| Sair e entrar com a senha antiga | Recusado ("senha incorreta") |
| Errar a senha 10 vezes seguidas | A 11ª tentativa responde "muitas tentativas" (bloqueio de 15 min por IP) |

## 3. Parear uma tela

| Passo | Esperado |
|---|---|
| Abrir o player (TV ou janela anônima) | Código de 6 caracteres em destaque |
| Painel → **Telas → Parear tela**, digitar o código e um nome | "Tela vinculada"; o card aparece **online** |
| No card, botão do olho (Identificar) | O nome da tela aparece na TV por 8 s |

## 4. Mídia

| Passo | Esperado |
|---|---|
| **Mídias**: arrastar 2–3 arquivos (um vídeo, uma foto de celular, um nome com acento) | Barra de progresso; cards com "processando" e depois prontos, com miniatura e duração em m:ss |
| Enviar um arquivo não suportado (ex.: `.xlsx`) | Aviso "Formato não suportado: …"; nada é salvo |
| Enviar um **vídeo vertical** (celular) | Fica em retrato (ex.: 1080×1920) — não vira paisagem com barras |
| Foto de celular tirada "em pé" | Aparece em pé, não deitada |
| Clicar numa miniatura (ícone de olho/play) | Pré-visualização abre; informa se o arquivo foi convertido e por quê |
| Alternar **grade/lista** e usar busca/filtros | A lista responde na hora; a escolha de grade/lista é lembrada |

## 5. Playlist

| Passo | Esperado |
|---|---|
| **Playlists → Nova playlist** → **Adicionar mídia** (buscar, marcar várias) | Itens entram na ordem; "ciclo de m:ss" mostra a duração total |
| **Arrastar pela alça** (⋮⋮) para reordenar | Ordem muda; aparece "não salvo" e o botão Salvar acende |
| Tentar ir para outra tela sem salvar | Pergunta "Alterações não salvas — descartar?"; Cancelar mantém você na playlist |
| **Ctrl+S** (ou Salvar) | "Playlist salva" |
| **Pré-visualizar** | Toca a sequência como na TV (imagens pela duração, vídeos até o fim) |

## 6. Colocar no ar

| Passo | Esperado |
|---|---|
| **Telas**: escolher a playlist no card | Em segundos a TV começa a exibir; o card mostra "Exibindo …" com miniatura |
| Durante o download, olhar a TV | Nenhum aviso técnico por cima do conteúdo (só aparece na tela de espera) |
| ⚙ **Configurar**: volume 30%, letreiro com um texto, relógio ligado | A TV aplica **sem recomeçar a playlist**; rodapé com letreiro rolando e relógio |
| ⚙ Orientação 90° | Conteúdo gira para tela em retrato |

## 7. Grupos e agenda

| Passo | Esperado |
|---|---|
| **Grupos → Novo grupo** → marcar a tela; escolher playlist do grupo | Tela sem playlist própria passa a exibir a do grupo |
| **Agenda → Nova regra**: sexta 22:00 → 02:00 | A linha do tempo mostra o bloco na sexta à noite **e** na madrugada de sábado; tabela marca "+1 dia" |
| Regra no horário atual com outra playlist | A TV troca para a playlist da regra em até 1 minuto |
| ⚙ Agenda de energia com horário que já passou | A TV fica preta; volta sozinha no horário de ligar |

## 8. Emergência

| Passo | Esperado |
|---|---|
| Barra lateral → **Emergência** → mensagem → Ativar | Faixa vermelha no painel; **todas** as TVs mostram a mensagem em tela cheia (mesmo as "desligadas" pela agenda) |
| **Desativar** na faixa | TVs voltam à programação |

## 9. Queda de internet (o teste mais importante)

| Passo | Esperado |
|---|---|
| Com a TV exibindo, **pare o servidor** (Ctrl+C) | A TV **continua exibindo** do cache; o painel avisa "conexão em tempo real perdida" |
| Suba o servidor de novo | Em até 1 minuto a TV volta a sincronizar; o painel se atualiza sozinho |
| Card da tela → menu → **Limpar cache e baixar de novo** | A TV recarrega, baixa tudo e volta a exibir |

## 10. Marca e relatórios

| Passo | Esperado |
|---|---|
| **Configurações → Aparência**: nome, cor, logo, tema claro | A prévia "Como aparece na TV" muda ao vivo; ao salvar, painel e TV (tela de pareamento/espera) usam a nova marca |
| **Relatórios** → 7 dias | Exibições por dia, ranking por mídia/tela; **Exportar CSV** abre no Excel com acentos corretos |

## 11. Executável (.exe)

```powershell
npm run build:exe
.\dist\sb-signage.exe
```

**Esperado:** mesmo comportamento do `npm start`. A pasta `dist/` contém `sb-signage.exe`,
`ffmpeg.exe`, `ffprobe.exe` e as licenças — distribua a pasta inteira.

## 12. App nativo Android (sem navegador)

Os testes automáticos do app não precisam de aparelho:

```powershell
cd android-player
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat testDebugUnitTest assembleDebug
```

**Esperado:** `BUILD SUCCESSFUL` (12 testes). No aparelho, com o servidor rodando (`npm start`):

```powershell
adb connect IP_DO_APARELHO:5555
adb install -r dist\SBSignagePlayer-2.0.0-debug.apk
adb shell appops set com.gsb.signage SYSTEM_ALERT_WINDOW allow
adb shell appops write-settings
```

| Passo | Esperado |
|---|---|
| Abrir o app e digitar um endereço errado | "Não foi possível conectar a …" |
| Digitar o endereço do terminal, sem `/player` (ex.: `192.168.25.177:4000`) | Código de 6 caracteres com a marca do painel |
| Painel → **Telas → Parear tela** e escolher a playlist | Conteúdo em segundos; card **online** com "Exibindo …" |
| Playlist com imagem → vídeo → imagem, ver dois ciclos | Sequência completa; o vídeo vai até o fim |
| ⚙ volume, letreiro e relógio | Aplica sem recomeçar; relógio no fuso do servidor |
| ⚙ Orientação 90° (totem vertical: testar 90° e 270°) | Vídeo e imagem giram e ocupam a tela |
| Emergência → Ativar / Desativar | Na tela em segundos / volta à programação |
| ⚙ Agenda de energia fora do horário | Tela preta; emergência acende mesmo assim |
| Card → menu → Identificar, Recarregar, Limpar cache | Nome na tela por 8 s / reinicia / baixa tudo de novo |
| **Desligar o Wi-Fi, fechar o app e abrir de novo** | **Exibe do cache**, sem tela preta |
| Religar o Wi-Fi | Em até 1 minuto: online, com as exibições offline em Relatórios |
| Parar o servidor e subir de novo | TV não para; card volta a online em segundos |
| Desligar e ligar o aparelho | App abre sozinho (pode levar ~30 s depois do boot) |
| Remover a tela no painel | App volta ao código e apaga a mídia local |

**Só em aparelho real** (o emulador não responde): imagem fluida em 1080p, letreiro sem
engasgo e som na saída HDMI. Se puder, acompanhe a memória:

```powershell
adb shell dumpsys meminfo com.gsb.signage
```

## Se algo der errado

| Sintoma | Causa provável |
|---|---|
| TV fica no código e nunca pareia | Código expirou (15 min) — o player gera outro sozinho; confira se digitou o atual |
| Card mostra "falha ao baixar conteúdo" | Rede da TV instável ou disco cheio; use "Limpar cache e baixar de novo" |
| "armazenamento quase cheio" | Playlist maior que o espaço da TV — reduza itens ou use vídeos mais curtos |
| Vídeo com som não toca na TV | Navegador bloqueia autoplay com som: use Fully Kiosk Browser (Android) ou `chrome --autoplay-policy=no-user-gesture-required` |
| Agenda em horário errado | Confira `SIGNAGE_TZ` (Configurações → Sistema mostra o fuso em uso) |
| App não conecta ao servidor | Firewall do Windows bloqueando a porta 4000, ou aparelho em outra rede |
| App não abre sozinho ao ligar | Falta a permissão de sobreposição; rode os dois comandos `appops` da seção 12 |
| Vídeo não toca no app | Veja o motivo: `adb logcat -s SBPlayer SBPlayback` |

## Não verificado automaticamente

- O **gesto** de arrastar na playlist foi validado pela lógica de reordenação, não com mouse
  real (o ambiente de testes estava sem tela visível) — confira no passo 5.
- O **app Android** foi validado em emulador (Android 17), não em aparelho real. A lista completa
  do que falta está em `android-player/README.md`.
- O **app Windows** foi validado nesta máquina (janela, app empacotado e download do instalador),
  ainda não instalado em outro computador nem testado o início com o Windows.
