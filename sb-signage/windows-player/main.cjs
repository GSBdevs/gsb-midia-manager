// SB Signage Player para Windows — processo principal do Electron.
// Tela cheia em modo quiosque, inicia com o Windows, mantém a tela acesa, se recupera sozinho
// e se atualiza a partir do servidor.
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createLocalServer, normalizeServer } = require('./local-server.cjs');
const { ensureWatchdog } = require('./autostart.cjs');

// Porta fixa: o cache e o pareamento ficam guardados por origem (127.0.0.1:porta).
const PORT = Number(process.env.SB_PLAYER_PORT) || 47800;
const LOCAL = `http://127.0.0.1:${PORT}`;
const UPDATE_CHECK_MS = 30 * 60 * 1000;
const args = process.argv.slice(1);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
// --windowed: janela comum, sem quiosque, sem vigia e sem atualização (para testes)
const WINDOWED = flag('windowed');
// --watchdog: aberto pela tarefa agendada (vigia)
const FROM_WATCHDOG = flag('watchdog');
const KIOSK = app.isPackaged && !WINDOWED;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // vídeo com som
app.commandLine.appendSwitch('disable-background-timer-throttling');

// pasta de dados alternativa (testes); o padrão é %APPDATA%\SB Signage Player
if (process.env.SB_PLAYER_DATA) app.setPath('userData', process.env.SB_PLAYER_DATA);

// ---------- registro em arquivo (diagnóstico em campo) ----------
const logFile = () => path.join(app.getPath('userData'), 'player.log');
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    if (fs.existsSync(logFile()) && fs.statSync(logFile()).size > 1024 * 1024) {
      fs.renameSync(logFile(), `${logFile()}.1`);
    }
    fs.appendFileSync(logFile(), line);
  } catch { /* sem disco: segue sem registro */ }
  console.log(line.trim());
}

// ---------- configuração ----------
const configFile = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(next) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
}

let config = readConfig();

// Fechado de propósito pelo técnico (Ctrl+Shift+Q): o vigia não reabre até alguém abrir o app
// à mão ou o Windows reiniciar.
if (FROM_WATCHDOG && config.paused) app.exit(0);
if (!app.requestSingleInstanceLock()) app.exit(0);
if (!FROM_WATCHDOG && config.paused) {
  config = { ...config, paused: false };
  writeConfig(config);
}

let win = null;
let quitting = false;

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

function quitForMaintenance() {
  config = { ...config, paused: true };
  writeConfig(config);
  log('fechado pelo técnico (Ctrl+Shift+Q); vigia pausado');
  app.quit();
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

  // Alt+F4 não fecha a tela; só o atalho de manutenção ou uma atualização
  win.on('close', (event) => {
    if (!quitting && !WINDOWED) event.preventDefault();
  });

  // a janela só navega no próprio player; páginas web da playlist abrem em iframe
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(LOCAL) && !url.startsWith('file:')) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Atalhos de manutenção:  Ctrl+Shift+S trocar o servidor   Ctrl+Shift+Q fechar o player
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || !input.shift) return;
    const key = input.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      showSetup();
    } else if (key === 'q') {
      event.preventDefault();
      quitForMaintenance();
    }
  });

  // Recuperação: a página quebrou, travou ou não carregou → recarrega sozinha.
  win.webContents.on('render-process-gone', (_e, details) => {
    log('processo da página caiu:', details.reason);
    setTimeout(() => (config.server ? showPlayer() : showSetup()), 3000);
  });
  let hang = null;
  win.on('unresponsive', () => {
    log('página sem resposta');
    hang = setTimeout(() => win.webContents.forcefullyCrashRenderer(), 15000);
  });
  win.on('responsive', () => clearTimeout(hang));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return; // navegação substituída por outra
    log('falha ao carregar', url, desc);
    setTimeout(() => win.webContents.reload(), 5000);
  });

  if (config.server) showPlayer();
  else showSetup();
}

// ---------- atualização remota (a partir do próprio servidor) ----------
// O servidor oferece em /downloads o instalador e o latest.yml gerados por "npm run dist".
function startAutoUpdate() {
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log('atualização indisponível:', err.message);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true; // instalador inteiro: mais simples e confiável na rede local
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = { info: () => {}, warn: (m) => log('atualização:', m), error: (m) => log('atualização:', m), debug: () => {} };
  autoUpdater.on('update-available', (info) => log('versão nova encontrada:', info.version));
  autoUpdater.on('update-downloaded', (info) => {
    log('versão', info.version, 'baixada');
    if (process.env.SB_UPDATE_NO_INSTALL) return; // testes: só baixa
    quitting = true;
    autoUpdater.quitAndInstall(true, true); // silenciosa; o player reabre sozinho
  });
  autoUpdater.on('error', (err) => log('atualização falhou:', err.message));

  const check = () => {
    if (!config.server) return;
    autoUpdater.setFeedURL({ provider: 'generic', url: `${config.server}/downloads/` });
    autoUpdater.checkForUpdates().catch((err) => log('atualização falhou:', err.message));
  };
  setTimeout(check, Number(process.env.SB_UPDATE_DELAY_MS) || 60_000);
  setInterval(check, UPDATE_CHECK_MS);
}

// ---------- tela de configuração ----------
ipcMain.handle('setup:current', () => ({ server: config.server || '', version: app.getVersion() }));

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
    log('servidor configurado:', server);
  }
  showPlayer();
  return { ok: true };
});

ipcMain.handle('setup:cancel', () => {
  if (config.server) showPlayer();
});

// ---------- ciclo de vida ----------
app.on('second-instance', (_e, argv) => {
  if (!win || argv.includes('--watchdog')) return; // o vigia só confere se está aberto
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(async () => {
  log(`iniciando v${app.getVersion()}${FROM_WATCHDOG ? ' (aberto pelo vigia)' : ''}; servidor: ${config.server || 'não configurado'}`);
  const fromArgs = normalizeServer(option('server'));
  if (fromArgs && fromArgs !== config.server) {
    config = { ...config, server: fromArgs };
    writeConfig(config);
  }

  try {
    await startLocalServer();
  } catch (err) {
    log(`porta ${PORT} ocupada:`, err.message);
    app.exit(1);
    return;
  }

  powerSaveBlocker.start('prevent-display-sleep');
  if (KIOSK) {
    // versões antigas usavam o registro "Run"; agora é o atalho do instalador + o vigia
    app.setLoginItemSettings({ openAtLogin: false });
    const result = await ensureWatchdog(process.execPath);
    log(result.ok ? 'vigia ativo (tarefa agendada a cada minuto)' : `vigia não foi criado: ${result.output}`);
  }
  if (KIOSK || process.env.SB_FORCE_UPDATE_CHECK) startAutoUpdate();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
