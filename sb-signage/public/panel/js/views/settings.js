// Configurações: aparência/marca (com prévia), conta e informações do sistema.
import { api, session, uploadWithProgress } from '../api.js';
import { state, load } from '../state.js';
import { esc, icon, toast, toastError, applyAccent, applyTheme, applyDensity, brandHtml, fmtSize, plural } from '../ui.js';

const SWATCHES = ['#ffd60a', '#ff7a00', '#ff3b5c', '#e040fb', '#7c5cff', '#2f80ed', '#00b8d9', '#00c853', '#111827'];
let draft = null; // edição de aparência ainda não salva

function startDraft() {
  const s = state.settings;
  draft = { brandName: s.brandName, accent: s.accent, theme: s.theme, density: s.density };
}

// Aplica o rascunho ao vivo no painel (desfeito se o usuário sair sem salvar).
function previewDraft() {
  applyAccent(draft.accent);
  applyTheme(draft.theme);
  applyDensity(draft.density);
}
function restoreSaved() {
  const s = state.settings;
  applyAccent(s.accent);
  applyTheme(s.theme);
  applyDensity(s.density);
}

const dirty = () => draft && ['brandName', 'accent', 'theme', 'density'].some((k) => draft[k] !== state.settings[k]);

function appearanceCard() {
  const s = state.settings;
  return `<section class="card">
    <div class="card-head"><h2>${icon('palette')} Aparência e marca</h2>
      ${dirty() ? '<span class="badge badge-warn">não salvo</span>' : ''}</div>
    <div class="card-body form-stack">
      <label class="field"><span>Nome exibido</span>
        <input data-key="brandName" value="${esc(draft.brandName)}" maxlength="60" />
        <span class="field-hint">Aparece no painel, na tela de login e na TV durante o pareamento.</span></label>

      <div class="field"><span class="field-label">Logo</span>
        <div class="logo-box">
          <div class="logo-slot">${s.logoUrl ? `<img src="${esc(s.logoUrl)}" alt="Logo atual" />` : `<span class="subtle small">sem logo</span>`}</div>
          <button class="btn" type="button" data-act="logo-upload">${icon('upload')}${s.logoUrl ? 'Trocar' : 'Enviar'} logo</button>
          ${s.logoUrl ? `<button class="btn btn-ghost" type="button" data-act="logo-remove">Remover</button>` : ''}
        </div>
        <span class="field-hint">PNG, SVG, WEBP ou JPG até 2 MB. Prefira fundo transparente.</span></div>

      <div class="field"><span class="field-label">Cor de destaque</span>
        <div class="swatches">
          ${SWATCHES.map((c) => `<button type="button" class="swatch ${draft.accent === c ? 'active' : ''}" style="background:${c}" data-accent="${c}" aria-label="Cor ${c}"></button>`).join('')}
          <input type="color" value="${esc(draft.accent)}" data-key="accent" aria-label="Cor personalizada" />
          <code>${esc(draft.accent)}</code>
        </div></div>

      <div class="form-grid">
        <div class="field"><span class="field-label">Tema padrão</span>
          <div class="segmented">${[['dark', 'Escuro', 'moon'], ['light', 'Claro', 'sun'], ['system', 'Do sistema', 'sun-moon']].map(([k, l, i]) =>
            `<button type="button" data-theme-opt="${k}" class="${draft.theme === k ? 'active' : ''}">${icon(i, 'icon-sm')}${l}</button>`).join('')}</div></div>
        <div class="field"><span class="field-label">Densidade</span>
          <div class="segmented">${[['comfortable', 'Confortável'], ['compact', 'Compacta']].map(([k, l]) =>
            `<button type="button" data-density-opt="${k}" class="${draft.density === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
      </div>

      <div class="row">
        <span class="grow subtle small">O botão de sol/lua no topo troca o tema só para você, neste navegador.</span>
        ${dirty() ? '<button class="btn btn-ghost" type="button" data-act="discard">Descartar</button>' : ''}
        <button class="btn btn-primary" type="button" data-act="save-appearance" ${dirty() ? '' : 'disabled'}>${icon('save')}Salvar aparência</button>
      </div>
    </div>
  </section>`;
}

function previewCard() {
  const fake = { ...state.settings, ...draft };
  return `<section class="card">
    <div class="card-head"><h2>${icon('tv')} Como aparece na TV</h2></div>
    <div class="card-body">
      <div class="preview-box">
        <div class="preview-screen">
          <div>
            <div style="margin-bottom:10px;color:#9a9aa2">${fake.logoUrl ? `<img src="${esc(fake.logoUrl)}" alt="" style="max-height:40px;max-width:60%" />` : `▶ <b style="color:${esc(fake.accent)}" data-preview-name>${esc(fake.brandName)}</b>`}</div>
            <div class="code" style="color:${esc(fake.accent)}">A7K2QF</div>
            <div class="small" style="margin-top:8px">Acesse o painel e vincule esta tela com o código acima.</div>
          </div>
        </div>
      </div>
      <p class="small subtle" style="margin-top:10px">Tela de pareamento do player. A mesma marca aparece no painel e no login.</p>
    </div>
  </section>`;
}

function accountCard() {
  return `<section class="card">
    <div class="card-head"><h2>${icon('key-round')} Senha do administrador</h2>
      ${state.me?.defaultPassword ? '<span class="badge badge-warn">senha padrão</span>' : '<span class="badge badge-ok">personalizada</span>'}</div>
    <form class="card-body form-stack" data-form="password">
      <div class="form-grid">
        <label class="field"><span>Senha atual</span><input name="current" type="password" autocomplete="current-password" required /></label>
        <label class="field"><span>Nova senha</span><input name="next" type="password" minlength="8" autocomplete="new-password" required /></label>
        <label class="field"><span>Confirmar nova senha</span><input name="confirm" type="password" minlength="8" autocomplete="new-password" required /></label>
      </div>
      <p class="error-text" data-pw-error hidden></p>
      <div class="row"><span class="grow subtle small">Mínimo de 8 caracteres. Todas as outras sessões abertas são encerradas.</span>
        <button class="btn btn-primary" type="submit">Trocar senha</button></div>
    </form>
  </section>`;
}

function systemCard() {
  const o = state.overview || {};
  const playerUrl = `${location.origin}/player`;
  return `<section class="card">
    <div class="card-head"><h2>${icon('server')} Sistema</h2></div>
    <div class="list">
      <div class="list-item"><span class="grow">Endereço do player (abra na TV)</span>
        <code>${esc(playerUrl)}</code><button class="btn btn-ghost btn-icon btn-sm" type="button" data-copy="${esc(playerUrl)}" aria-label="Copiar">${icon('copy')}</button></div>
      <div class="list-item"><span class="grow">Fuso horário da agenda</span><b>${esc(o.timezone || '—')}</b></div>
      <div class="list-item"><span class="grow">Mídia armazenada</span><b>${fmtSize(o.media?.bytes) || '0 KB'}</b></div>
      <div class="list-item"><span class="grow">Fila de processamento</span><b>${plural(o.transcodeQueue || 0, 'item', 'itens')}</b></div>
      <div class="list-item"><span class="grow">Versão</span><b>SB Mídias ${esc(o.version || '')} · Node ${esc(o.node || '')}</b></div>
    </div>
  </section>`;
}

export default {
  title: 'Configurações',
  subtitle: () => 'Marca, aparência, acesso e sistema',
  // sem 'overview': ela recarrega a cada status de tela e redesenharia o formulário enquanto você digita
  deps: ['me'],
  isDirty: () => !!dirty(),
  canLeave: () => true,
  leave() {
    if (dirty()) restoreSaved();
    draft = null;
  },

  enter(root, { signal, rerender }) {
    startDraft();
    load('overview').then(rerender).catch(() => {}); // dados do card "Sistema"

    const logoInput = document.createElement('input');
    logoInput.type = 'file';
    logoInput.accept = '.png,.jpg,.jpeg,.webp,.svg';
    logoInput.addEventListener('change', async () => {
      const file = logoInput.files[0];
      logoInput.value = '';
      if (!file) return;
      const fd = new FormData();
      fd.append('logo', file);
      try {
        const branding = await uploadWithProgress('/settings/logo', fd);
        state.settings = { ...state.settings, ...branding };
        document.querySelectorAll('[data-brand]').forEach((el) => { el.innerHTML = brandHtml(state.settings); });
        toast('Logo atualizada.');
        rerender();
      } catch (err) { toastError(err); }
    }, { signal });

    root.addEventListener('input', (e) => {
      const k = e.target.dataset.key;
      if (k === 'brandName') {
        draft.brandName = e.target.value;
        const name = root.querySelector('[data-preview-name]');
        if (name) name.textContent = draft.brandName;
        const save = root.querySelector('[data-act="save-appearance"]');
        if (save) save.disabled = !dirty();
      } else if (k === 'accent') {
        draft.accent = e.target.value;
        previewDraft();
        rerender();
      }
    }, { signal });

    root.addEventListener('click', async (e) => {
      const sw = e.target.closest('[data-accent]');
      if (sw) { draft.accent = sw.dataset.accent; previewDraft(); return rerender(); }
      const th = e.target.closest('[data-theme-opt]');
      if (th) { draft.theme = th.dataset.themeOpt; previewDraft(); return rerender(); }
      const de = e.target.closest('[data-density-opt]');
      if (de) { draft.density = de.dataset.densityOpt; previewDraft(); return rerender(); }
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Endereço copiado.'); } catch { toast(copy.dataset.copy, 'info'); }
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'logo-upload') logoInput.click();
      if (act === 'logo-remove') {
        try {
          const branding = await api('/settings/logo', { method: 'DELETE' });
          state.settings = { ...state.settings, ...branding };
          document.querySelectorAll('[data-brand]').forEach((el) => { el.innerHTML = brandHtml(state.settings); });
          rerender();
        } catch (err) { toastError(err); }
      }
      if (act === 'discard') { startDraft(); restoreSaved(); rerender(); }
      if (act === 'save-appearance') {
        try {
          const branding = await api('/settings', { method: 'PATCH', body: draft });
          state.settings = { ...state.settings, ...branding };
          document.querySelectorAll('[data-brand]').forEach((el) => { el.innerHTML = brandHtml(state.settings); });
          document.title = `${state.settings.brandName} — Painel`;
          startDraft();
          toast('Aparência salva — telas atualizam a marca em segundos.');
          rerender();
        } catch (err) { toastError(err); }
      }
    }, { signal });

    root.addEventListener('submit', async (e) => {
      if (e.target.dataset.form !== 'password') return;
      e.preventDefault();
      const f = e.target;
      const err = f.querySelector('[data-pw-error]');
      err.hidden = true;
      if (f.next.value !== f.confirm.value) {
        err.textContent = 'A confirmação não confere com a nova senha.';
        err.hidden = false;
        return;
      }
      try {
        const r = await api('/account/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
        session.set(r.token);
        f.reset(); // antes do redesenho, que preserva o que estiver digitado
        await load('me');
        toast('Senha alterada. As outras sessões foram encerradas.');
      } catch (error) {
        err.textContent = error.message;
        err.hidden = false;
      }
    }, { signal });
  },

  render(root) {
    if (!draft) startDraft();
    // senhas digitadas sobrevivem a redesenhos (troca de cor, tema etc.)
    const typed = Object.fromEntries([...root.querySelectorAll('[data-form="password"] input')].map((i) => [i.name, i.value]));
    root.innerHTML = `
      <div class="settings-grid">
        <div class="stack">${appearanceCard()}${accountCard()}${systemCard()}</div>
        <div class="stack" style="position:sticky;top:80px">${previewCard()}</div>
      </div>`;
    for (const [name, value] of Object.entries(typed)) {
      const input = root.querySelector(`[data-form="password"] [name="${name}"]`);
      if (input) input.value = value;
    }
  }
};
