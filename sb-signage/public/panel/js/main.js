// Painel — inicialização, login, navegação, tempo real e alertas globais.
import { api, session } from './api.js';
import { state, subscribe, load, loadAll, patchDeviceStatus, can, ROLE_LABELS } from './state.js';
import {
  esc, icon, toast, toastError, applyAccent, applyTheme, toggleTheme, applyDensity, brandHtml, closeMenu,
  openMenu, promptDialog, plural
} from './ui.js';
import overview from './views/overview.js';
import screens from './views/screens.js';
import groups from './views/groups.js';
import media from './views/media.js';
import playlists from './views/playlists.js';
import schedules from './views/schedules.js';
import reports from './views/reports.js';
import settings from './views/settings.js';
import users from './views/users.js';

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
  { section: 'Administração' },
  { id: 'users', label: 'Usuários', icon: 'users', view: users, permission: 'users.manage' },
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

// ---------- telas de entrada (login, primeiro acesso, senha provisória) ----------
const ENTRY_VIEWS = ['#login-view', '#setup-view', '#temp-password-view'];
function showEntry(id) {
  socket?.disconnect();
  socket = null;
  $('#app').hidden = true;
  for (const v of ENTRY_VIEWS) $(v).hidden = v !== id;
  $(id).querySelector('input:not([type=checkbox])')?.focus();
}

function showLogin() {
  $('#login-password').value = '';
  showEntry('#login-view');
  if ($('#login-email').value) $('#login-password').focus();
}

function formError(sel, error) {
  const el = $(sel);
  el.textContent = error ? error.message || String(error) : '';
  el.hidden = !error;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  formError('#login-error', null);
  try {
    const { token } = await api('/login', {
      method: 'POST', body: { email: $('#login-email').value, password: $('#login-password').value }
    });
    session.set(token);
    await enterApp();
  } catch (error) {
    formError('#login-error', error);
  }
});

async function showSetup(legacy) {
  const box = $('#setup-import');
  box.hidden = !legacy;
  if (legacy) {
    $('#setup-import-detail').textContent =
      `Encontramos ${plural(legacy.devices, 'tela pareada', 'telas pareadas')}, ${plural(legacy.media, 'mídia', 'mídias')} e ` +
      `${plural(legacy.playlists, 'playlist', 'playlists')}. As telas continuam funcionando sem parear de novo; o arquivo antigo não é apagado.`;
    const name = $('#setup-form').orgName;
    // a marca personalizada costuma ser o nome do cliente; o nome do produto (atual ou antigo), não
    if (!name.value && legacy.brandName && !['SB Mídias', 'SB Signage'].includes(legacy.brandName)) name.value = legacy.brandName;
  }
  showEntry('#setup-view');
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  formError('#setup-error', null);
  if (f.password.value !== f.confirm.value) return formError('#setup-error', 'A confirmação não confere com a senha.');
  const submit = f.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const r = await api('/setup', {
      method: 'POST',
      body: {
        orgName: f.orgName.value, name: f.name.value, email: f.email.value, password: f.password.value,
        importLegacy: !$('#setup-import').hidden && f.importLegacy.checked
      }
    });
    session.set(r.token);
    f.reset();
    await enterApp();
    if (r.imported) toast(`Dados importados: ${plural(r.imported.devices, 'tela', 'telas')}, ${plural(r.imported.media, 'mídia', 'mídias')}.`);
  } catch (error) {
    formError('#setup-error', error);
  } finally {
    submit.disabled = false;
  }
});

$('#temp-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  formError('#temp-password-error', null);
  if (f.next.value !== f.confirm.value) return formError('#temp-password-error', 'A confirmação não confere com a nova senha.');
  try {
    const r = await api('/account/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
    session.set(r.token);
    f.reset();
    await enterApp();
    toast('Senha definida.');
  } catch (error) {
    formError('#temp-password-error', error);
  }
});
$('#temp-password-form [data-act="logout"]').addEventListener('click', () => logout());

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
// Seções sem nenhum item visível somem junto (ex.: "Administração" para quem não gerencia usuários).
function visibleNav() {
  const items = NAV.filter((n) => n.section || !n.permission || can(n.permission));
  return items.filter((n, i) => !n.section || (items[i + 1] && !items[i + 1].section));
}

function renderNav() {
  $('#nav').innerHTML = visibleNav().map((n) => {
    if (n.section) return `<div class="nav-section">${esc(n.section)}</div>`;
    const count = n.count?.() ?? '';
    return `<a href="#${n.id}" data-nav="${n.id}" class="${current?.id === n.id ? 'active' : ''}">
      ${icon(n.icon)}<span>${esc(n.label)}</span>${count !== '' ? `<span class="count">${esc(count)}</span>` : ''}</a>`;
  }).join('');
}

// Organização ativa (com troca, para quem tem mais de uma) e quem está conectado.
function renderAccount() {
  const me = state.me;
  const orgs = me?.organizations || [];
  const canSwitch = orgs.length > 1 || me?.user.platformAdmin;
  const btn = $('#btn-org');
  btn.hidden = !me?.org;
  btn.disabled = !canSwitch;
  btn.style.cursor = canSwitch ? '' : 'default';
  btn.title = canSwitch ? 'Trocar de organização' : '';
  btn.innerHTML = me?.org ? `${icon('building-2')}<span class="grow"><span class="org-label">Organização</span>
    <span class="org-name">${esc(me.org.name)}</span></span>${canSwitch ? icon('chevrons-up-down', 'icon-sm') : ''}` : '';
  $('#user-box').innerHTML = me ? `<div class="user-name">${esc(me.user.name || me.user.email)}</div>
    <div class="user-meta">${esc(ROLE_LABELS[me.role] || '')}${me.user.platformAdmin ? ' · equipe da plataforma' : ''}</div>` : '';
}

async function switchOrg(orgId) {
  if (orgId === state.me?.org?.id) return;
  if (current?.view.canLeave && !(await current.view.canLeave())) return;
  try {
    await api('/organizations/switch', { method: 'POST', body: { orgId } });
    current?.controller.abort();
    current?.view.leave?.();
    current = null;
    location.hash = 'overview';
    await enterApp();
    toast(`Organização: ${state.me.org.name}`);
  } catch (err) { toastError(err); }
}

async function newOrganization() {
  const name = await promptDialog({ title: 'Nova organização', label: 'Nome do cliente', placeholder: 'Ex.: Padaria Central', submitText: 'Criar' });
  if (!name) return;
  try {
    const org = await api('/organizations', { method: 'POST', body: { name } });
    await switchOrg(org.id);
    toast('Organização criada. Cadastre o responsável do cliente em Usuários.');
  } catch (err) { toastError(err); }
}

$('#btn-org').addEventListener('click', (e) => {
  const me = state.me;
  const items = (me?.organizations || []).map((o) => ({
    label: o.name,
    icon: o.id === me.org?.id ? 'check' : 'building-2',
    onClick: () => switchOrg(o.id)
  }));
  if (me?.user.platformAdmin) items.push('-', { label: 'Nova organização…', icon: 'plus', onClick: newOrganization });
  openMenu(e.currentTarget, items);
});

function renderBanners() {
  const parts = [];
  if (state.me && !state.me.org) {
    parts.push(`<div class="banner banner-warn">${icon('building-2')}
      <span class="grow">Nenhuma organização ativa. Crie uma ou escolha na barra lateral.</span></div>`);
  }
  if (socketDown) {
    parts.push(`<div class="banner banner-warn">${icon('wifi-off')}
      <span class="grow">Conexão em tempo real perdida — reconectando. Os dados podem estar desatualizados.</span></div>`);
  }
  $('#banners').innerHTML = parts.join('');
}

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
  if (!ROUTES[id] || (ROUTES[id].permission && !can(ROUTES[id].permission))) id = 'overview';
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
  if (keys.has('me')) renderBanners();
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

// ---------- boot ----------
async function enterApp() {
  state.me = await api('/me');
  if (state.me.user.mustChangePassword) {
    showEntry('#temp-password-view');
    return;
  }
  applyBranding(state.me.branding || {});
  for (const v of ENTRY_VIEWS) $(v).hidden = true;
  $('#app').hidden = false;
  renderAccount();
  $('#btn-logout').innerHTML = `${icon('log-out')}<span>Sair</span>`;
  $('#menu-toggle').innerHTML = icon('menu');
  connectSocket();
  await loadAll();
  renderBanners();
  current = null;
  navigate(location.hash.slice(1) || 'overview');
}

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
  try {
    const setup = await api('/setup');
    if (setup.needed) {
      session.clear();
      return showSetup(setup.legacy);
    }
  } catch { /* servidor fora do ar: o login mostra o erro ao tentar */ }
  if (session.token) {
    try {
      await enterApp();
      return;
    } catch { /* token inválido → login */ }
  }
  showLogin();
})();
