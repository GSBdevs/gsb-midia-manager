/* SB Signage — player web
 * Princípios (do plano técnico):
 *  - Offline-first: o loop principal só exibe o que está 100% no cache local (IndexedDB).
 *    Exceções conscientes: HLS (vídeo longo, streaming enquanto o MP4 baixa) e
 *    páginas web — ambos exigem rede e são pulados quando offline.
 *  - Pull é a fonte de verdade (manifesto + ETag); o socket só acelera ("sync").
 *  - Se o realtime cair, o polling garante consistência.
 *  - Relógio e fuso vêm do servidor: TV box costuma ter hora/fuso errados.
 */
(() => {
  const POLL_MS = 60_000;
  const HEARTBEAT_MS = 30_000;
  const PAIR_POLL_MS = 3_000;
  const LOG_FLUSH_MS = 60_000;
  const POWER_CHECK_MS = 30_000;
  const DOWNLOAD_STALL_MS = 30_000;   // download sem receber bytes por 30 s é abortado
  const VIDEO_STALL_MS = 20_000;      // vídeo sem avançar por 20 s é pulado
  const MAX_LOG_BUFFER = 2000;

  const $ = (s) => document.querySelector(s);
  const layers = [$('#layerA'), $('#layerB')];
  let activeLayer = 0;

  let deviceToken = localStorage.getItem('sb_device_token') || null;
  let manifest = null;         // manifesto vigente
  let playable = [];           // itens do manifesto exibíveis agora (cache ou stream)
  let playIndex = -1;
  let advanceTimer = null;
  let stallTimer = null;
  let socket = null;
  let offline = false;
  let booted = false;
  let syncRun = 0;             // invalida downloads de manifestos antigos
  let syncing = false;
  let downloadAbort = null;
  let itemsSignature = null;   // muda só quando a lista de itens muda
  let clockOffset = 0;         // hora do servidor − hora local (ms)
  let settings = { orientation: 0, volume: 100, muted: false, overlay: { ticker: '', showClock: false }, powerSchedule: null, timezone: null };
  let emergencyShowing = false;
  let poweredOff = false;
  let clockTimer = null;
  const health = { missing: 0, cacheErrors: 0, lastError: null, storageUsage: null, storageQuota: null, persisted: null };
  let logBuffer = loadLogBuffer(); // proof-of-play pendente de envio (sobrevive a recargas)

  // ---------- IndexedDB (cache de mídia — funciona mesmo em http:// na LAN) ----------
  const idb = {
    db: null,
    open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('sb-signage', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('files');
        req.onsuccess = () => { this.db = req.result; resolve(); };
        req.onerror = () => reject(req.error);
      });
    },
    tx(mode) { return this.db.transaction('files', mode).objectStore('files'); },
    get(key) {
      return new Promise((resolve) => {
        const r = this.tx('readonly').get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    },
    put(key, blob) {
      return new Promise((resolve, reject) => {
        const r = this.tx('readwrite').put(blob, key);
        r.onsuccess = resolve;
        r.onerror = () => reject(r.error);
      });
    },
    keys() {
      return new Promise((resolve) => {
        const r = this.tx('readonly').getAllKeys();
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => resolve([]);
      });
    },
    del(key) {
      return new Promise((resolve) => {
        const r = this.tx('readwrite').delete(key);
        r.onsuccess = resolve;
        r.onerror = resolve;
      });
    },
    async clear() {
      const keys = await this.keys();
      for (const k of keys) await this.del(k);
    }
  };

  // ---------- relógio do servidor ----------
  const now = () => new Date(Date.now() + clockOffset);
  function syncClock(res) {
    const date = Date.parse(res.headers.get('date') || '');
    if (Number.isFinite(date)) clockOffset = date - Date.now();
  }
  // { hhmm, day } no fuso da tela (configurado no servidor); sem fuso, usa o do aparelho
  function localParts(date = now()) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: settings.timezone || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
      }).formatToParts(date).map((p) => [p.type, p.value]));
      const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
      return { hhmm: `${parts.hour}:${parts.minute}`, day };
    } catch {
      return { hhmm: date.toTimeString().slice(0, 5), day: date.getDay() };
    }
  }

  // ---------- UI ----------
  function show(screen) {
    $('#pairing').classList.toggle('show', screen === 'pairing');
    $('#standby').classList.toggle('show', screen === 'standby');
    updateBadges();
  }
  // avisos técnicos só aparecem fora da exibição — nunca por cima de um anúncio
  function idleScreenVisible() {
    return $('#pairing').classList.contains('show') || $('#standby').classList.contains('show');
  }
  let progressText = null;
  function updateBadges() {
    const idle = idleScreenVisible();
    $('#status-badge').style.display = offline && idle ? 'block' : 'none';
    const el = $('#cache-progress');
    el.style.display = progressText && idle ? 'block' : 'none';
    if (progressText) el.textContent = progressText;
  }
  function setOffline(v) {
    offline = v;
    updateBadges();
  }
  function cacheProgress(text) {
    progressText = text;
    updateBadges();
  }

  function applyBranding(b) {
    if (!b) return;
    if (b.accent) document.documentElement.style.setProperty('--accent', b.accent);
    document.title = `${b.brandName || 'SB Signage'} — Player`;
    for (const el of document.querySelectorAll('.brand')) {
      el.textContent = '';
      if (b.logoUrl) {
        const img = document.createElement('img');
        img.src = b.logoUrl;
        img.alt = b.brandName || '';
        el.appendChild(img);
      } else {
        const strong = document.createElement('b');
        strong.textContent = b.brandName || 'SB Signage';
        el.append('▶ ', strong);
      }
    }
  }

  // ---------- pareamento ----------
  let pairTimer = null;
  async function startPairing() {
    clearInterval(pairTimer);
    show('pairing');
    stopPlayback();
    fetch('/api/branding').then((r) => r.json()).then(applyBranding).catch(() => {});
    try {
      const res = await fetch('/api/pair/request', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { code, token } = await res.json();
      $('#pair-code').textContent = code;
      pairTimer = setInterval(async () => {
        try {
          const st = await fetch('/api/pair/status', { headers: { 'X-Device-Token': token } });
          if (st.status === 404) return startPairing(); // código expirou
          const data = await st.json();
          if (data.claimed) {
            clearInterval(pairTimer);
            deviceToken = token;
            localStorage.setItem('sb_device_token', token);
            boot();
          }
        } catch { /* sem rede: continua tentando */ }
      }, PAIR_POLL_MS);
    } catch {
      $('#pair-code').textContent = '· · ·';
      setTimeout(startPairing, 5000); // servidor fora do ar (ou limite de pedidos): tenta de novo
    }
  }

  function unpair() {
    localStorage.removeItem('sb_device_token');
    localStorage.removeItem('sb_manifest');
    deviceToken = null;
    manifest = null;
    itemsSignature = null;
    syncRun++;
    downloadAbort?.abort();
    socket?.disconnect();
    hideEmergency();
    setPower(true);
    idb.clear().finally(() => startPairing());
  }

  // ---------- manifesto ----------
  async function fetchManifest() {
    if (!deviceToken) return;
    try {
      const headers = { 'X-Device-Token': deviceToken };
      if (manifest?.version) headers['If-None-Match'] = `"${manifest.version}"`;
      const res = await fetch('/api/player/manifest', { headers, cache: 'no-store' });
      setOffline(false);
      syncClock(res);
      if (res.status === 401) return unpair();   // tela removida no painel
      if (res.status === 304) {                  // nada mudou — mas talvez algo não tenha baixado
        if (health.missing > 0 && !syncing) syncCache();
        return;
      }
      if (!res.ok) return;
      const m = await res.json();
      if (m.version === manifest?.version) return;
      manifest = m;
      localStorage.setItem('sb_manifest', JSON.stringify(m));
      await applyManifest();
    } catch {
      setOffline(true); // sem rede: segue tocando do cache
    }
  }

  // item exibível: cache completo, streaming HLS (online) ou página web (online)
  function streamable(it) {
    if (offline) return false;
    if (it.type === 'webpage') return true;
    return !!(it.hls && (window.Hls?.isSupported() || nativeHls()));
  }
  function nativeHls() {
    return document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
  }
  async function filterPlayable(items) {
    const keys = new Set(await idb.keys());
    return items.filter((it) => keys.has(it.url) || streamable(it));
  }
  // urls que precisam estar no cache (imagens/vídeos, inclusive mídia de emergência)
  function cacheableUrls(m) {
    const urls = (m?.items || [])
      .filter((it) => it.type === 'image' || it.type === 'video')
      .map((it) => it.url);
    const em = m?.emergency;
    if (em && (em.type === 'image' || em.type === 'video')) urls.push(em.url);
    return [...new Set(urls)];
  }

  async function applyManifest() {
    applySettings(manifest.settings || {});
    applyBranding(manifest.branding);
    $('#standby-name').textContent = manifest.deviceName || '';

    const signature = JSON.stringify((manifest.items || []).map((i) => [i.id, i.url, i.hls, i.duration]));
    const itemsChanged = signature !== itemsSignature;
    itemsSignature = signature;
    playable = await filterPlayable(manifest.items || []);

    if (manifest.emergency) {
      showEmergency(manifest.emergency);
    } else {
      const wasEmergency = emergencyShowing;
      hideEmergency();
      // ajuste de volume/rodapé/nome não reinicia a playlist do começo
      if (itemsChanged || wasEmergency || playIndex === -1) restartPlayback();
    }
    checkPower();
    syncCache();
  }

  // Baixa uma URL acompanhando o progresso; aborta se ficar parado sem receber dados.
  async function download(url, onProgress, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = parseInt(res.headers.get('content-length'), 10) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      let stall;
      const timeout = new Promise((_, reject) => {
        stall = setTimeout(() => reject(new Error('download parado')), DOWNLOAD_STALL_MS);
      });
      const { done, value } = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(stall));
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(total ? received / total : null);
    }
    return new Blob(chunks, { type: res.headers.get('content-type') || '' });
  }

  async function updateStorageInfo() {
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) {
        health.storageUsage = est.usage ?? null;
        health.storageQuota = est.quota ?? null;
      }
    } catch { /* indisponível */ }
  }

  // Sincroniza o cache local com o manifesto: primeiro libera espaço, depois baixa o que falta.
  async function syncCache() {
    const run = ++syncRun;
    downloadAbort?.abort();
    syncing = true;
    try {
      const valid = new Set(cacheableUrls(manifest));
      // 1) evicção ANTES do download — disco de TV box é pequeno
      for (const key of await idb.keys()) {
        if (!valid.has(key)) await idb.del(key);
      }
      const cached = new Set(await idb.keys());
      const missing = [...valid].filter((u) => !cached.has(u));
      health.missing = missing.length;

      // 2) baixa o que falta, sequencialmente (não compete com o vídeo em exibição)
      for (let i = 0; i < missing.length; i++) {
        if (run !== syncRun) return; // chegou manifesto mais novo
        const url = missing[i];
        downloadAbort = new AbortController();
        try {
          const blob = await download(url, (frac) => {
            const pct = frac == null ? '' : ` — ${Math.round(frac * 100)}%`;
            cacheProgress(`Baixando conteúdo ${i + 1}/${missing.length}${pct}`);
          }, downloadAbort.signal);
          if (run !== syncRun) return;
          await idb.put(url, blob);
          health.missing--;
          playable = await filterPlayable(manifest.items || []);
          if (playIndex === -1 && !emergencyShowing) restartPlayback(); // estava em standby, já pode começar
          if (emergencyShowing && manifest.emergency?.url === url) showEmergency(manifest.emergency);
        } catch (err) {
          if (run !== syncRun) return;
          health.cacheErrors++;
          health.lastError = err?.name === 'QuotaExceededError'
            ? 'sem espaço de armazenamento na tela'
            : `falha ao baixar: ${err?.message || err}`;
        }
      }
      cacheProgress(null);
      playable = await filterPlayable(manifest.items || []);
      if (!health.missing) health.lastError = null;
    } finally {
      if (run === syncRun) {
        syncing = false;
        cacheProgress(null);
        await updateStorageInfo();
        sendStatus();
      }
    }
  }

  // ---------- configurações da tela (orientação, volume, rodapé, energia) ----------
  function applySettings(s) {
    settings = {
      orientation: s.orientation || 0,
      volume: s.volume ?? 100,
      muted: !!s.muted,
      overlay: s.overlay || { ticker: '', showClock: false },
      powerSchedule: s.powerSchedule || null,
      timezone: s.timezone || null
    };
    applyOrientation(settings.orientation);
    applyOverlay(settings.overlay);
    // volume/mudo aplicados ao vivo nos vídeos em exibição
    for (const v of document.querySelectorAll('.layer video, #emergency-view video')) {
      v.volume = settings.volume / 100;
      v.muted = settings.muted;
    }
  }

  function applyOrientation(deg) {
    const stage = $('#stage');
    stage.style.transformOrigin = 'top left';
    if (deg === 90) {
      stage.style.width = '100vh'; stage.style.height = '100vw';
      stage.style.transform = 'rotate(90deg) translateY(-100%)';
    } else if (deg === 270) {
      stage.style.width = '100vh'; stage.style.height = '100vw';
      stage.style.transform = 'rotate(270deg) translateX(-100%)';
    } else if (deg === 180) {
      stage.style.width = ''; stage.style.height = '';
      stage.style.transform = 'rotate(180deg) translate(-100%, -100%)';
    } else {
      stage.style.width = ''; stage.style.height = '';
      stage.style.transform = '';
    }
  }

  function applyOverlay(ov) {
    const hasTicker = !!(ov.ticker || '').trim();
    const active = hasTicker || ov.showClock;
    document.documentElement.style.setProperty('--footer-h', active ? '7vh' : '0px');
    $('#footer').classList.toggle('show', active);
    $('#clock').classList.toggle('show', !!ov.showClock);

    const ticker = $('#ticker');
    const [a, b] = ticker.querySelectorAll('span');
    const text = hasTicker ? ov.ticker.trim() : '';
    if (a.textContent !== text) { a.textContent = text; b.textContent = text; }
    ticker.classList.toggle('scroll', hasTicker);
    // velocidade proporcional ao texto (~4 caracteres/s, mínimo 18 s por volta)
    ticker.style.setProperty('--ticker-s', `${Math.max(18, Math.round(text.length / 4))}s`);

    clearInterval(clockTimer);
    if (ov.showClock) {
      const tick = () => { $('#clock').textContent = localParts().hhmm; };
      tick();
      clockTimer = setInterval(tick, 5000);
    }
  }

  // ---------- energia (soft power via agenda) ----------
  // Os dias marcados são os dias em que a tela LIGA: "sexta 18:00→02:00" fica ligada até sábado 02:00.
  function inPowerWindow(ps) {
    if (!ps) return true; // sem agenda: sempre ligada
    const { hhmm, day } = localParts();
    if (ps.on === ps.off) return ps.days.includes(day);
    if (ps.on < ps.off) return ps.days.includes(day) && hhmm >= ps.on && hhmm < ps.off;
    const previous = (day + 6) % 7;
    return (ps.days.includes(day) && hhmm >= ps.on) || (ps.days.includes(previous) && hhmm < ps.off);
  }
  function setPower(on) {
    if (on === !poweredOff) return;
    poweredOff = !on;
    $('#power-off').classList.toggle('show', poweredOff);
    if (poweredOff) stopPlayback();
    else if (!emergencyShowing) restartPlayback();
    sendStatus();
  }
  function checkPower() {
    // emergência acende a tela mesmo em janela de desligamento
    setPower(emergencyShowing || inPowerWindow(settings.powerSchedule));
  }

  // ---------- emergência ----------
  async function showEmergency(em) {
    emergencyShowing = true;
    checkPower();
    stopPlayback();
    const view = $('#emergency-view');
    clearEmergencyContent();

    let el;
    if (em.type === 'message' || (!em.url && em.message)) {
      el = document.createElement('div');
      el.className = 'emergency-message';
      el.textContent = em.message || 'ATENÇÃO';
    } else if (em.type === 'webpage') {
      el = document.createElement('iframe');
      el.src = em.url;
      el.sandbox = 'allow-scripts allow-same-origin allow-forms';
    } else {
      const blob = await idb.get(em.url);
      const src = blob ? URL.createObjectURL(blob) : em.url; // cache > stream direto
      if (em.type === 'video') {
        el = document.createElement('video');
        el.src = src;
        el.loop = true;
        el.autoplay = true;
        el.playsInline = true;
        el.volume = settings.volume / 100;
        el.muted = settings.muted;
        el.play().catch(() => { el.muted = true; el.play().catch(() => {}); });
      } else {
        el = document.createElement('img');
        el.src = src;
      }
      if (blob) el._objectUrl = src;
    }
    view.appendChild(el);
    view.classList.add('show');
    sendStatus(`EMERGÊNCIA${em.name ? ` — ${em.name}` : ''}`);
  }

  function clearEmergencyContent() {
    const view = $('#emergency-view');
    const v = view.querySelector('video');
    if (v) { v.pause(); v.src = ''; }
    for (const el of view.children) {
      if (el._objectUrl) URL.revokeObjectURL(el._objectUrl);
    }
    view.innerHTML = '';
  }

  function hideEmergency() {
    if (!emergencyShowing) return;
    emergencyShowing = false;
    clearEmergencyContent();
    $('#emergency-view').classList.remove('show');
    checkPower();
  }

  // ---------- proof-of-play ----------
  function loadLogBuffer() {
    try {
      const saved = JSON.parse(localStorage.getItem('sb_play_log') || '[]');
      return Array.isArray(saved) ? saved.slice(-MAX_LOG_BUFFER) : [];
    } catch {
      return [];
    }
  }
  function persistLogBuffer() {
    try { localStorage.setItem('sb_play_log', JSON.stringify(logBuffer)); } catch { /* cota cheia */ }
  }
  function logPlay(item, dur) {
    logBuffer.push({ mediaId: item.id, name: item.name, ts: now().getTime(), dur: Math.round(dur || 0) });
    if (logBuffer.length > MAX_LOG_BUFFER) logBuffer = logBuffer.slice(-MAX_LOG_BUFFER);
    persistLogBuffer();
  }
  async function flushLogs() {
    if (!logBuffer.length || !deviceToken) return;
    const events = logBuffer.slice(0, 500);
    try {
      const res = await fetch('/api/player/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': deviceToken },
        body: JSON.stringify({ events })
      });
      if (!res.ok) throw new Error();
      logBuffer = logBuffer.slice(events.length);
      persistLogBuffer();
      if (logBuffer.length) flushLogs(); // havia mais de um lote acumulado offline
    } catch { /* fica no buffer; tenta no próximo ciclo */ }
  }

  // ---------- reprodução ----------
  // Pré-carregamento: o próximo item é lido do IndexedDB e decodificado
  // ANTES da transição (img.decode() / video preload) — troca sem engasgo.
  let preloaded = null; // { url, el }
  let playSeq = 0;      // detecta chamadas concorrentes de next()

  function destroyEl(el) {
    if (!el) return;
    // remove handlers ANTES de mexer no src: `src = ''` dispara onerror do
    // elemento antigo, que chamaria next() e pularia o item em exibição
    el.onended = el.onerror = el.onloadedmetadata = null;
    el._onFatal = null;
    if (el._hls) { try { el._hls.destroy(); } catch { /* já destruído */ } el._hls = null; }
    if (el.tagName === 'VIDEO') { el.pause?.(); el.src = ''; }
    if (el._objectUrl) URL.revokeObjectURL(el._objectUrl);
  }

  function discardPreloaded() {
    if (preloaded) destroyEl(preloaded.el);
    preloaded = null;
  }

  async function buildElement(item) {
    if (item.type === 'webpage') {
      if (offline) return null;
      const el = document.createElement('iframe');
      el.src = item.url;
      el.sandbox = 'allow-scripts allow-same-origin allow-forms';
      return el;
    }

    const blob = await idb.get(item.url);

    if (item.type === 'video') {
      const el = document.createElement('video');
      el.preload = 'auto';
      el.playsInline = true;
      el.volume = settings.volume / 100;
      el.muted = settings.muted;
      if (blob) {
        const url = URL.createObjectURL(blob);
        el.src = url;
        el._objectUrl = url;
        el.load(); // começa a bufferizar/decodificar já
      } else if (item.hls && !offline && window.Hls?.isSupported()) {
        const hls = new Hls({ maxBufferLength: 30 });
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) el._onFatal?.(); });
        hls.loadSource(item.hls);
        hls.attachMedia(el);
        el._hls = hls;
      } else if (item.hls && !offline && nativeHls()) {
        el.src = item.hls;
      } else {
        return null;
      }
      return el;
    }

    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    const el = document.createElement('img');
    el.src = url;
    // decodifica fora da tela; decode() pode nunca resolver em renderers
    // com throttle (aba oculta, TV box fraco) → timeout garante progresso
    if (el.decode) {
      await Promise.race([
        el.decode().catch(() => {}),
        new Promise((r) => setTimeout(r, 3000))
      ]);
    }
    el._objectUrl = url;
    return el;
  }

  async function preloadNext() {
    if (playable.length < 2) return discardPreloaded();
    const item = playable[(playIndex + 1) % playable.length];
    if (preloaded?.url === item.url) return;
    discardPreloaded();
    // só pré-carrega mídia local (iframe/HLS pré-carregados custariam rede e CPU à toa)
    if (item.type === 'webpage') return;
    const cached = new Set(await idb.keys());
    if (!cached.has(item.url)) return;
    const el = await buildElement(item);
    if (!el) return;
    // enquanto decodificava, a playlist pode ter mudado ou avançado
    if (playable[(playIndex + 1) % playable.length]?.url !== item.url) {
      destroyEl(el);
      return;
    }
    preloaded = { url: item.url, el };
  }

  function stopPlayback() {
    clearTimeout(advanceTimer);
    clearInterval(stallTimer);
    playIndex = -1;
    discardPreloaded();
    for (const layer of layers) {
      layer.classList.remove('visible');
      clearLayer(layer);
    }
  }

  function clearLayer(layer) {
    for (const el of [...layer.children]) destroyEl(el);
    layer.innerHTML = '';
  }

  function restartPlayback() {
    clearTimeout(advanceTimer);
    if (emergencyShowing || poweredOff) return;
    if (!playable.length) {
      stopPlayback();
      show('standby');
      return;
    }
    show(null);
    playIndex = -1;
    next();
  }

  // Vídeo que para de avançar (decoder travado, stream sem dados) é pulado.
  function watchStall(video, advance) {
    clearInterval(stallTimer);
    let last = -1;
    let since = Date.now();
    stallTimer = setInterval(() => {
      if (video.ended) return;
      if (video.currentTime !== last) {
        last = video.currentTime;
        since = Date.now();
      } else if (Date.now() - since > VIDEO_STALL_MS) {
        clearInterval(stallTimer);
        health.lastError = 'vídeo travado — pulado';
        advance();
      }
    }, 2000);
  }

  async function next() {
    const seq = ++playSeq; // se outro next() começar durante um await, este aborta
    clearTimeout(advanceTimer);
    clearInterval(stallTimer);
    if (emergencyShowing || poweredOff) return;
    if (!playable.length) return restartPlayback();
    playIndex = (playIndex + 1) % playable.length;
    const item = playable[playIndex];

    // usa o elemento pré-carregado se corresponder; senão constrói na hora
    let el = null;
    if (preloaded?.url === item.url) {
      el = preloaded.el;
      preloaded = null;
    } else {
      discardPreloaded();
      el = await buildElement(item);
    }
    if (seq !== playSeq) { // superado por outra chamada durante o await
      destroyEl(el);
      return;
    }
    if (!el) { // sumiu do cache / stream indisponível? pula
      playable = await filterPlayable(manifest.items || []);
      if (seq !== playSeq) return;
      return playable.length ? next() : restartPlayback();
    }

    const incoming = layers[1 - activeLayer];
    const outgoing = layers[activeLayer];
    clearLayer(incoming);

    // callbacks só avançam se este item ainda for o vigente (elementos antigos
    // sendo destruídos ou eventos atrasados não podem pular o item atual)
    const advance = () => { if (seq === playSeq) next(); };
    if (item.type === 'video') {
      el.volume = settings.volume / 100;
      el.muted = settings.muted;
      el.onended = advance;
      el.onerror = advance;
      el._onFatal = advance;
      // autoplay com som pode ser bloqueado; se for, toca mudo
      el.play().catch(() => { el.muted = true; el.play().catch(advance); });
      // rede de segurança: se 'ended' não disparar (codec ruim), avança
      const armFallback = () => {
        if (isFinite(el.duration) && el.duration > 0) {
          advanceTimer = setTimeout(advance, (el.duration + 3) * 1000);
          logPlay(item, el.duration);
        } else {
          logPlay(item, item.mediaDuration || 0);
        }
      };
      if (el.readyState >= 1) armFallback();
      else el.onloadedmetadata = armFallback;
      watchStall(el, advance);
    } else {
      if (item.type === 'image') el.onerror = advance;
      advanceTimer = setTimeout(advance, (item.duration || 10) * 1000);
      logPlay(item, item.duration || 10);
    }
    incoming.appendChild(el);

    incoming.classList.add('visible');
    outgoing.classList.remove('visible');
    activeLayer = 1 - activeLayer;
    // limpa a camada que saiu depois do fade (libera memória/decoder)
    setTimeout(() => { if (layers[1 - activeLayer] === outgoing) clearLayer(outgoing); }, 700);

    sendStatus(item.name, item.id);
    preloadNext(); // prepara o próximo item em segundo plano
  }

  // ---------- socket / status ----------
  function connectSocket() {
    socket?.disconnect();
    socket = io({ auth: { role: 'player', token: deviceToken } });
    socket.on('sync', fetchManifest);
    socket.on('command', (cmd) => {
      if (cmd.type === 'reload') location.reload();
      if (cmd.type === 'unpaired') unpair();
      if (cmd.type === 'clear-cache') idb.clear().then(() => location.reload());
      if (cmd.type === 'identify') {
        const el = $('#identify');
        el.textContent = manifest?.deviceName || 'Esta tela';
        el.style.display = 'block';
        setTimeout(() => (el.style.display = 'none'), 8000);
      }
    });
    socket.on('connect', () => {
      fetchManifest();
      flushLogs();
    });
  }

  let lastPlaying = { name: null, id: null };
  async function sendStatus(playingName, playingId) {
    if (playingName !== undefined) lastPlaying = { name: playingName, id: playingId || null };
    if (!socket?.connected) return;
    socket.emit('status', {
      playing: poweredOff ? null : lastPlaying.name,
      mediaId: lastPlaying.id,
      cached: (await idb.keys()).length,
      missing: health.missing,
      cacheErrors: health.cacheErrors,
      lastError: health.lastError,
      storageUsage: health.storageUsage,
      storageQuota: health.storageQuota,
      persisted: health.persisted,
      emergency: emergencyShowing,
      poweredOff,
      version: manifest?.version || null
    });
  }

  // ---------- recursos do navegador ----------
  // Pede armazenamento persistente (o navegador não descarta o cache sob pressão de disco)
  // e mantém a tela acordada. Ambos exigem HTTPS; em http:// na LAN falham em silêncio.
  async function requestBrowserCapabilities() {
    try { health.persisted = await navigator.storage?.persist?.() ?? null; } catch { health.persisted = null; }
    let lock = null;
    const acquire = async () => {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || lock) return;
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } catch { /* sem contexto seguro ou negado */ }
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
  }

  // ---------- boot ----------
  async function boot() {
    show('standby');
    connectSocket();
    if (!booted) {
      booted = true;
      requestBrowserCapabilities();
      setInterval(fetchManifest, POLL_MS);   // polling = rede de segurança do realtime
      setInterval(() => sendStatus(), HEARTBEAT_MS);
      setInterval(flushLogs, LOG_FLUSH_MS);  // proof-of-play em lotes
      setInterval(checkPower, POWER_CHECK_MS);
    }

    // offline-first: restaura o último manifesto salvo antes mesmo de falar com o servidor
    const saved = localStorage.getItem('sb_manifest');
    if (saved) {
      try {
        manifest = JSON.parse(saved);
        await applyManifest();
      } catch { /* ignora manifesto corrompido */ }
    }
    await fetchManifest();
  }

  // erro fatal → recarrega (auto-recuperação estilo watchdog)
  window.addEventListener('error', () => setTimeout(() => location.reload(), 15000));

  idb.open().then(() => {
    if (deviceToken) boot();
    else startPairing();
  }).catch(() => {
    // sem IndexedDB (muito raro): ainda funciona, só sem cache offline
    idb.get = async () => null;
    idb.put = async () => {};
    idb.keys = async () => [];
    idb.del = async () => {};
    idb.clear = async () => {};
    if (deviceToken) boot();
    else startPairing();
  });
})();
