// SB Signage Player para Windows — processo principal do Electron.
// Tela cheia em modo quiosque, inicia com o Windows, mantém a tela acesa e se recupera sozinho.
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createLocalServer, normalizeServer } = require('./local-server.cjs');

// Porta fixa: o cache e o pareamento ficam guardados por origem (127.0.0.1:porta).
const PORT = Number(process.env.SB_PLAYER_PORT) || 47800;
const LOCAL = `http://127.0.0.1:${PORT}`;
const args = process.argv.slice(1);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
// --windowed: janela comum, sem quiosque e sem iniciar com o Windows (para testes)
const WINDOWED = flag('windowed');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // vídeo com som
app.commandLine.appendSwitch('disable-background-timer-throttling');

// pasta de dados alternativa (testes); o padrão é %APPDATA%\SB Signage Player
if (process.env.SB_PLAYER_DATA) app.setPath('userData', process.env.SB_PLAYER_DATA);

if (!app.requestSingleInstanceLock()) app.exit(0);

const configFile = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(config) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

let config = readConfig();
let win = null;

const assetsDir = () => path.join(__dirname, 'app');

function startLocalServer() {
  const server = createLocalServer({
    playerDir: path.join(assetsDir(), 'player'),
    socketClient: path.join(assetsDir(), 'socket.io.min.js'),
    getUpstream: () => config.server || null
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function showPlayer() {
  win.loadURL(`${LOCAL}/player/`);
}
function showSetup() {
  win.loadFile(path.join(__dirname, 'setup.html'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    kiosk: !WINDOWED,
    fullscreen: !WINDOWED,
    title: 'SB Signage Player',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} SBSignagePlayer-Windows/${app.getVersion()}`);

  // a janela só navega no próprio player; páginas web da playlist abrem em iframe
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(LOCAL) && !url.startsWith('file:')) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Atalhos de manutenção (não existem no player web):
  //   Ctrl+Shift+S  trocar o servidor     Ctrl+Shift+Q  fechar o player
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || !input.shift) return;
    const key = input.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      showSetup();
    } else if (key === 'q') {
      event.preventDefault();
      app.quit();
    }
  });

  // Recuperação: a página quebrou, travou ou não carregou → recarrega sozinha.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[player] processo da página caiu:', details.reason);
    setTimeout(() => (config.server ? showPlayer() : showSetup()), 3000);
  });
  let hang = null;
  win.on('unresponsive', () => {
    hang = setTimeout(() => win.webContents.forcefullyCrashRenderer(), 15000);
  });
  win.on('responsive', () => clearTimeout(hang));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return; // navegação substituída por outra
    console.error('[player] falha ao carregar', url, desc);
    setTimeout(() => win.webContents.reload(), 5000);
  });

  if (config.server) showPlayer();
  else showSetup();
}

// ---------- tela de configuração ----------
ipcMain.handle('setup:current', () => config.server || '');

ipcMain.handle('setup:save', async (_e, input) => {
  const server = normalizeServer(input);
  if (!server) return { ok: false, error: 'Endereço inválido.' };
  try {
    const res = await fetch(`${server}/api/branding`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
  } catch {
    return { ok: false, error: `Não foi possível conectar a ${server}.` };
  }
  // O pareamento é mantido: se só o IP do servidor mudou, a tela segue pareada. Se for outro
  // servidor, ele recusa a credencial (401) e o player volta sozinho para o código de pareamento.
  if (server !== config.server) {
    config = { ...config, server };
    writeConfig(config);
  }
  showPlayer();
  return { ok: true };
});

ipcMain.handle('setup:cancel', () => {
  if (config.server) showPlayer();
});

// ---------- ciclo de vida ----------
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  const fromArgs = normalizeServer(option('server'));
  if (fromArgs && fromArgs !== config.server) {
    config = { ...config, server: fromArgs };
    writeConfig(config);
  }

  try {
    await startLocalServer();
  } catch (err) {
    console.error(`[player] porta ${PORT} ocupada:`, err.message);
    app.exit(1);
    return;
  }

  powerSaveBlocker.start('prevent-display-sleep');
  if (app.isPackaged && !WINDOWED) {
    app.setLoginItemSettings({ openAtLogin: true }); // volta sozinho depois de queda de energia
  }
  createWindow();
});

app.on('window-all-closed', () => app.quit());
