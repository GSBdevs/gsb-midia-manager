// Componentes de interface reutilizáveis: ícones, formatação, toasts, diálogos, menus, tema.
import { ICONS } from './icons.js';

// ---------- texto ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export const fmtSize = (b) => {
  if (b == null) return '';
  if (b >= 1e9) return (b / 1e9).toFixed(1).replace('.', ',') + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1).replace('.', ',') + ' MB';
  return Math.max(1, Math.round(b / 1e3)) + ' KB';
};

// segundos → "m:ss" ou "h:mm:ss"
export const fmtDur = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

// segundos → "2 h 15 min" (para totais grandes)
export const fmtLong = (s) => {
  s = Math.round(s || 0);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
};

export const fmtAgo = (ts) => {
  if (!ts) return 'nunca';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
};

export const fmtNum = (n) => new Intl.NumberFormat('pt-BR').format(n || 0);
export const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- toasts ----------
export function toast(message, kind = 'ok') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const iconName = { ok: 'circle-check', error: 'circle-x', warn: 'triangle-alert', info: 'info' }[kind] || 'info';
  el.innerHTML = `${icon(iconName)}<span>${esc(message)}</span>`;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, kind === 'error' ? 5000 : 3200);
}
export const toastError = (err) => toast(err?.message || String(err), 'error');

// ---------- diálogos ----------
// Diálogo genérico. body é HTML; onSubmit recebe (form, dialog) e pode lançar erro (exibido no rodapé).
export function openDialog({ title, body, submitText = 'Salvar', cancelText = 'Cancelar', danger = false,
  wide = false, onOpen, onSubmit, footerLeft = '', hideSubmit = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    if (wide) dlg.classList.add('wide');
    dlg.innerHTML = `
      <form class="dlg" method="dialog" novalidate>
        <div class="dlg-head">
          <h2>${esc(title)}</h2>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Fechar">${icon('x')}</button>
        </div>
        <div class="dlg-body">${body}<p class="error-text" data-error hidden></p></div>
        <div class="dlg-foot">
          ${footerLeft ? `<div class="left">${footerLeft}</div>` : ''}
          <button type="button" class="btn btn-ghost" data-close>${esc(cancelText)}</button>
          ${hideSubmit ? '' : `<button type="submit" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-submit>${esc(submitText)}</button>`}
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const errorEl = dlg.querySelector('[data-error]');
    // Resolve na hora, sem depender do evento 'close' (que é assíncrono e pode não chegar
    // em páginas sem renderização); os eventos nativos só cobrem o fechamento pelo Esc.
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener('cancel', () => close(undefined));
    dlg.addEventListener('close', () => close(undefined));
    dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(undefined)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const submit = dlg.querySelector('[data-submit]');
      errorEl.hidden = true;
      if (submit) submit.disabled = true;
      try {
        const value = onSubmit ? await onSubmit(form, dlg) : true;
        if (value !== false) close(value === undefined ? true : value);
      } catch (err) {
        errorEl.textContent = err?.message || String(err);
        errorEl.hidden = false;
      } finally {
        if (submit) submit.disabled = false;
      }
    });
    dlg.showModal();
    onOpen?.(dlg, close);
    const first = dlg.querySelector('[autofocus], input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea');
    first?.focus();
  });
}

export function confirmDialog({ title, message, confirmText = 'Confirmar', danger = false }) {
  return openDialog({ title, body: `<p>${message}</p>`, submitText: confirmText, danger }).then((v) => v === true);
}

export function promptDialog({ title, label, value = '', placeholder = '', submitText = 'Salvar', maxlength = 80 }) {
  return openDialog({
    title,
    submitText,
    body: `<label class="field"><span>${esc(label)}</span>
      <input name="value" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="${maxlength}" required autofocus /></label>`,
    onSubmit: (form) => form.value.value.trim()
  }).then((v) => (typeof v === 'string' ? v : null));
}

// ---------- menu contextual ----------
let openMenuEl = null;
export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}
export function openMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  items.forEach((item, i) => {
    if (item === '-') {
      menu.appendChild(document.createElement('hr'));
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (item.danger) b.className = 'danger';
    b.innerHTML = `${icon(item.icon || 'chevron-right')}<span>${esc(item.label)}</span>`;
    b.addEventListener('click', () => {
      closeMenu();
      item.onClick();
    });
    b.dataset.index = i;
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
  menu.style.top = `${r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
  openMenuEl = menu;
  menu.querySelector('button')?.focus();
}
document.addEventListener('click', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('[data-menu]')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('resize', closeMenu);

// ---------- tema e marca ----------
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function applyAccent(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  // texto sobre o destaque: preto ou branco, o que tiver mais contraste
  root.style.setProperty('--accent-contrast', luminance(hex) > 0.4 ? '#141414' : '#ffffff');
}

const THEME_KEY = 'sb_theme_override';
const media = window.matchMedia('(prefers-color-scheme: light)');
let orgTheme = 'dark';

export function themeOverride() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}
export function applyTheme(theme = orgTheme) {
  orgTheme = theme;
  const chosen = themeOverride() || theme;
  const effective = chosen === 'system' ? (media.matches ? 'light' : 'dark') : chosen;
  document.documentElement.dataset.theme = effective;
  return effective;
}
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* sem armazenamento */ }
  return applyTheme(orgTheme);
}
media.addEventListener('change', () => applyTheme(orgTheme));

export function applyDensity(density) {
  document.documentElement.dataset.density = density === 'compact' ? 'compact' : 'comfortable';
}

export function brandHtml(settings, { large = false } = {}) {
  const name = settings?.brandName || 'SB Signage';
  if (settings?.logoUrl) {
    return `<img class="brand-logo" src="${esc(settings.logoUrl)}" alt="${esc(name)}" ${large ? 'style="max-height:48px"' : ''} />`;
  }
  return `<span class="brand-mark">${esc(name.trim().charAt(0).toUpperCase() || 'S')}</span><span class="brand-name">${esc(name)}</span>`;
}
