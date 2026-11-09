# SB Signage — Player Android nativo

App instalado na TV, TV box ou totem. A gestão continua no painel web; a exibição roda aqui,
**sem navegador e sem WebView**: vídeo no ExoPlayer (Media3) e imagem em view nativa.

**Status: em fase de testes (2.0.0).** Validado de ponta a ponta contra o servidor v2 em
emulador (Android 17, x86_64). **Ainda não rodou em aparelho real** — ver "Limitações".

Fala o mesmo protocolo do player web, sem nenhuma mudança no servidor: pareamento por código,
manifesto com ETag, Socket.IO para push/comandos/status e registro de exibição em lotes.

## Compilar

```powershell
cd android-player
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"   # JDK 21; o Gradle 8.9 não roda no JDK 26
.\gradlew.bat testDebugUnitTest assembleDebug
```

Gera `app/build/outputs/apk/debug/app-debug.apk`. Requer o Android SDK (`ANDROID_HOME`) com a
plataforma 34. Para entregar já apontando para um servidor: `-PserverUrl=https://telas.cliente.com.br`.

## Instalar e configurar

```powershell
adb connect 192.168.25.50:5555        # IP do aparelho (ou cabo USB)
adb install -r app-debug.apk
```

1. Abra o app e informe o endereço do servidor (o mesmo do painel, ex.: `192.168.25.177:4000`).
2. No painel: **Telas → Parear tela**, digite o código que apareceu na TV.
3. Conceda o início automático (próxima seção).

O PC do servidor precisa aceitar conexões na porta 4000 (firewall do Windows).

### Início automático: permissão obrigatória (Android 10+)

Sem a permissão **"sobrepor a outros apps"**, o sistema bloqueia o app de abrir sozinho, tanto
após ligar o aparelho quanto após uma falha (`Background activity launch blocked`). Com ela,
abriu em 28 s depois do boot no teste. Conceda de uma destas formas:

- **Pelo app:** botão **Permitir início automático** na tela de pareamento.
- **Por ADB** (quando o aparelho não tem essa tela de configurações):

```powershell
adb shell appops set com.gsb.signage SYSTEM_ALERT_WINDOW allow
adb shell appops write-settings
```

O `write-settings` importa: sem ele a permissão pode se perder no reinício seguinte.

## O que faz

| Recurso | Situação |
|---|---|
| Pareamento, servidor configurável na primeira execução | ok |
| Vídeo, imagem, GIF/WebP animados | ok |
| Liga e exibe **sem rede** (manifesto e mídia em disco) | ok |
| Status no painel (online, "Exibindo…", armazenamento) | ok |
| Push: playlist e ajustes chegam em segundos | ok |
| Comandos: identificar, recarregar, limpar cache, remoção da tela | ok |
| Emergência (texto ou mídia), vence a agenda de energia | ok |
| Orientação 0/90/180/270 (gira o palco, funciona onde o sistema ignora rotação) | 0° e 90° testados |
| Letreiro e relógio; volume/mudo sem reiniciar a playlist | ok |
| Agenda de energia com relógio e fuso do servidor | ok (tela preta) |
| Marca do cliente: nome, cor e logo | ok |
| Registro de exibição em disco, enviado ao voltar a rede | ok |
| Download que falha é retomado sozinho; item inválido é pulado | ok |
| Reabre após boot, atualização e falha do app | ok, com a permissão acima |

## Limitações

- **Nunca rodou em aparelho real.** Falta validar no totem HD-3566S (Android 11, RK3566) e em
  TV box: decodificação de 1080p, desempenho do letreiro e estabilidade em horas de uso.
- **Só o Android 17 foi exercitado.** Abaixo do Android 9, a imagem usa outro caminho de código
  (`BitmapFactory`), compilado mas não testado.
- **Página web em playlist não é exibida** neste app: o item é ignorado.
- **SVG não é exibido** (pulado, com erro no status). Prefira PNG/JPG.
- **Vídeo longo só toca depois de baixado**: não usa o HLS do servidor.
- **Sem crossfade** entre itens (o player web tem).
- **Sem watchdog em processo separado** (plano técnico §4.10). Falha do app reabre sozinha;
  processo morto pelo sistema ou aparelho travado, não.
- **Sem atualização remota** do app e **sem modo quiosque travado**: o botão Home sai do app.
- **Energia é só tela preta.** Desligar a TV por HDMI-CEC exige app de sistema; não implementado.
- **Build de depuração** (`assembleDebug`): aceita `--es server` por intent. Para entregar a
  cliente, gere release com assinatura própria.

## Estrutura

```
android-player/
├── gradlew(.bat), gradle/wrapper/   # Gradle 8.9
└── app/
    ├── build.gradle.kts             # media3, okhttp, coroutines, socket.io-client
    └── src/
        ├── test/.../DomainTest.kt   # testes na JVM, sem aparelho
        └── main/
            ├── AndroidManifest.xml
            ├── res/layout/          # activity_main + video_surface/video_texture
            └── java/com/gsb/signage/
                ├── MainActivity.kt        # configuração, pareamento, sync, emergência, status
                ├── PlaybackController.kt  # loop de reprodução e proteção contra travamento
                ├── Domain.kt              # regras puras: manifesto, agenda, relógio, endereço
                ├── Storage.kt             # preferências, manifesto e registro em disco
                ├── MediaCache.kt          # cache de mídia com evicção
                ├── SignageApi.kt          # cliente REST
                ├── SignageApp.kt          # reabre após falha
                └── BootReceiver.kt        # reabre após boot e atualização
```
