/* SB Signage — painel (SPA vanilla) */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  let authToken = localStorage.getItem('sb_auth') || null;
  let socket = null;
  let state = { devices: [], media: [], playlists: [], schedules: [], groups: [], emergency: null };
  let currentPlaylistId = null;
  let editorItems = []; // itens da playlist em edição (não salvos)

  const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const VIEWS = ['screens', 'groups', 'media', 'playlists', 'schedules', 'reports'];

  // ---------- API ----------
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch('/api' + path, {
        ...opts,
        headers: {
          ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...(authToken ? { 'X-Auth-Token': authToken } : {}),
          ...opts.headers
        }
      });
    } catch {
      throw new Error('sem conexão com o servidor');
    }
    if (res.status === 401 && path !== '/login') {
      logout();
      throw new Error('sessão expirada');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `erro ${res.status}`);
    return data;
  }

  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.toggle('toast-error', kind === 'error');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3200);
  }
  const oops = (err) => toast(err.message, 'error');

  const fmtSize = (b) => {
    if (b == null) return '';
    if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
    return Math.round(b / 1e3) + ' KB';
  };
  // segundos → "m:ss" (ou "h:mm:ss") — ex.: 95 → 1:35
  const fmtDur = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };
  // duração total de itens de playlist (vídeo: duração da mídia; imagem/página: duração configurada)
  const itemsTotal = (items) => items.reduce((sum, it) => {
    const m = state.media.find((x) => x.id === it.mediaId);
    if (!m) return sum;
    return sum + (m.type === 'video' ? (m.duration || 0) : (it.duration || 10));
  }, 0);
  const fmtAgo = (ts) => {
    if (!ts) return 'nunca';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'agora';
    if (s < 3600) return `${Math.round(s / 60)} min atrás`;
    if (s < 86400) return `${Math.round(s / 3600)} h atrás`;
    return `${Math.round(s / 86400)} d atrás`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const TYPE_LABEL = { video: 'vídeo', image: 'imagem', webpage: 'página' };
  const TYPE_ICON = { video: '🎬', image: '🖼', webpage: '🌐' };

  // ---------- auth ----------
  async function login(password) {
    const { token } = await api('/login', { method: 'POST', body: JSON.stringify({ password }) });
    authToken = token;
    localStorage.setItem('sb_auth', token);
    enterApp();
  }

  function logout() {
    authToken = null;
    localStorage.removeItem('sb_auth');
    socket?.disconnect();
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
  }

  async function enterApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    $('#player-url').textContent = `${location.origin}/player`;
    $('#report-date').value = new Date().toISOString().slice(0, 10);
    connectSocket();
    await refreshAll();
    navigate(location.hash.slice(1) || 'screens');
  }

  function connectSocket() {
    socket?.disconnect();
    socket = io({ auth: { role: 'panel', token: authToken } });
    socket.on('devices-changed', () => loadDevices().catch(() => {}));
    socket.on('media-changed', () => loadMedia().catch(() => {}));
    socket.on('playlists-changed', () => loadPlaylists().catch(() => {}));
    socket.on('schedules-changed', () => loadSchedules().catch(() => {}));
    socket.on('groups-changed', () => loadGroups().catch(() => {}));
    socket.on('emergency-changed', () => loadEmergency().catch(() => {}));
    // reconexão: o estado pode ter mudado enquanto o socket esteve fora
    socket.io.on('reconnect', () => refreshAll().catch(() => {}));
  }

  // ---------- navegação ----------
  function navigate(view) {
    if (!VIEWS.includes(view)) view = 'screens';
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${view}`).classList.add('active');
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.nav === view));
    location.hash = view;
    if (view === 'reports') loadReport().catch(oops);
  }
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  $$('.nav-item').forEach((n) => n.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(n.dataset.nav);
  }));

  async function refreshAll() {
    const results = await Promise.allSettled([
      loadDevices(), loadMedia(), loadPlaylists(), loadSchedules(), loadGroups(), loadEmergency()
    ]);
    const fail = results.find((r) => r.status === 'rejected');
    if (fail) oops(fail.reason);
  }

  // ---------- TELAS ----------
  async function loadDevices() {
    state.devices = await api('/devices');
    renderDevices();
    renderScheduleSelectors();
    renderSchedules();
    renderGroups();
  }

  function renderDevices() {
    const list = $('#screens-list');
    const online = state.devices.filter((d) => d.online).length;
    $('#nav-online').textContent = state.devices.length ? `${online}/${state.devices.length}` : '';
    $('#screens-empty').classList.toggle('hidden', state.devices.length > 0);
    list.innerHTML = state.devices.map((dev) => {
      const group = state.groups.find((g) => g.id === dev.groupId);
      const flags = [
        dev.orientation ? `↻ ${dev.orientation}°` : '',
        dev.muted ? '🔇' : (dev.volume ?? 100) < 100 ? `🔉 ${dev.volume}%` : '',
        dev.overlay?.ticker || dev.overlay?.showClock ? '▭ rodapé' : '',
        dev.powerSchedule ? `⏻ ${dev.powerSchedule.on}–${dev.powerSchedule.off}` : ''
      ].filter(Boolean).join(' · ');
      return `
      <div class="card device-card" data-id="${dev.id}">
        <div class="device-head">
          <span class="dot ${dev.online ? 'on' : 'off'}"></span>
          <span class="device-name">${esc(dev.name)}</span>
          <button class="btn btn-sm btn-ghost" data-act="rename" title="Renomear">✎</button>
          <button class="btn btn-sm btn-ghost" data-act="settings" title="Configurar tela">⚙</button>
        </div>
        <div class="device-meta">
          ${dev.online ? '<span class="ok-text">Online</span>' : 'Offline'} · visto ${fmtAgo(dev.lastSeenAt)}
          ${group ? ` · grupo <b>${esc(group.name)}</b>` : ''}
          ${dev.status?.playing ? `<br>Exibindo: ${esc(dev.status.playing)}` : ''}
          ${dev.status?.cached != null ? ` · ${dev.status.cached} em cache` : ''}
          ${flags ? `<br><span class="device-flags">${esc(flags)}</span>` : ''}
        </div>
        <div class="device-row">
          <span class="muted small">Playlist:</span>
          <select data-act="playlist">
            <option value="">${group?.playlistId ? '— herdar do grupo —' : '— nenhuma —'}</option>
            ${state.playlists.map((p) =>
              `<option value="${p.id}" ${dev.playlistId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="device-actions">
          <button class="btn btn-sm" data-act="identify">Identificar</button>
          <button class="btn btn-sm" data-act="reload">Recarregar</button>
          <button class="btn btn-sm" data-act="clear-cache">Limpar cache</button>
          <button class="btn btn-sm btn-danger" data-act="delete">Remover</button>
        </div>
      </div>`;
    }).join('');
  }

  $('#screens-list').addEventListener('click', async (e) => {
    const card = e.target.closest('.device-card');
    const act = e.target.dataset.act;
    if (!card || !act) return;
    const devId = card.dataset.id;
    const dev = state.devices.find((d) => d.id === devId);
    if (!dev) return;
    try {
      if (act === 'rename') {
        const name = prompt('Novo nome da tela:', dev.name);
        if (name) await api(`/devices/${devId}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      } else if (act === 'settings') {
        openDeviceSettings(dev);
      } else if (act === 'delete') {
        if (confirm(`Remover a tela "${dev.name}"? O player voltará à tela de pareamento.`))
          await api(`/devices/${devId}`, { method: 'DELETE' });
      } else if (['identify', 'reload', 'clear-cache'].includes(act)) {
        const r = await api(`/devices/${devId}/command`, { method: 'POST', body: JSON.stringify({ type: act }) });
        toast(r.delivered ? 'Comando enviado.' : 'Tela offline — comando não entregue.');
      }
    } catch (err) { oops(err); }
  });

  $('#screens-list').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'playlist') return;
    const devId = e.target.closest('.device-card').dataset.id;
    try {
      await api(`/devices/${devId}`, { method: 'PATCH', body: JSON.stringify({ playlistId: e.target.value || null }) });
      toast('Playlist atualizada — telas sincronizando.');
    } catch (err) { oops(err); }
  });

  // configurações avançadas da tela
  function openDeviceSettings(dev) {
    const dlg = $('#dlg-device');
    dlg.dataset.deviceId = dev.id;
    $('#dev-title').textContent = dev.name;
    $('#dev-group').innerHTML = `<option value="">— sem grupo —</option>` +
      state.groups.map((g) => `<option value="${g.id}" ${dev.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
    $('#dev-orientation').value = String(dev.orientation || 0);
    $('#dev-volume').value = dev.volume ?? 100;
    $('#dev-volume-val').textContent = `${dev.volume ?? 100}%`;
    $('#dev-muted').checked = !!dev.muted;
    $('#dev-ticker').value = dev.overlay?.ticker || '';
    $('#dev-clock').checked = !!dev.overlay?.showClock;
    const ps = dev.powerSchedule;
    $('#dev-power-enabled').checked = !!ps;
    $('#dev-power-on').value = ps?.on || '08:00';
    $('#dev-power-off').value = ps?.off || '22:00';
    $$('#dev-power-days input').forEach((c) => { c.checked = ps ? ps.days.includes(+c.value) : true; });
    dlg.showModal();
  }

  $('#dev-volume').addEventListener('input', (e) => {
    $('#dev-volume-val').textContent = `${e.target.value}%`;
  });

  $('#dlg-device form').addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const dlg = $('#dlg-device');
    const body = {
      groupId: $('#dev-group').value || null,
      orientation: +$('#dev-orientation').value,
      volume: +$('#dev-volume').value,
      muted: $('#dev-muted').checked,
      overlay: { ticker: $('#dev-ticker').value.trim(), showClock: $('#dev-clock').checked },
      powerSchedule: $('#dev-power-enabled').checked ? {
        on: $('#dev-power-on').value,
        off: $('#dev-power-off').value,
        days: $$('#dev-power-days input:checked').map((c) => +c.value)
      } : null
    };
    try {
      await api(`/devices/${dlg.dataset.deviceId}`, { method: 'PATCH', body: JSON.stringify(body) });
      dlg.close();
      toast('Configurações aplicadas — tela sincronizando.');
    } catch (err) { oops(err); }
  });

  // pareamento
  $('#btn-pair').addEventListener('click', () => {
    $('#pair-code').value = '';
    $('#pair-name').value = '';
    $('#pair-error').classList.add('hidden');
    $('#dlg-pair').showModal();
  });
  $('#dlg-pair form').addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    try {
      await api('/devices/claim', {
        method: 'POST',
        body: JSON.stringify({ code: $('#pair-code').value, name: $('#pair-name').value })
      });
      $('#dlg-pair').close();
      toast('Tela vinculada.');
    } catch (err) {
      $('#pair-error').textContent = err.message;
      $('#pair-error').classList.remove('hidden');
    }
  });

  // ---------- GRUPOS ----------
  async function loadGroups() {
    state.groups = await api('/groups');
    renderGroups();
    renderDevices(); // nome do grupo aparece nos cards
  }

  function renderGroups() {
    const list = $('#groups-list');
    if (!list) return;
    $('#groups-empty').classList.toggle('hidden', state.groups.length > 0);
    list.innerHTML = state.groups.map((g) => {
      const members = state.devices.filter((d) => d.groupId === g.id);
      return `
      <div class="card group-card" data-id="${g.id}">
        <div class="device-head">
          <span class="group-icon">🗃</span>
          <span class="device-name">${esc(g.name)}</span>
          <button class="btn btn-sm btn-ghost" data-act="rename" title="Renomear">✎</button>
        </div>
        <div class="device-meta">${members.length} tela(s): ${members.map((m) => esc(m.name)).join(', ') || '—'}</div>
        <div class="device-row">
          <span class="muted small">Playlist do grupo:</span>
          <select data-act="playlist">
            <option value="">— nenhuma —</option>
            ${state.playlists.map((p) =>
              `<option value="${p.id}" ${g.playlistId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="device-actions">
          <button class="btn btn-sm btn-danger" data-act="delete">Excluir grupo</button>
        </div>
      </div>`;
    }).join('');
  }

  $('#btn-new-group').addEventListener('click', async () => {
    const name = prompt('Nome do grupo:', '');
    if (name === null) return;
    try {
      await api('/groups', { method: 'POST', body: JSON.stringify({ name }) });
      toast('Grupo criado. Vincule telas em ⚙ Configurar tela.');
    } catch (err) { oops(err); }
  });

  $('#groups-list').addEventListener('click', async (e) => {
    const card = e.target.closest('.group-card');
    const act = e.target.dataset.act;
    if (!card || !act) return;
    const g = state.groups.find((x) => x.id === card.dataset.id);
    if (!g) return;
    try {
      if (act === 'rename') {
        const name = prompt('Novo nome do grupo:', g.name);
        if (name) await api(`/groups/${g.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      } else if (act === 'delete') {
        if (confirm(`Excluir o grupo "${g.name}"? As telas continuam pareadas, sem grupo.`))
          await api(`/groups/${g.id}`, { method: 'DELETE' });
      }
    } catch (err) { oops(err); }
  });

  $('#groups-list').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'playlist') return;
    const id = e.target.closest('.group-card').dataset.id;
    try {
      await api(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify({ playlistId: e.target.value || null }) });
      toast('Playlist do grupo atualizada.');
    } catch (err) { oops(err); }
  });

  // ---------- EMERGÊNCIA ----------
  async function loadEmergency() {
    state.emergency = await api('/emergency');
    renderEmergency();
  }

  function renderEmergency() {
    const em = state.emergency;
    const active = !!em?.active;
    $('#emergency-banner').classList.toggle('hidden', !active);
    document.body.classList.toggle('has-emergency', active);
    if (active) {
      const media = em.mediaId ? state.media.find((m) => m.id === em.mediaId) : null;
      $('#emergency-desc').textContent = media ? `mídia: ${media.name}` : `"${em.message}"`;
    }
  }

  $('#btn-emergency').addEventListener('click', () => {
    const ready = state.media.filter((m) => m.status === 'ready');
    $('#em-media').innerHTML = ready.map((m) =>
      `<option value="${m.id}">${TYPE_ICON[m.type] || ''} ${esc(m.name)}</option>`).join('') ||
      '<option value="">(nenhuma mídia pronta)</option>';
    $('#em-message').value = '';
    $('#em-error').classList.add('hidden');
    $('#dlg-emergency').showModal();
  });

  $('#dlg-emergency form').addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const mode = $$('input[name=em-mode]').find((r) => r.checked)?.value;
    const body = mode === 'media'
      ? { mediaId: $('#em-media').value }
      : { message: $('#em-message').value.trim() };
    try {
      await api('/emergency', { method: 'POST', body: JSON.stringify(body) });
      $('#dlg-emergency').close();
      toast('🚨 Emergência ativada em todas as telas.');
    } catch (err) {
      $('#em-error').textContent = err.message;
      $('#em-error').classList.remove('hidden');
    }
  });

  $('#btn-emergency-off').addEventListener('click', async () => {
    try {
      await api('/emergency', { method: 'DELETE' });
      toast('Emergência desativada — telas voltando à programação.');
    } catch (err) { oops(err); }
  });

  // ---------- MÍDIA ----------
  async function loadMedia() {
    state.media = await api('/media');
    renderMedia();
    renderPlaylistList(); // totais das playlists dependem das durações das mídias
    if (currentPlaylistId) renderEditorItems();
  }

  function mediaThumbStyle(m) {
    if (m.thumb) return `style="background-image:url('/thumbs/${m.thumb}?v=${m.id}')"`;
    if (m.status === 'ready' && m.type === 'image') return `style="background-image:url('/m/${m.file}')"`;
    return '';
  }

  function mediaCard(m, extra = '') {
    const showIcon = !(m.thumb || (m.status === 'ready' && m.type === 'image'));
    return `
      <div class="media-card" data-id="${m.id}">
        <div class="media-thumb" ${mediaThumbStyle(m)}>${showIcon ? (TYPE_ICON[m.type] || '🖼') : ''}</div>
        <div class="media-info">
          <div class="media-name" title="${esc(m.name)}">${esc(m.name)}</div>
          <div class="media-sub">
            <span class="badge ${m.type}">${TYPE_LABEL[m.type] || m.type}</span>
            ${m.status === 'processing' ? '<span class="badge processing">processando</span>' : ''}
            ${m.status === 'failed' ? `<span class="badge failed" title="${esc(m.error)}">falhou</span>` : ''}
            ${m.hls ? '<span class="badge hls" title="streaming HLS disponível">hls</span>' : ''}
            ${m.size ? `<span>${fmtSize(m.size)}</span>` : ''}
            ${m.duration ? `<span title="duração">${fmtDur(m.duration)}</span>` : ''}
          </div>
        </div>
        ${extra}
      </div>`;
  }

  function renderMedia() {
    const grid = $('#media-grid');
    const items = [...state.media].sort((a, b) => b.createdAt - a.createdAt);
    grid.innerHTML = items.map((m) => mediaCard(m, '<button class="media-del" title="Excluir">✕</button>')).join('');
  }

  $('#media-grid').addEventListener('click', async (e) => {
    if (!e.target.classList.contains('media-del')) return;
    const id = e.target.closest('.media-card').dataset.id;
    const m = state.media.find((x) => x.id === id);
    if (!m || !confirm(`Excluir "${m.name}"? Ela será removida das playlists.`)) return;
    try { await api(`/media/${id}`, { method: 'DELETE' }); } catch (err) { oops(err); }
  });

  // página web como mídia
  $('#btn-webpage').addEventListener('click', () => {
    $('#webpage-name').value = '';
    $('#webpage-url').value = '';
    $('#webpage-error').classList.add('hidden');
    $('#dlg-webpage').showModal();
  });
  $('#dlg-webpage form').addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    try {
      await api('/media/webpage', {
        method: 'POST',
        body: JSON.stringify({ name: $('#webpage-name').value, url: $('#webpage-url').value })
      });
      $('#dlg-webpage').close();
      toast('Página adicionada às mídias.');
    } catch (err) {
      $('#webpage-error').textContent = err.message;
      $('#webpage-error').classList.remove('hidden');
    }
  });

  // upload
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  dropzone.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') fileInput.click(); });
  fileInput.addEventListener('change', () => { uploadFiles([...fileInput.files]); fileInput.value = ''; });
  ['dragover', 'dragenter'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); dropzone.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); dropzone.classList.remove('drag');
  }));
  dropzone.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));

  function uploadFiles(files) {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    const prog = $('#upload-progress');
    const bar = prog.querySelector('.progress-bar');
    const label = prog.querySelector('.progress-label');
    prog.classList.remove('hidden');

    // XHR para ter progresso de upload (fetch ainda não expõe upload progress)
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media');
    xhr.setRequestHeader('X-Auth-Token', authToken);
    xhr.upload.onprogress = (e) => {
      const pct = e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : 0;
      bar.style.width = pct + '%';
      label.textContent = `Enviando ${files.length} arquivo(s)… ${pct}%`;
    };
    xhr.onload = () => {
      prog.classList.add('hidden');
      bar.style.width = '0';
      if (xhr.status >= 200 && xhr.status < 300) toast('Upload concluído — processando mídia.');
      else {
        let msg = 'Falha no upload.';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* resposta não-JSON */ }
        toast(msg, 'error');
      }
      loadMedia().catch(oops);
    };
    xhr.onerror = () => { prog.classList.add('hidden'); toast('Falha de rede no upload.', 'error'); };
    xhr.send(fd);
  }

  // ---------- PLAYLISTS ----------
  async function loadPlaylists() {
    state.playlists = await api('/playlists');
    renderPlaylistList();
    renderDevices(); // selects de playlist nos cards
    renderGroups();
    renderScheduleSelectors();
    if (currentPlaylistId && !state.playlists.some((p) => p.id === currentPlaylistId)) {
      currentPlaylistId = null;
      $('#playlist-editor').classList.add('hidden');
    }
  }

  function renderPlaylistList() {
    const list = $('#playlists-list');
    $('#playlists-empty').classList.toggle('hidden', state.playlists.length > 0);
    list.innerHTML = state.playlists.map((p) => `
      <div class="playlist-entry ${p.id === currentPlaylistId ? 'active' : ''}" data-id="${p.id}">
        <span>${esc(p.name)}</span>
        <span class="muted" title="itens · duração total">${p.items.length} · ${fmtDur(itemsTotal(p.items))}</span>
      </div>`).join('');
  }

  $('#playlists-list').addEventListener('click', (e) => {
    const entry = e.target.closest('.playlist-entry');
    if (!entry) return;
    openPlaylist(entry.dataset.id);
  });

  function openPlaylist(id) {
    const p = state.playlists.find((x) => x.id === id);
    if (!p) return;
    currentPlaylistId = id;
    editorItems = p.items.map((it) => ({ ...it }));
    $('#playlist-name').value = p.name;
    $('#playlist-editor').classList.remove('hidden');
    renderPlaylistList();
    renderEditorItems();
  }

  function updateEditorTotal() {
    $('#playlist-total').textContent = editorItems.length
      ? `${editorItems.length} item(ns) · duração total ${fmtDur(itemsTotal(editorItems))}`
      : '';
  }

  function renderEditorItems() {
    const wrap = $('#playlist-items');
    updateEditorTotal();
    if (!editorItems.length) {
      wrap.innerHTML = '<p class="muted">Playlist vazia. Clique em <b>+ Adicionar mídia</b>.</p>';
      return;
    }
    wrap.innerHTML = editorItems.map((it, i) => {
      const m = state.media.find((x) => x.id === it.mediaId);
      if (!m) return '';
      const showIcon = !m.thumb;
      return `
      <div class="pl-item" data-i="${i}">
        <div class="pl-thumb" ${mediaThumbStyle(m)}>${showIcon ? (TYPE_ICON[m.type] || '🖼') : ''}</div>
        <div class="pl-name">${esc(m.name)} ${m.status !== 'ready' ? '<span class="badge processing">processando</span>' : ''}</div>
        <div class="pl-duration">
          ${m.type === 'video'
            ? `<span title="vídeo toca até o fim">${m.duration ? fmtDur(m.duration) : 'até o fim'}</span>`
            : `<input type="number" min="1" max="3600" value="${it.duration}" data-act="dur" /> s`}
        </div>
        <div class="pl-actions">
          <button class="btn btn-sm" data-act="up" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="btn btn-sm" data-act="down" ${i === editorItems.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="btn btn-sm btn-danger" data-act="rm">✕</button>
        </div>
      </div>`;
    }).join('');
  }

  $('#playlist-items').addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    const row = e.target.closest('.pl-item');
    if (!act || !row) return;
    const i = +row.dataset.i;
    if (act === 'rm') editorItems.splice(i, 1);
    if (act === 'up' && i > 0) [editorItems[i - 1], editorItems[i]] = [editorItems[i], editorItems[i - 1]];
    if (act === 'down' && i < editorItems.length - 1) [editorItems[i + 1], editorItems[i]] = [editorItems[i], editorItems[i + 1]];
    if (act !== 'dur') renderEditorItems();
  });
  $('#playlist-items').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'dur') return;
    const i = +e.target.closest('.pl-item').dataset.i;
    editorItems[i].duration = Math.max(1, parseInt(e.target.value, 10) || 10);
    updateEditorTotal();
  });

  $('#btn-new-playlist').addEventListener('click', async () => {
    const name = prompt('Nome da playlist:', '');
    if (name === null) return;
    try {
      const p = await api('/playlists', { method: 'POST', body: JSON.stringify({ name }) });
      await loadPlaylists();
      openPlaylist(p.id);
    } catch (err) { oops(err); }
  });

  $('#btn-save-playlist').addEventListener('click', async () => {
    if (!currentPlaylistId) return;
    try {
      await api(`/playlists/${currentPlaylistId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: $('#playlist-name').value, items: editorItems })
      });
      toast('Playlist salva — telas sincronizando.');
    } catch (err) { oops(err); }
  });

  $('#btn-delete-playlist').addEventListener('click', async () => {
    if (!currentPlaylistId) return;
    if (!confirm('Excluir esta playlist?')) return;
    try {
      await api(`/playlists/${currentPlaylistId}`, { method: 'DELETE' });
      currentPlaylistId = null;
      $('#playlist-editor').classList.add('hidden');
    } catch (err) { oops(err); }
  });

  // picker de mídia
  $('#btn-add-items').addEventListener('click', () => {
    const ready = state.media.filter((m) => m.status === 'ready');
    if (!ready.length) return toast('Nenhuma mídia pronta. Envie arquivos na aba Mídias.');
    $('#picker-grid').innerHTML = ready.map((m) => mediaCard(m)).join('');
    $('#dlg-picker').showModal();
  });
  $('#picker-grid').addEventListener('click', (e) => {
    e.target.closest('.media-card')?.classList.toggle('selected');
  });
  $('#picker-cancel').addEventListener('click', () => $('#dlg-picker').close());
  $('#picker-confirm').addEventListener('click', () => {
    $$('#picker-grid .media-card.selected').forEach((card) => {
      editorItems.push({ mediaId: card.dataset.id, duration: 10 });
    });
    $('#dlg-picker').close();
    renderEditorItems();
  });

  // ---------- AGENDA ----------
  async function loadSchedules() {
    state.schedules = await api('/schedules');
    renderSchedules();
  }

  function renderScheduleSelectors() {
    $('#sched-device').innerHTML = state.devices.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    $('#sched-playlist').innerHTML = state.playlists.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  }

  function renderSchedules() {
    const list = $('#schedules-list');
    list.innerHTML = state.schedules.map((s) => {
      const dev = state.devices.find((d) => d.id === s.deviceId);
      const pl = state.playlists.find((p) => p.id === s.playlistId);
      const days = s.days.map((d) => DAY_NAMES[d]).join(', ');
      return `
      <div class="card sched-card" data-id="${s.id}">
        <div class="sched-info">
          <b>${esc(pl?.name || '?')}</b> em <b>${esc(dev?.name || '?')}</b><br>
          <span class="muted">${days} · ${s.start} → ${s.end}${s.priority ? ` · prioridade ${s.priority}` : ''}</span>
        </div>
        <button class="btn btn-sm btn-danger" data-act="rm">Remover</button>
      </div>`;
    }).join('') || '<p class="empty">Nenhuma regra de agenda. As telas exibem sua playlist padrão.</p>';
  }

  $('#schedules-list').addEventListener('click', async (e) => {
    if (e.target.dataset.act !== 'rm') return;
    const id = e.target.closest('.sched-card').dataset.id;
    try { await api(`/schedules/${id}`, { method: 'DELETE' }); } catch (err) { oops(err); }
  });

  $('#btn-add-schedule').addEventListener('click', async () => {
    const days = $$('#sched-days input:checked').map((c) => +c.value);
    try {
      await api('/schedules', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: $('#sched-device').value,
          playlistId: $('#sched-playlist').value,
          days,
          start: $('#sched-start').value,
          end: $('#sched-end').value,
          priority: $('#sched-priority').value
        })
      });
      toast('Regra adicionada.');
    } catch (err) { oops(err); }
  });

  // ---------- RELATÓRIOS ----------
  async function loadReport() {
    const date = $('#report-date').value || new Date().toISOString().slice(0, 10);
    const data = await api(`/logs?date=${date}`);
    const tbody = $('#report-table tbody');
    $('#report-empty').classList.toggle('hidden', data.rows.length > 0);
    $('#report-summary').innerHTML = data.rows.length ? `
      <div class="stat"><b>${data.totalPlays}</b><span>exibições</span></div>
      <div class="stat"><b>${new Set(data.rows.map((r) => r.mediaId)).size}</b><span>mídias</span></div>
      <div class="stat"><b>${new Set(data.rows.map((r) => r.deviceId)).size}</b><span>telas</span></div>
      <div class="stat"><b>${fmtDur(data.rows.reduce((s, r) => s + r.seconds, 0))}</b><span>tempo total</span></div>` : '';
    tbody.innerHTML = data.rows.map((r) => `
      <tr>
        <td>${esc(r.name)}</td>
        <td>${esc(r.deviceName)}</td>
        <td class="num">${r.plays}</td>
        <td class="num">${fmtDur(r.seconds)}</td>
      </tr>`).join('');
  }

  $('#btn-report-refresh').addEventListener('click', () => loadReport().catch(oops));
  $('#report-date').addEventListener('change', () => loadReport().catch(oops));

  $('#btn-report-csv').addEventListener('click', async () => {
    const date = $('#report-date').value || new Date().toISOString().slice(0, 10);
    try {
      const res = await fetch(`/api/logs.csv?date=${date}`, { headers: { 'X-Auth-Token': authToken } });
      if (!res.ok) throw new Error('falha ao gerar CSV');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `proof-of-play-${date}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { oops(err); }
  });

  // ---------- boot ----------
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await login($('#login-password').value);
    } catch (err) {
      $('#login-error').textContent = err.message || 'Senha incorreta.';
      $('#login-error').classList.remove('hidden');
    }
  });
  $('#logout').addEventListener('click', logout);

  (async () => {
    if (authToken) {
      try {
        await api('/me');
        return enterApp();
      } catch { /* token inválido → login */ }
    }
    $('#login-view').classList.remove('hidden');
  })();
})();
