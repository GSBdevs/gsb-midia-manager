// Playlists: lista + editor com arrastar-e-soltar, pré-visualização e aviso de alterações não salvas.
import Sortable from '../../vendor/sortable.esm.js';
import { api } from '../api.js';
import { state, load, mediaById, itemsTotal, playlistUsage, thumbUrl } from '../state.js';
import {
  esc, icon, toast, toastError, openDialog, confirmDialog, promptDialog, fmtDur, plural, debounce
} from '../ui.js';

const ui = { search: '', selectedId: null };
let editor = null; // { id, name, items: [{ mediaId, duration }], dirty }
let sortable = null;

function openEditor(p) {
  editor = p ? { id: p.id, name: p.name, items: p.items.map((it) => ({ ...it })), dirty: false } : null;
  ui.selectedId = p?.id || null;
}

async function confirmDiscard() {
  if (!editor?.dirty) return true;
  return confirmDialog({
    title: 'Alterações não salvas',
    message: `A playlist <b>${esc(editor.name)}</b> tem alterações não salvas. Descartar?`,
    confirmText: 'Descartar', danger: true
  });
}

async function save(rerender) {
  if (!editor) return;
  try {
    await api(`/playlists/${editor.id}`, { method: 'PATCH', body: { name: editor.name, items: editor.items } });
    editor.dirty = false;
    await load('playlists');
    toast('Playlist salva — as telas sincronizam em segundos.');
  } catch (err) { toastError(err); }
  rerender();
}

async function createPlaylist(rerender) {
  if (!(await confirmDiscard())) return;
  const name = await promptDialog({ title: 'Nova playlist', label: 'Nome da playlist', placeholder: 'Ex.: Promoções de novembro', submitText: 'Criar' });
  if (!name) return;
  try {
    const p = await api('/playlists', { method: 'POST', body: { name } });
    await load('playlists');
    openEditor(p);
    rerender();
  } catch (err) { toastError(err); }
}

function pickerDialog(rerender) {
  const ready = state.media.filter((m) => m.status === 'ready');
  if (!ready.length) return toast('Nenhuma mídia pronta. Envie arquivos em Mídias.', 'info');
  const selected = new Set();
  let q = '';
  let type = 'all';
  const grid = () => ready
    .filter((m) => (type === 'all' || m.type === type) && (!q || m.name.toLowerCase().includes(q)))
    .map((m) => {
      const thumb = thumbUrl(m);
      return `<div class="card media-card selectable ${selected.has(m.id) ? 'selected' : ''}" data-pick="${m.id}" tabindex="0" role="checkbox" aria-checked="${selected.has(m.id)}">
        <span class="select-mark">${icon('check')}</span>
        <div class="media-thumb" ${thumb ? `style="background-image:url('${esc(thumb)}')"` : ''}>${thumb ? '' : icon(m.type === 'webpage' ? 'globe' : m.type === 'video' ? 'film' : 'image')}
          ${m.duration ? `<span class="duration">${fmtDur(m.duration)}</span>` : ''}</div>
        <div class="media-info"><div class="media-name truncate">${esc(m.name)}</div></div>
      </div>`;
    }).join('') || '<p class="muted">Nada encontrado.</p>';

  return openDialog({
    title: 'Adicionar mídia à playlist',
    wide: true,
    submitText: 'Adicionar',
    body: `
      <div class="toolbar" style="margin:0">
        <label class="input-search">${icon('search')}<input type="search" placeholder="Buscar…" data-pick-search /></label>
        <div class="segmented">${[['all', 'Tudo'], ['video', 'Vídeos'], ['image', 'Imagens'], ['webpage', 'Páginas']]
          .map(([k, l]) => `<button type="button" data-pick-type="${k}" class="${k === 'all' ? 'active' : ''}">${l}</button>`).join('')}</div>
      </div>
      <div class="media-grid" data-pick-grid style="max-height:52vh;overflow:auto;padding:2px">${grid()}</div>`,
    footerLeft: '<span class="muted small" data-pick-count>Nenhuma selecionada</span>',
    onOpen(dlg) {
      const gridEl = dlg.querySelector('[data-pick-grid]');
      const count = dlg.querySelector('[data-pick-count]');
      const refresh = () => {
        gridEl.innerHTML = grid();
        count.textContent = selected.size ? `${plural(selected.size, 'selecionada', 'selecionadas')}` : 'Nenhuma selecionada';
      };
      const toggle = (card) => {
        const id = card.dataset.pick;
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        refresh();
      };
      gridEl.addEventListener('click', (e) => {
        const card = e.target.closest('[data-pick]');
        if (card) toggle(card);
      });
      gridEl.addEventListener('keydown', (e) => {
        const card = e.target.closest('[data-pick]');
        if (card && (e.key === ' ' || e.key === 'Enter')) {
          e.preventDefault();
          toggle(card);
        }
      });
      dlg.querySelector('[data-pick-search]').addEventListener('input', debounce((e) => { q = e.target.value.toLowerCase(); refresh(); }, 120));
      dlg.querySelectorAll('[data-pick-type]').forEach((b) => b.addEventListener('click', () => {
        type = b.dataset.pickType;
        dlg.querySelectorAll('[data-pick-type]').forEach((x) => x.classList.toggle('active', x === b));
        refresh();
      }));
    },
    onSubmit() {
      if (!selected.size) throw new Error('Selecione ao menos uma mídia.');
      for (const id of selected) editor.items.push({ mediaId: id, duration: 10 });
      editor.dirty = true;
      rerender();
    }
  });
}

// Toca a sequência como a TV tocaria (imagens pela duração configurada, vídeos até o fim).
function previewDialog() {
  const items = editor.items.map((it) => ({ it, m: mediaById(it.mediaId) })).filter((x) => x.m?.status === 'ready');
  if (!items.length) return toast('Nada pronto para pré-visualizar.', 'info');
  let i = 0;
  let timer = null;
  return openDialog({
    title: `Pré-visualização — ${editor.name}`,
    wide: true,
    hideSubmit: true,
    cancelText: 'Fechar',
    footerLeft: `<div class="row"><button type="button" class="btn btn-sm" data-prev>${icon('chevron-left')}</button>
      <span class="small muted" data-pos></span><button type="button" class="btn btn-sm" data-next>${icon('chevron-right')}</button></div>`,
    body: '<div class="preview-media" data-stage style="aspect-ratio:16/9"></div><p class="small muted" data-caption></p>',
    onOpen(dlg) {
      const stage = dlg.querySelector('[data-stage]');
      const show = () => {
        clearTimeout(timer);
        if (!dlg.isConnected) return; // diálogo fechado: encerra o ciclo
        const { it, m } = items[i];
        dlg.querySelector('[data-pos]').textContent = `${i + 1} de ${items.length}`;
        dlg.querySelector('[data-caption]').textContent = `${m.name}${m.type === 'video' ? ` · ${fmtDur(m.duration)}` : ` · ${it.duration}s`}`;
        if (m.type === 'video') {
          stage.innerHTML = `<video src="/m/${esc(m.file)}" autoplay muted playsinline></video>`;
          stage.querySelector('video').addEventListener('ended', next);
        } else {
          stage.innerHTML = m.type === 'webpage'
            ? `<iframe src="${esc(m.url)}" sandbox="allow-scripts allow-same-origin" title="${esc(m.name)}"></iframe>`
            : `<img src="/m/${esc(m.file)}" alt="${esc(m.name)}" />`;
          timer = setTimeout(next, (it.duration || 10) * 1000);
        }
      };
      const next = () => { i = (i + 1) % items.length; show(); };
      dlg.querySelector('[data-next]').addEventListener('click', next);
      dlg.querySelector('[data-prev]').addEventListener('click', () => { i = (i - 1 + items.length) % items.length; show(); });
      show();
    }
  });
}

function usageHtml(id) {
  const u = playlistUsage(id);
  const parts = [
    ...u.devices.map((d) => `${icon('monitor', 'icon-sm')} ${esc(d.name)}`),
    ...u.groups.map((g) => `${icon('boxes', 'icon-sm')} grupo ${esc(g.name)}`),
    u.schedules.length && `${icon('calendar-clock', 'icon-sm')} ${plural(u.schedules.length, 'regra de agenda', 'regras de agenda')}`
  ].filter(Boolean);
  return parts.length
    ? `<div class="row row-wrap small muted">Em uso: ${parts.map((p) => `<span class="badge">${p}</span>`).join('')}</div>`
    : '<p class="small subtle">Ainda não está em nenhuma tela, grupo ou agenda.</p>';
}

function itemRow(it, i) {
  const m = mediaById(it.mediaId);
  if (!m) return '';
  const thumb = thumbUrl(m);
  const editable = m.type !== 'video';
  return `<div class="pl-item" data-i="${i}">
    <span class="handle" title="Arrastar para reordenar">${icon('grip-vertical')}</span>
    <span class="pos">${i + 1}</span>
    <div class="thumb" ${thumb ? `style="background-image:url('${esc(thumb)}')"` : ''}>${thumb ? '' : icon(m.type === 'webpage' ? 'globe' : 'image')}</div>
    <div class="truncate"><b>${esc(m.name)}</b>
      <div class="small subtle">${m.type === 'video' ? 'vídeo' : m.type === 'webpage' ? 'página web' : 'imagem'}${m.status !== 'ready' ? ' · <span class="badge badge-warn">processando</span>' : ''}</div></div>
    <div class="duration">${editable
      ? `<input type="number" min="1" max="3600" value="${it.duration}" data-act="dur" data-key="dur-${i}" aria-label="Duração em segundos" /><span class="duration-label">s</span>`
      : `<span title="vídeo toca até o fim">${m.duration ? fmtDur(m.duration) : 'até o fim'}</span>`}</div>
    <button class="btn btn-ghost btn-icon btn-sm" data-act="remove" aria-label="Remover da playlist">${icon('x')}</button>
  </div>`;
}

export default {
  title: 'Playlists',
  subtitle: () => `${plural(state.playlists.length, 'playlist', 'playlists')}`,
  deps: ['playlists', 'media', 'devices', 'groups', 'schedules'],
  actions: () => `<button class="btn btn-primary" data-action="new">${icon('plus')}Nova playlist</button>`,
  isDirty: () => !!editor?.dirty,
  canLeave: () => confirmDiscard(),
  leave() {
    sortable?.destroy();
    sortable = null;
    if (!editor?.dirty) editor = null;
  },

  enter(root, { signal, actions, rerender }) {
    if (!editor && ui.selectedId) openEditor(state.playlists.find((p) => p.id === ui.selectedId));
    if (!editor && state.playlists.length) openEditor(state.playlists[0]);

    actions.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="new"]')) createPlaylist(rerender);
    }, { signal });

    root.addEventListener('input', (e) => {
      if (e.target.dataset.key === 'pl-search') {
        ui.search = e.target.value;
        rerender();
      } else if (e.target.dataset.key === 'pl-name' && editor) {
        editor.name = e.target.value;
        editor.dirty = true;
        root.querySelector('[data-dirty]')?.removeAttribute('hidden');
        root.querySelector('[data-act="save"]')?.removeAttribute('disabled');
      }
    }, { signal });

    root.addEventListener('change', (e) => {
      if (e.target.dataset.act !== 'dur') return;
      const i = +e.target.closest('[data-i]').dataset.i;
      editor.items[i].duration = Math.max(1, Math.min(3600, parseInt(e.target.value, 10) || 10));
      e.target.value = editor.items[i].duration;
      editor.dirty = true;
      // Sem redesenhar a tela: o "change" dispara quando o campo perde o foco, ou seja, no
      // clique em Salvar. Redesenhar ali trocava o botão e o clique se perdia (nada era salvo).
      root.querySelector('[data-dirty]')?.removeAttribute('hidden');
      root.querySelector('[data-act="save"]')?.removeAttribute('disabled');
      const cycle = root.querySelector('[data-cycle]');
      if (cycle) cycle.textContent = `ciclo de ${fmtDur(itemsTotal(editor.items))}`;
    }, { signal });

    root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && editor) {
        e.preventDefault();
        save(rerender);
      }
    }, { signal });

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-action="new"]')) return createPlaylist(rerender);
      const entry = e.target.closest('[data-open]');
      if (entry) {
        if (entry.dataset.open === editor?.id || !(await confirmDiscard())) return;
        openEditor(state.playlists.find((p) => p.id === entry.dataset.open));
        return rerender();
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act || !editor) return;
      if (act === 'remove') {
        editor.items.splice(+e.target.closest('[data-i]').dataset.i, 1);
        editor.dirty = true;
        rerender();
      } else if (act === 'add') pickerDialog(rerender);
      else if (act === 'preview') previewDialog();
      else if (act === 'save') save(rerender);
      else if (act === 'revert') {
        openEditor(state.playlists.find((p) => p.id === editor.id));
        rerender();
      } else if (act === 'duplicate') {
        if (!(await confirmDiscard())) return;
        try {
          const copy = await api(`/playlists/${editor.id}/duplicate`, { method: 'POST' });
          await load('playlists');
          openEditor(copy);
          toast('Playlist duplicada.');
          rerender();
        } catch (err) { toastError(err); }
      } else if (act === 'delete') {
        const u = playlistUsage(editor.id);
        const inUse = u.devices.length + u.groups.length + u.schedules.length;
        const ok = await confirmDialog({
          title: 'Excluir playlist',
          message: `Excluir <b>${esc(editor.name)}</b>?${inUse ? ` Ela está em uso (${[u.devices.length && plural(u.devices.length, 'tela', 'telas'), u.groups.length && plural(u.groups.length, 'grupo', 'grupos'), u.schedules.length && plural(u.schedules.length, 'regra', 'regras')].filter(Boolean).join(', ')}) — essas telas ficarão sem esta programação.` : ''}`,
          confirmText: 'Excluir', danger: true
        });
        if (!ok) return;
        try {
          await api(`/playlists/${editor.id}`, { method: 'DELETE' });
          editor = null;
          ui.selectedId = null;
          await load('playlists');
          if (state.playlists.length) openEditor(state.playlists[0]);
          rerender();
        } catch (err) { toastError(err); }
      }
    }, { signal });
  },

  render(root, { rerender }) {
    sortable?.destroy();
    sortable = null;
    // a playlist aberta foi excluída em outro lugar
    if (editor && !state.playlists.some((p) => p.id === editor.id)) {
      editor = null;
      if (state.playlists.length) openEditor(state.playlists[0]);
    }
    if (!state.playlists.length) {
      root.innerHTML = `<div class="empty">${icon('list-video')}<h3>Nenhuma playlist</h3>
        <p>Uma playlist é a sequência de mídias que a tela repete.</p>
        <button class="btn btn-primary" data-action="new">${icon('plus')}Nova playlist</button></div>`;
      return;
    }
    const q = ui.search.toLowerCase();
    const list = state.playlists.filter((p) => !q || p.name.toLowerCase().includes(q));
    const total = editor ? itemsTotal(editor.items) : 0;

    root.innerHTML = `
      <div class="split">
        <div class="stack">
          <label class="input-search">${icon('search')}<span class="sr-only">Buscar playlists</span>
            <input type="search" placeholder="Buscar playlist…" value="${esc(ui.search)}" data-key="pl-search" style="width:100%" /></label>
          <div class="pl-list">${list.map((p) => `
            <button type="button" class="pl-entry ${p.id === editor?.id ? 'active' : ''}" data-open="${p.id}">
              ${icon('list-video')}
              <span class="grow"><span class="truncate" style="display:block;font-weight:600">${esc(p.name)}</span>
                <span class="meta">${plural(p.items.length, 'item', 'itens')} · ${fmtDur(itemsTotal(p.items))}</span></span>
              ${p.id === editor?.id && editor.dirty ? '<span class="dirty-dot" title="Alterações não salvas"></span>' : ''}
            </button>`).join('') || '<p class="muted small">Nenhuma playlist com esse nome.</p>'}</div>
        </div>

        ${editor ? `<section class="card">
          <div class="card-body stack">
            <div class="editor-head">
              <input class="name" value="${esc(editor.name)}" data-key="pl-name" maxlength="80" aria-label="Nome da playlist" />
              <span class="badge badge-warn" data-dirty ${editor.dirty ? '' : 'hidden'}>não salvo</span>
            </div>
            <div class="row row-wrap">
              <span class="badge">${plural(editor.items.length, 'item', 'itens')}</span>
              <span class="badge badge-accent">${icon('clock')}<span data-cycle>ciclo de ${fmtDur(total)}</span></span>
            </div>
            ${usageHtml(editor.id)}
            <div class="toolbar" style="margin:0">
              <button class="btn" data-act="add">${icon('plus')}Adicionar mídia</button>
              <button class="btn" data-act="preview" ${editor.items.length ? '' : 'disabled'}>${icon('play')}Pré-visualizar</button>
              <span class="spacer"></span>
              <button class="btn btn-ghost btn-icon" data-act="duplicate" title="Duplicar">${icon('copy')}</button>
              <button class="btn btn-ghost btn-icon" data-act="delete" title="Excluir">${icon('trash-2')}</button>
              ${editor.dirty ? `<button class="btn btn-ghost" data-act="revert">Descartar</button>` : ''}
              <button class="btn btn-primary" data-act="save" ${editor.dirty ? '' : 'disabled'} title="Ctrl+S">${icon('save')}Salvar</button>
            </div>
            ${editor.items.length ? `<div class="pl-items" data-sortable>${editor.items.map(itemRow).join('')}</div>`
              : `<div class="empty" style="padding:32px">${icon('images')}<h3>Playlist vazia</h3><p>Adicione vídeos, imagens ou páginas.</p>
                 <button class="btn btn-primary" data-act="add">${icon('plus')}Adicionar mídia</button></div>`}
            <p class="field-hint">Arraste pela alça para reordenar. Imagens e páginas usam a duração em segundos; vídeos tocam até o fim.</p>
          </div>
        </section>` : '<div></div>'}
      </div>`;

    const listEl = root.querySelector('[data-sortable]');
    if (listEl) {
      sortable = Sortable.create(listEl, {
        handle: '.handle',
        animation: 150,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        onEnd: (ev) => {
          if (ev.oldIndex === ev.newIndex) return;
          const [moved] = editor.items.splice(ev.oldIndex, 1);
          editor.items.splice(ev.newIndex, 0, moved);
          editor.dirty = true;
          rerender();
        }
      });
    }
  }
};
