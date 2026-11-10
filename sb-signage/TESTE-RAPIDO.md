# Teste rápido com dois computadores

- **Este PC (host):** roda o servidor e o painel; é onde você gerencia tudo.
- **Notebook (tela):** instala o SB Mídias e exibe o conteúdo em tela cheia.

Tempo: ~15 minutos. Os dois precisam estar **na mesma rede** (mesmo Wi-Fi ou cabo).

## Como a conexão funciona

```
 Notebook (tela)                                       Este PC (host)
┌──────────────────────────────┐                     ┌───────────────────────────────┐
│ SB Mídias (app)              │   rede local        │ servidor SB Mídias :4000      │
│  · player embutido no app    │ ──────────────────▶ │  · painel (você usa aqui)     │
│  · vídeos e fotos em disco   │  1. pergunta:       │  · API das telas              │
│  · registro de exibições     │     "mudou algo?"   │  · mídia convertida           │
│                              │  2. canal aberto:   │  · aviso em tempo real        │
│                              │     avisos e status │                               │
└──────────────────────────────┘                     └───────────────────────────────┘
```

1. **Pareamento:** o app mostra um código; você o digita no painel. A partir daí o notebook
   tem uma credencial própria e não pede mais nada.
2. **Sincronização:** o app pergunta ao servidor se algo mudou a cada 60 s, e o servidor
   também avisa na hora por um canal aberto (WebSocket). Na prática, uma mudança no painel
   aparece na tela em 1 a 3 segundos.
3. **Mídia:** cada vídeo ou foto é baixado **uma vez** e guardado no notebook.
4. **Sem conexão:** se a rede ou o servidor cair, a tela continua exibindo o que já tem,
   inclusive se o notebook for reiniciado. Quando a conexão volta, ela sincroniza sozinha e
   envia o registro do que exibiu nesse período.

Só o notebook inicia a conexão. O host nunca acessa o notebook, por isso a única liberação
necessária é a porta **4000** no host.

## 1. Iniciar o host (este PC)

```powershell
cd C:\Users\GRUPOSB\Documents\CODES\propaganda-software\sb-signage
npm start
```

O terminal mostra algo assim:

```
SB Mídias no ar.
  Painel : http://localhost:4000/
  Rede   : http://192.168.25.114:4000   (Wi-Fi)
           ↑ endereço que as telas usam (player no navegador: acrescente /player)
  Baixar : http://192.168.25.114:4000/downloads/SBMidias-Setup-2.1.0.exe
```

**Anote o endereço da linha "Rede"**: ele é usado nos passos seguintes. Se aparecerem várias
linhas "Rede", use a da placa Wi-Fi ou Ethernet; ignore "vEthernet", "VirtualBox" e similares.

Na primeira vez, o Windows pergunta se o Node.js pode usar a rede: marque **Redes privadas**
e clique em **Permitir**. Se a pergunta não aparecer, ou se o notebook não conseguir acessar
o host, libere a porta num PowerShell **como administrador**:

```powershell
netsh advfirewall firewall add rule name="SB Signage 4000" dir=in action=allow protocol=TCP localport=4000
```

Sem Node.js instalado, use `dist\sb-midias.exe` no lugar do `npm start`; o resultado é o mesmo.

**Mantenha o terminal aberto.** Fechá-lo desliga o servidor (as telas continuam exibindo o cache).

## 2. Conferir a conexão (no notebook)

No navegador do notebook, abra o endereço da linha "Rede" (ex.: `http://192.168.25.114:4000`).

- **Aparece a tela de login do painel:** a conexão está ok.
- **Não carrega:** é rede ou firewall. Veja "Se algo der errado" no fim.

## 3. Instalar o player no notebook

1. Ainda no navegador do notebook, abra o endereço da linha **"Baixar"**.
2. Execute o arquivo baixado. O Windows mostra **"O Windows protegeu o computador"**, porque o
   instalador ainda não tem assinatura digital: clique em **Mais informações → Executar assim mesmo**.
3. A instalação é automática (não pede administrador) e o player abre em tela cheia.
4. Digite o endereço do host (`192.168.25.114:4000`, sem `/player`) e clique em **Conectar**.
5. Aparece um **código de 6 letras**.

Atalhos no notebook:

| Atalho | Faz |
|---|---|
| **Ctrl+Shift+Q** | Fecha o player |
| **Ctrl+Shift+S** | Troca o endereço do servidor |

O player abre sozinho no login do Windows (atalho na pasta Inicializar) e um **vigia** o reabre
em até 1 minuto se ele **cair**. Fechar de propósito (X da janela, Alt+F4, barra de tarefas ou
Ctrl+Shift+Q) não conta como queda: ele só volta quando alguém abrir o app ou o Windows reiniciar.

**Atualização:** versões novas publicadas no servidor (`npm run dist` no `windows-player`) são
instaladas sozinhas em até 30 minutos. As versões 2.0.x não tinham isso por completo: instale a 2.1.0 uma
vez pelo link "Baixar"; daí em diante elas chegam sozinhas.

Para remover: feche com Ctrl+Shift+Q e desinstale em **Configurações → Aplicativos → SB Mídias** (remove também o atalho e o vigia). Registro de diagnóstico:
`%APPDATA%\SB Signage Player\player.log`.

## 4. Gerenciar pelo host

No host, abra `http://localhost:4000` e entre com a senha (`admin` até você trocar).

1. **Telas → Parear tela:** digite o código do notebook e dê um nome. O card aparece **online**.
2. **Mídias:** arraste 2 ou 3 arquivos (um vídeo e duas fotos) e espere ficarem prontos.
3. **Playlists → Nova playlist → Adicionar mídia:** escolha os arquivos e clique em **Salvar**.
4. **Telas:** no card do notebook, escolha a playlist. Em segundos a tela começa a exibir.

## 5. O que testar

Faça no host e observe o notebook:

| No host | Esperado no notebook |
|---|---|
| Trocar a ordem da playlist e salvar | Muda em segundos |
| ⚙ da tela: letreiro com um texto e relógio | Rodapé aparece sem recomeçar o vídeo |
| Card → menu → **Identificar** | Nome da tela por 8 s |
| ⚙ da tela: **Ajuste da mídia → Preencher a tela** | Mídia com a mesma orientação da tela ocupa tudo; foto em pé numa tela deitada continua inteira, com bordas |
| **Parar o servidor** (Ctrl+C no terminal) | **A tela continua exibindo** |
| Com o servidor parado: reiniciar o notebook | O player abre sozinho e **exibe do cache** |
| `npm start` de novo | Card volta a online em segundos |
| **Relatórios** | Lista o que foi exibido, inclusive com o servidor parado |

## Se algo der errado

| Sintoma | O que fazer |
|---|---|
| Notebook não abre o painel no passo 2 | Mesma rede? Firewall: rode o comando `netsh` do passo 1. Rede do host como **Privada** (Configurações → Rede → propriedades) |
| Player diz "Não foi possível conectar" | O mesmo do item anterior. Confira se digitou a porta `:4000` |
| Código não aparece | Ctrl+Shift+S e confira o endereço |
| Vídeo sem som | Volume do notebook e o volume da tela (⚙ no painel) |
| O IP do host mudou | No notebook, Ctrl+Shift+S e digite o novo endereço. O pareamento é mantido. Para evitar, reserve o IP do host no roteador |
| Card fica offline com a tela exibindo | Rede caiu entre os dois; a tela segue no cache e volta sozinha |

O roteiro completo, com todos os recursos, está em [TESTES.md](TESTES.md).
