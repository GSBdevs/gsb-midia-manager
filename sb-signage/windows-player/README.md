# SB Signage Player — Windows

App instalado no PC ou notebook que serve de tela. Abre em tela cheia, inicia com o Windows,
mantém a tela acesa e **não depende de abrir um navegador**.

**Status: em fase de testes (2.0.0).** Validado nesta máquina contra o servidor v2; ainda não
foi instalado em outro computador. Passo a passo de teste: [`../TESTE-RAPIDO.md`](../TESTE-RAPIDO.md).

## Como funciona

O app é um Electron com o **player web embutido** (`public/player`, copiado no build) e um
servidor local em `127.0.0.1:47800`:

- **Arquivos do player:** servidos de dentro do app. O player abre mesmo com o servidor fora do ar.
- **API, mídia e Socket.IO:** encaminhados ao servidor SB Signage, inclusive WebSocket.
- **Cache e pareamento:** ficam no disco do app, em `%APPDATA%\SB Signage Player`.

Por isso o `player.js` roda sem nenhuma alteração: o mesmo código do navegador, com os mesmos
recursos (crossfade, páginas web, SVG, HLS, emergência, letreiro, relógio).

## Comandos

```powershell
npm install
npm test          # 7 testes do servidor local contra o servidor SB Signage real
npm start         # abre em janela comum, para desenvolvimento
npm run dist      # gera dist\SBSignagePlayer-Setup-2.0.0.exe e publica em ..\downloads
```

`npm run dist` coloca o instalador (e o APK do Android, se existir) em `sb-signage/downloads` e
`sb-signage/dist/downloads`. O servidor os oferece em `http://IP:4000/downloads/…`.

## Uso

| Ação | Como |
|---|---|
| Primeira execução | Digita o endereço do servidor e aparece o código de pareamento |
| Trocar o servidor | **Ctrl+Shift+S** (o pareamento é mantido se for o mesmo servidor) |
| Fechar | **Ctrl+Shift+Q** |
| Abrir sem tela cheia | `"SB Signage Player.exe" --windowed` |
| Já apontar para um servidor | `"SB Signage Player.exe" --server=192.168.0.10:4000` |
| Outra porta local | variável `SB_PLAYER_PORT` (padrão 47800) |

## Recuperação

| Situação | Comportamento |
|---|---|
| Página do player quebra | Recarrega em 3 s (testado) |
| Página trava | Força o reinício da página após 15 s sem resposta |
| Servidor ou rede caem | Continua tocando do cache; reconecta sozinho (testado: 3 s) |
| Windows reinicia | Abre no login, já em tela cheia |

## Limitações

- **Sem assinatura digital:** o Windows avisa ("O Windows protegeu o computador") na instalação.
  Para vender, assine o instalador com certificado de código.
- **Sem watchdog externo:** se o processo principal do app morrer, só volta no próximo login.
- **Sem atualização remota:** versão nova é instalada por cima, baixando de `/downloads`.
- **Vídeo grande** é montado em memória durante o download, como no player web (herdado do
  `player.js`); o cache em si fica em disco.
- **Ícone padrão do Electron.**
- O início automático é por usuário: o Windows precisa logar sozinho nesse usuário
  (logon automático) para a tela voltar sem ninguém digitar a senha.
