// Biblioteca de mídia: envio, busca/filtros, grade ou lista, pré-visualização.
import { api, uploadWithProgress } from '../api.js';
import { state, load, mediaUsage, thumbUrl } from '../state.js';
import {
  esc, icon, toast, toastError, openDialog, confirmDialog, promptDialog, openMenu, fmtSize, fmtDur, fmtAgo, plural
} from '../ui.js';

const ACCEPT = '.jpg,.jpeg,.png,.gif,.webp,.avif,.bmp,.svg,.mp4,.m4v,.webm,.mov,.mkv,.avi,.wmv,.flv,.mpg,.mpeg,.3gp,.vob,.ts,.mts,.m2ts,.ogv,.rm,.rmvb';
const TYPE = {
  video: { label: 'vídeo', icon: 'film', badge: 'badge-info' },
  image: { label: 'imagem', icon: 'image', badge: 'badge-ok' },
  webpage: { label: 'página', icon: 'globe', badge: 'badge-accent' }
};
const ui = { search: '', type: 'all', sort: 'recent', view: 'grid' };
let upload = null; // { files, progress }

try { ui.view = localStorage.getItem('sb_media_view') || 'grid'; } catch { /* sem armazenamento */ }

function filtered() {
  const q = ui.search.toLowerCase();
  const list = state.media.filter((m) =>
    (ui.type === 'all' || m.type === ui.type || (ui.type === 'failed' && m.status === 'failed')) &&
    (!q || m.name.toLowerCase().includes(q)));
  const sorters = {
    recent: (a, b) => b.createdAt - a.createdAt,
    name: (a, b) => a.name.localeCompare(b.name, 'pt-BR'),
    size: (a, b) => (b.size || 0) - (a.size || 0),
    duration: (a, b) => (b.duration || 0) - (a.duration || 0)
  };
  return list.sort(sorters[ui.sort]);
}

function statusBadges(m) {
  if (m.status === 'processing') return `<span class="badge badge-warn pulse">${icon('loader-circle', 'spin')}processando</span>`;
  if (m.status === 'failed') return `<span class="badge badge-danger" title="${esc(m.error)}">${icon('circle-alert')}falhou</span>`;
  return '';
}

function card(m) {
  const t = TYPE[m.type] || TYPE.image;
  const thumb = thumbUrl(m);
  const uses = mediaUsage(m.id).length;
  return `<article class="card media-card" data-id="${m.id}">
    <div class="media-thumb" ${thumb ? `style="background-image:url('${esc(thumb)}')"` : ''}>
      ${thumb ? '' : icon(t.icon)}
      ${m.duration ? `<span class="duration">${fmtDur(m.duration)}</span>` : ''}
      ${m.status === 'ready' ? `<button class="play-hint" data-act="preview" aria-label="Pré-visualizar ${esc(m.name)}">${icon(m.type === 'video' ? 'play' : 'eye')}</button>` : ''}
    </div>
    <div class="media-menu"><button class="btn btn-icon btn-sm" data-menu data-act="menu" aria-label="Ações">${icon('ellipsis-vertical')}</button></div>
    <div class="media-info">
      <div class="media-name truncate" title="${esc(m.name)}">${esc(m.name)}</div>
      <div class="media-sub">
        <span class="badge ${t.badge}">${t.label}</span>${statusBadges(m)}
        ${m.size ? `<span>${fmtSize(m.size)}</span>` : ''}
        ${m.width ? `<span>${m.width}×${m.height}</span>` : ''}
      </div>
      <div class="media-sub">${uses ? `em ${plural(uses, 'playlist', 'playlists')}` : 'não usada'} · ${fmtAgo(m.createdAt)}</div>
    </div>
  </article>`;
}

function row(m) {
  const t = TYPE[m.type] || TYPE.image;
  const thumb = thumbUrl(m);
  return `<tr data-id="${m.id}">
    <td><div class="thumb-mini" ${thumb ? `style="background-image:url('${esc(thumb)}')"` : ''}>${thumb ? '' : icon(t.icon)}</div></td>
    <td><div class="truncate" style="max-width:340px" title="${esc(m.name)}"><b>${esc(m.name)}</b></div>
      <div class="row small subtle">${statusBadges(m)}${m.status === 'failed' ? esc(m.error || '') : ''}</div></td>
    <td><span class="badge ${t.badge}">${t.label}</span></td>
    <td class="nowrap">${m.duration ? fmtDur(m.duration) : '—'}</td>
    <td class="nowrap">${m.width ? `${m.width}×${m.height}` : '—'}</td>
    <td class="nowrap">${m.size ? fmtSize(m.size) : '—'}</td>
    <td>${mediaUsage(m.id).length || '—'}</td>
    <td class="nowrap"><button class="btn btn-ghost btn-icon btn-sm" data-act="preview" ${m.status === 'ready' ? '' : 'disabled'} aria-label="Pré-visualizar">${icon('eye')}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-menu data-act="menu" aria-label="Ações">${icon('ellipsis-vertical')}</button></td>
  </tr>`;
}

export function previewMedia(m) {
  let content;
  if (m.type === 'video') content = `<video src="/m/${esc(m.file)}" controls autoplay playsinline></video>`;
  else if (m.type === 'webpage') content = `<iframe src="${esc(m.url)}" sandbox="allow-scripts allow-same-origin" title="${esc(m.name)}"></iframe>`;
  else content = `<img src="/m/${esc(m.file)}" alt="${esc(m.name)}" />`;
  const facts = [
    m.width && `${m.width}×${m.height}`, m.duration && fmtDur(m.duration), m.size && fmtSize(m.size),
    m.transcodeReasons?.length ? `convertida para a tela (${m.transcodeReasons.join(', ')})` : m.type === 'video' ? 'arquivo original, sem conversão' : null,
    m.hls && 'streaming HLS disponível', m.type === 'webpage' && m.url
  ].filter(Boolean);
  return openDialog({
    title: m.name,
    wide: true,
    hideSubmit: true,
    cancelText: 'Fechar',
    body: `<div class="preview-media">${content}</div><p class="small muted">${facts.map(esc).join(' · ')}</p>`
  });
}

async function uploadFiles(files, rerender) {
  if (!files.length) return;
  if (files.length > 20) return toast('Envie no máximo 20 arquivos por vez.', 'warn');
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  upload = { count: files.length, progress: 0 };
  rerender();
  try {
    const r = await uploadWithProgress('/media', fd, (p) => {
      upload.progress = p ?? 0;
      const bar = document.querySelector('[data-upload-bar]');
      if (bar) bar.style.width = `${Math.round(upload.progress * 100)}%`;
      const lbl = document.querySelector('[data-upload-label]');
      if (lbl) lbl.textContent = `Enviando ${plural(upload.count, 'arquivo', 'arquivos')}… ${Math.round(upload.progress * 100)}%`;
    });
    toast(`${plural(r.created.length, 'arquivo enviado', 'arquivos enviados')} — processando para a tela.`);
    if (r.rejected?.length) toast(`Formato não suportado: ${r.rejected.join(', ')}`, 'warn');
  } catch (err) {
    toastError(err.data?.rejected?.length ? new Error(`Formato não suportado: ${err.data.rejected.join(', ')}`) : err);
  } finally {
    upload = null;
    load('media').catch(() => {});
    rerender();
  }
}

async function webpageDialog() {
  await openDialog({
    title: 'Adicionar página web',
    submitText: 'Adicionar',
    body: `
      <p class="muted">Dashboards, cardápios, feeds… A tela precisa de internet para exibir. Alguns sites bloqueiam a exibição embutida.</p>
      <label class="field"><span>Endereço</span><input name="url" type="url" placeholder="https://…" required autofocus /></label>
      <label class="field"><span>Nome</span><input name="name" maxlength="200" placeholder="Ex.: Cardápio digital" /></label>`,
    async onSubmit(form) {
      await api('/media/webpage', { method: 'POST', body: { url: form.url.value, name: form.name.value } });
      toast('Página adicionada às mídias.');
    }
  });
}

function menuFor(btn, m) {
  const uses = mediaUsage(m.id);
  openMenu(btn, [
    ...(m.status === 'ready' ? [{ icon: 'eye', label: 'Pré-visualizar', onClick: () => previewMedia(m) }] : []),
    { icon: 'pencil', label: 'Renomear', onClick: async () => {
      const name = await promptDialog({ title: 'Renomear mídia', label: 'Nome', value: m.name, maxlength: 200 });
      if (name) await api(`/media/${m.id}`, { method: 'PATCH', body: { name } }).catch(toastError);
    } },
    ...(m.file ? [{ icon: 'download', label: 'Baixar arquivo', onClick: () => window.open(`/m/${m.file}`, '_blank', 'noopener') }] : []),
    '-',
    { icon: 'trash-2', label: 'Excluir', danger: true, onClick: async () => {
      const ok = await confirmDialog({
        title: 'Excluir mídia',
        message: `Excluir <b>${esc(m.name)}</b>?${uses.length ? ` Ela sai de ${uses.length === 1 ? 'uma playlist' : `${uses.length} playlists`}: ${uses.map((p) => esc(p.name)).join(', ')}.` : ''}`,
        confirmText: 'Excluir', danger: true
      });
      if (ok) await api(`/media/${m.id}`, { method: 'DELETE' }).catch(toastError);
    } }
  ]);
}

export default {
  title: 'Mídias',
  subtitle: () => {
    const bytes = state.media.reduce((s, m) => s + (m.size || 0), 0);
    return `${plural(state.media.length, 'item', 'itens')} · ${fmtSize(bytes) || '0 KB'}`;
  },
  deps: ['media', 'playlists'],
  actions: () => `
    <button class="btn" data-action="webpage">${icon('globe')}Página web</button>
    <button class="btn btn-primary" data-action="upload">${icon('upload')}Enviar arquivos</button>`,

  enter(root, { signal, actions, rerender }) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ACCEPT;
    input.addEventListener('change', () => {
      uploadFiles([...input.files], rerender);
      input.value = '';
    }, { signal });

    actions.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="upload"]')) input.click();
      if (e.target.closest('[data-action="webpage"]')) webpageDialog();
    }, { signal });

    root.addEventListener('input', (e) => {
      if (e.target.dataset.key === 'media-search') {
        ui.search = e.target.value;
        rerender();
      }
    }, { signal });
    root.addEventListener('change', (e) => {
      if (e.target.dataset.key === 'media-sort') {
        ui.sort = e.target.value;
        rerender();
      }
    }, { signal });

    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-dropzone]')) return input.click();
      const t = e.target.closest('[data-type]');
      if (t) { ui.type = t.dataset.type; return rerender(); }
      const v = e.target.closest('[data-view]');
      if (v) {
        ui.view = v.dataset.view;
        try { localStorage.setItem('sb_media_view', ui.view); } catch { /* sem armazenamento */ }
        return rerender();
      }
      const btn = e.target.closest('[data-act]');
      const host = e.target.closest('[data-id]');
      if (!btn || !host) return;
      const m = state.media.find((x) => x.id === host.dataset.id);
      if (!m) return;
      if (btn.dataset.act === 'preview') previewMedia(m);
      if (btn.dataset.act === 'menu') menuFor(btn, m);
    }, { signal });

    root.addEventListener('keydown', (e) => {
      if (e.target.matches('[data-dropzone]') && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        input.click();
      }
    }, { signal });

    // arrastar arquivos em qualquer ponto da tela de mídias
    let depth = 0;
    root.addEventListener('dragenter', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      depth++;
      root.querySelector('[data-dropzone]')?.classList.add('drag');
    }, { signal });
    root.addEventListener('dragover', (e) => e.preventDefault(), { signal });
    root.addEventListener('dragleave', () => {
      if (--depth <= 0) root.querySelector('[data-dropzone]')?.classList.remove('drag');
    }, { signal });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      root.querySelector('[data-dropzone]')?.classList.remove('drag');
      uploadFiles([...(e.dataTransfer?.files || [])], rerender);
    }, { signal });
  },

  render(root) {
    const list = filtered();
    const counts = {
      all: state.media.length,
      video: state.media.filter((m) => m.type === 'video').length,
      image: state.media.filter((m) => m.type === 'image').length,
      webpage: state.media.filter((m) => m.type === 'webpage').length,
      failed: state.media.filter((m) => m.status === 'failed').length
    };
    const tabs = [['all', 'Tudo'], ['video', 'Vídeos'], ['image', 'Imagens'], ['webpage', 'Páginas']];
    if (counts.failed) tabs.push(['failed', 'Com falha']);

    root.innerHTML = `
      ${upload ? `<div class="card card-pad" style="margin-bottom:16px">
          <div class="row" style="margin-bottom:8px">${icon('upload')}<b data-upload-label>Enviando ${plural(upload.count, 'arquivo', 'arquivos')}… ${Math.round(upload.progress * 100)}%</b></div>
          <div class="progress"><i data-upload-bar style="width:${Math.round(upload.progress * 100)}%"></i></div></div>`
        : `<div class="dropzone" data-dropzone role="button" tabindex="0">
          ${icon('upload')}
          <div><b>Arraste arquivos para cá</b> ou clique para escolher
            <div class="small subtle">Imagens (JPG, PNG, GIF, WEBP, AVIF, BMP, SVG) e vídeos em qualquer formato comum — o servidor converte para o padrão da tela (H.264, até 1080p ou 1080×1920 em retrato).</div></div>
        </div>`}
      <div class="toolbar">
        <label class="input-search">${icon('search')}<span class="sr-only">Buscar mídia</span>
          <input type="search" placeholder="Buscar por nome…" value="${esc(ui.search)}" data-key="media-search" /></label>
        <div class="segmented">${tabs.map(([k, l]) =>
          `<button type="button" data-type="${k}" class="${ui.type === k ? 'active' : ''}">${l} <span class="count">${counts[k]}</span></button>`).join('')}</div>
        <span class="spacer"></span>
        <select data-key="media-sort" aria-label="Ordenar">
          ${[['recent', 'Mais recentes'], ['name', 'Nome'], ['size', 'Tamanho'], ['duration', 'Duração']].map(([k, l]) =>
            `<option value="${k}" ${ui.sort === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <div class="segmented" aria-label="Visualização">
          <button type="button" data-view="grid" class="${ui.view === 'grid' ? 'active' : ''}" aria-label="Grade">${icon('layout-grid', 'icon-sm')}</button>
          <button type="button" data-view="list" class="${ui.view === 'list' ? 'active' : ''}" aria-label="Lista">${icon('list', 'icon-sm')}</button>
        </div>
      </div>
      ${!state.media.length ? `<div class="empty">${icon('images')}<h3>Nenhuma mídia ainda</h3><p>Envie vídeos e imagens para montar playlists.</p></div>`
        : !list.length ? `<div class="empty">${icon('search')}<h3>Nada encontrado</h3></div>`
        : ui.view === 'grid' ? `<div class="media-grid">${list.map(card).join('')}</div>`
        : `<div class="card table-wrap"><table class="media-table">
            <thead><tr><th></th><th>Nome</th><th>Tipo</th><th>Duração</th><th>Resolução</th><th>Tamanho</th><th>Playlists</th><th></th></tr></thead>
            <tbody>${list.map(row).join('')}</tbody></table></div>`}`;
  }
};
