// Painel — inicialização, login, navegação, tempo real e alertas globais.
import { api, session } from './api.js';
import { state, subscribe, load, loadAll, patchDeviceStatus, mediaById } from './state.js';
import {
  esc, icon, toast, toastError, openDialog, applyAccent, applyTheme, toggleTheme, applyDensity, brandHtml, closeMenu
} from './ui.js';
import overview from './views/overview.js';
import screens from './views/screens.js';
import groups from './views/groups.js';
import media from './views/media.js';
import playlists from './views/playlists.js';
import schedules from './views/schedules.js';
import reports from './views/reports.js';
import settings from './views/settings.js';

const $ = (s) => document.querySelector(s);

const NAV = [
  { section: 'Operação' },
  { id: 'overview', label: 'Visão geral', icon: 'layout-dashboard', view: overview },
  { id: 'screens', label: 'Telas', icon: 'monitor', view: screens, count: () => state.devices.length ? `${state.devices.filter((d) => d.online).length}/${state.devices.length}` : '' },
  { id: 'groups', label: 'Grupos', icon: 'boxes', view: groups },
  { section: 'Conteúdo' },
  { id: 'media', label: 'Mídias', icon: 'images', view: media, count: () => state.media.length || '' },
  { id: 'playlists', label: 'Playlists', icon: 'list-video', view: playlists, count: () => state.playlists.length || '' },
  { id: 'schedules', label: 'Agenda', icon: 'calendar-clock', view: schedules },
  { section: 'Análise' },
  { id: 'reports', label: 'Relatórios', icon: 'chart-column', view: reports },
  { id: 'settings', label: 'Configurações', icon: 'settings', view: settings }
];
const ROUTES = Object.fromEntries(NAV.filter((n) => n.id).map((n) => [n.id, n]));

let current = null;       // { id, view, controller }
let socket = null;
let socketDown = false;

// ---------- marca e tema ----------
function applyBranding(s) {
  state.settings = { ...state.settings, ...s };
  applyAccent(state.settings.accent);
  applyTheme(state.settings.theme);
  applyDensity(state.settings.density);
  document.querySelectorAll('[data-brand]').forEach((el) => { el.innerHTML = brandHtml(state.settings); });
  document.title = `${state.settings.brandName} — Painel`;
  renderThemeToggle();
}

function renderThemeToggle() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#theme-toggle').innerHTML = icon(dark ? 'sun' : 'moon');
  $('#theme-toggle').title = dark ? 'Tema claro' : 'Tema escuro';
}

// ---------- login ----------
function showLogin() {
  socket?.disconnect();
  socket = null;
  $('#app').hidden = true;
  $('#login-view').hidden = false;
  $('#login-password').value = '';
  $('#login-password').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    const { token } = await api('/login', { method: 'POST', body: { password: $('#login-password').value } });
    session.set(token);
    await enterApp();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  }
});

window.addEventListener('auth-expired', () => {
  session.clear();
  if (!$('#app').hidden) toast('Sessão expirada — entre novamente.', 'warn');
  showLogin();
});

async function logout() {
  try { await api('/logout', { method: 'POST' }); } catch { /* sessão já inválida */ }
  session.clear();
  showLogin();
}

// ---------- shell ----------
function renderNav() {
  $('#nav').innerHTML = NAV.map((n) => {
    if (n.section) return `<div class="nav-section">${esc(n.section)}</div>`;
    const count = n.count?.() ?? '';
    return `<a href="#${n.id}" data-nav="${n.id}" class="${current?.id === n.id ? 'active' : ''}">
      ${icon(n.icon)}<span>${esc(n.label)}</span>${count !== '' ? `<span class="count">${esc(count)}</span>` : ''}</a>`;
  }).join('');
}

function renderBanners() {
  const parts = [];
  const em = state.emergency;
  if (em?.active) {
    const m = em.mediaId ? mediaById(em.mediaId) : null;
    parts.push(`<div class="banner banner-danger" role="alert">${icon('siren')}
      <span class="grow"><b>EMERGÊNCIA ATIVA</b> em todas as telas — ${esc(m ? `mídia: ${m.name}` : `"${em.message}"`)}</span>
      <button class="btn btn-sm" type="button" data-banner="emergency-off">Desativar</button></div>`);
  }
  if (state.me?.defaultPassword) {
    parts.push(`<div class="banner banner-warn">${icon('key-round')}
      <span class="grow">O painel está usando a senha padrão <code>admin</code>. Troque antes de expor o servidor fora da rede local.</span>
      <a class="btn btn-sm" href="#settings">Trocar senha</a></div>`);
  }
  if (socketDown) {
    parts.push(`<div class="banner banner-warn">${icon('wifi-off')}
      <span class="grow">Conexão em tempo real perdida — reconectando. Os dados podem estar desatualizados.</span></div>`);
  }
  $('#banners').innerHTML = parts.join('');
}

$('#banners').addEventListener('click', async (e) => {
  if (e.target.closest('[data-banner="emergency-off"]')) {
    try {
      await api('/emergency', { method: 'DELETE' });
      toast('Emergência desativada — telas voltando à programação.');
    } catch (err) { toastError(err); }
  }
});

// ---------- navegação ----------
function captureFocus(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el) || !el.dataset.key) return null;
  return { key: el.dataset.key, start: el.selectionStart, end: el.selectionEnd };
}
function restoreFocus(root, saved) {
  if (!saved) return;
  const el = root.querySelector(`[data-key="${CSS.escape(saved.key)}"]`);
  if (!el) return;
  el.focus();
  try { if (saved.start != null) el.setSelectionRange(saved.start, saved.end); } catch { /* campo sem seleção */ }
}

function renderView() {
  if (!current) return;
  const root = $('#view');
  const v = current.view;
  $('#view-title').textContent = v.title;
  $('#view-subtitle').textContent = v.subtitle?.() || '';
  $('#view-actions').innerHTML = v.actions?.() || '';
  const saved = captureFocus(root);
  v.render(root, current.ctx);
  restoreFocus(root, saved);
}

async function navigate(id) {
  if (!ROUTES[id]) id = 'overview';
  if (current?.id === id) return;
  if (current?.view.canLeave && !(await current.view.canLeave())) {
    history.replaceState(null, '', `#${current.id}`);
    return;
  }
  current?.controller.abort();
  current?.view.leave?.();
  closeMenu();
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    actions: $('#view-actions'),
    navigate: (to) => { location.hash = to; },
    rerender: () => renderView()
  };
  current = { id, view: ROUTES[id].view, controller, ctx };
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
  $('#app').classList.remove('nav-open');
  renderNav();
  const root = $('#view');
  root.innerHTML = '';
  current.view.enter?.(root, ctx);
  renderView();
  root.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
window.addEventListener('beforeunload', (e) => {
  if (current?.view.isDirty?.()) e.preventDefault();
});

// Re-renderiza a tela atual só quando algo de que ela depende mudou.
subscribe((keys) => {
  renderNav();
  if (keys.has('emergency') || keys.has('media') || keys.has('me')) renderBanners();
  if (current && current.view.deps.some((d) => keys.has(d))) renderView();
});

// ---------- tempo real ----------
const reloadOverview = (() => {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(() => load('overview').catch(() => {}), 400);
  };
})();

function connectSocket() {
  socket?.disconnect();
  socket = io({ auth: { role: 'panel', token: session.token } });
  const reload = (...keys) => () => load(...keys).then(reloadOverview).catch(() => {});
  socket.on('devices-changed', reload('devices'));
  socket.on('device-status', (p) => {
    if (!patchDeviceStatus(p)) load('devices').catch(() => {});
    reloadOverview();
  });
  socket.on('media-changed', reload('media'));
  socket.on('playlists-changed', reload('playlists'));
  socket.on('schedules-changed', reload('schedules'));
  socket.on('groups-changed', reload('groups'));
  socket.on('emergency-changed', reload('emergency'));
  socket.on('settings-changed', (s) => {
    applyBranding(s);
    renderView();
  });
  socket.on('disconnect', () => {
    socketDown = true;
    setTimeout(() => { if (socketDown) renderBanners(); }, 3000);
  });
  socket.on('connect', () => {
    if (socketDown) {
      socketDown = false;
      renderBanners();
      loadAll().catch(() => {}); // o estado pode ter mudado enquanto estávamos fora
    }
  });
}

// ---------- emergência ----------
async function openEmergency() {
  const ready = state.media.filter((m) => m.status === 'ready');
  await openDialog({
    title: 'Conteúdo de emergência',
    submitText: 'Ativar em todas as telas',
    danger: true,
    body: `
      <p class="muted">Substitui imediatamente o conteúdo de <b>todas as telas</b> até ser desativado — inclusive as que estão desligadas pela agenda de energia.</p>
      <div class="segmented" role="tablist">
        <button type="button" class="active" data-mode="message">${icon('type')} Mensagem</button>
        <button type="button" data-mode="media">${icon('image')} Mídia</button>
      </div>
      <label class="field" data-pane="message"><span>Mensagem exibida em tela cheia</span>
        <textarea name="message" rows="3" maxlength="500" placeholder="Ex.: EVACUAR O PRÉDIO PELA SAÍDA LESTE"></textarea></label>
      <label class="field" data-pane="media" hidden><span>Mídia</span>
        <select name="mediaId">${ready.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('') || '<option value="">Nenhuma mídia pronta</option>'}</select></label>`,
    onOpen(dlg) {
      dlg.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
        dlg.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('active', x === b));
        dlg.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.mode; });
        dlg.dataset.mode = b.dataset.mode;
      }));
      dlg.dataset.mode = 'message';
    },
    async onSubmit(form, dlg) {
      const body = dlg.dataset.mode === 'media' ? { mediaId: form.mediaId.value } : { message: form.message.value.trim() };
      await api('/emergency', { method: 'POST', body });
      toast('Emergência ativada em todas as telas.', 'warn');
    }
  });
}

// ---------- boot ----------
async function enterApp() {
  state.me = await api('/me');
  applyBranding(state.me.branding || {});
  $('#login-view').hidden = true;
  $('#app').hidden = false;
  $('#btn-emergency').innerHTML = `${icon('siren')}<span>Emergência</span>`;
  $('#btn-logout').innerHTML = `${icon('log-out')}<span>Sair</span>`;
  $('#menu-toggle').innerHTML = icon('menu');
  connectSocket();
  await loadAll();
  renderBanners();
  current = null;
  navigate(location.hash.slice(1) || 'overview');
}

$('#btn-emergency').addEventListener('click', openEmergency);
window.addEventListener('open-emergency', openEmergency);
$('#btn-logout').addEventListener('click', logout);
$('#theme-toggle').addEventListener('click', () => {
  toggleTheme();
  renderThemeToggle();
});
$('#menu-toggle').addEventListener('click', () => $('#app').classList.toggle('nav-open'));
$('#nav').addEventListener('click', () => $('#app').classList.remove('nav-open'));

(async () => {
  try {
    applyBranding(await api('/branding'));
  } catch { /* segue com a marca padrão */ }
  if (session.token) {
    try {
      await enterApp();
      return;
    } catch { /* token inválido → login */ }
  }
  showLogin();
})();
