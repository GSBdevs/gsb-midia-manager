# SB Signage — Player Android nativo (ExoPlayer)

Player nativo para frota grande de TVs/TV boxes Android. Substitui o player web quando você precisa de:

- **Reprodução por hardware** via ExoPlayer (media3) — mais estável que WebView em aparelhos fracos;
- **Auto-start no boot** (BroadcastReceiver) e watchdog de processo;
- **Cache local em disco** gerenciado pelo app (não depende de IndexedDB/navegador);
- **Energia**: apaga a tela dentro da janela configurada no painel (soft power) e, quando o
  aparelho permite, desliga a TV por **HDMI-CEC** (ver limitação abaixo).

O protocolo é o mesmo do player web: pareamento por código → token de device →
polling do manifesto (`/api/player/manifest`, ETag) a cada 60 s → download → loop.
O push por Socket.IO foi omitido de propósito: o polling é a fonte de verdade e
elimina uma dependência — a latência máxima de sincronização fica em 60 s.

## Como compilar

1. Abra a pasta `android-player/` no **Android Studio** (Hedgehog+).
2. Ajuste `SERVER_URL` em `app/build.gradle.kts` (ou deixe configurável na primeira execução).
3. `Build > Generate Signed APK` e instale nas TVs (`adb install` ou pendrive).

> **Status: scaffold funcional, não testado em aparelho.** Este projeto foi gerado como
> ponto de partida da Fase "frota grande" — compile, teste num aparelho real e ajuste.
> O player web continua sendo o caminho recomendado até a frota justificar o app.

## Limitação HDMI-CEC

Controle CEC (`HdmiControlManager`) exige a permissão `android.permission.HDMI_CEC`,
que é **de sistema** — apenas apps assinados com a chave da plataforma ou instalados
como system-app (root/AOSP próprio) a recebem. Em aparelhos comuns o app faz *soft
power* (tela preta + WakeLock liberado). `PowerScheduler.kt` já isola essa lógica:
se o app rodar como system-app, o CEC liga/desliga a TV de verdade.

## Estrutura

```
android-player/
├── settings.gradle.kts / build.gradle.kts / gradle.properties
└── app/
    ├── build.gradle.kts            # deps: media3-exoplayer, okhttp, coroutines
    └── src/main/
        ├── AndroidManifest.xml     # boot receiver, launcher, landscape, keep-screen-on
        ├── res/layout/activity_main.xml
        ├── res/values/strings.xml
        └── java/com/gsb/signage/
            ├── MainActivity.kt     # alterna pareamento ↔ reprodução, fullscreen kiosk
            ├── SignageApi.kt       # REST: pair/request, pair/status, manifest, logs
            ├── MediaCache.kt       # download sequencial p/ filesDir + evicção
            ├── PlaybackController.kt # loop ExoPlayer (vídeo) + ImageView (imagem)
            ├── PowerScheduler.kt   # janela de energia + gancho CEC
            └── BootReceiver.kt     # auto-start após boot
```
