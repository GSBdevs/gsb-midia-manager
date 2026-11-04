/* SB Signage — player web
 * Princípios (do plano técnico):
 *  - Offline-first: o loop principal só exibe o que está 100% no cache local (IndexedDB).
 *    Exceções conscientes: HLS (vídeo longo, streaming enquanto o MP4 baixa) e
 *    páginas web — ambos exigem rede e são pulados quando offline.
 *  - Pull é a fonte de verdade (manifesto + ETag); o socket só acelera ("sync").
 *  - Se o realtime cair, o polling garante consistência.
 */
(() => {
  const POLL_MS = 60_000;
  const HEARTBEAT_MS = 30_000;
  const PAIR_POLL_MS = 3_000;
  const LOG_FLUSH_MS = 60_000;
  const POWER_CHECK_MS = 30_000;

  const $ = (s) => document.querySelector(s);
  const layers = [$('#layerA'), $('#layerB')];
  let activeLayer = 0;

  let deviceToken = localStorage.getItem('sb_device_token') || null;
  let manifest = null;         // manifesto vigente
  let playable = [];           // itens do manifesto exibíveis agora (cache ou stream)
  let playIndex = -1;
  let advanceTimer = null;
  let socket = null;
  let offline = false;
  let cachingRun = 0;          // invalida downloads de manifestos antigos
  let settings = { orientation: 0, volume: 100, muted: false, overlay: { ticker: '', showClock: false }, powerSchedule: null };
  let emergencyShowing = false;
  let poweredOff = false;
  let clockTimer = null;
  let logBuffer = [];          // proof-of-play pendente de envio

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

  // ---------- UI ----------
  function show(screen) {
    $('#pairing').classList.toggle('show', screen === 'pairing');
    $('#standby').classList.toggle('show', screen === 'standby');
  }
  function setOffline(v) {
    offline = v;
    $('#status-badge').style.display = v ? 'block' : 'none';
  }
  function cacheProgress(text) {
    const el = $('#cache-progress');
    el.style.display = text ? 'block' : 'none';
    if (text) el.textContent = text;
  }

  // ---------- pareamento ----------
  async function startPairing() {
    show('pairing');
    stopPlayback();
    try {
      const res = await fetch('/api/pair/request', { method: 'POST' });
      const { code, token } = await res.json();
      $('#pair-code').textContent = code;
      const timer = setInterval(async () => {
        try {
          const st = await fetch('/api/pair/status', { headers: { 'X-Device-Token': token } });
          if (st.status === 404) { clearInterval(timer); return startPairing(); } // código expirou
          const data = await st.json();
          if (data.claimed) {
            clearInterval(timer);
            deviceToken = token;
            localStorage.setItem('sb_device_token', token);
            boot();
          }
        } catch { /* sem rede: continua tentando */ }
      }, PAIR_POLL_MS);
    } catch {
      $('#pair-code').textContent = '· · ·';
      setTimeout(startPairing, 5000); // servidor fora do ar: tenta de novo
    }
  }

  function unpair() {
    localStorage.removeItem('sb_device_token');
    localStorage.removeItem('sb_manifest');
    deviceToken = null;
    socket?.disconnect();
    hideEmergency();
    setPower(true);
    idb.clear().finally(() => startPairing());
  }

  // ---------- manifesto ----------
  async function fetchManifest() {
    try {
      const headers = { 'X-Device-Token': deviceToken };
      if (manifest?.version) headers['If-None-Match'] = manifest.version;
      const res = await fetch('/api/player/manifest', { headers, cache: 'no-store' });
      setOffline(false);
      if (res.status === 304) return;            // nada mudou
      if (res.status === 401) return unpair();   // tela removida no painel
      if (!res.ok) return;
      const m = await res.json();
      if (m.version === manifest?.version) return;
      manifest = m;
      localStorage.setItem('sb_manifest', JSON.stringify(m));
      applyManifest();
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
    return urls;
  }

  async function applyManifest() {
    const run = ++cachingRun;
    applySettings(manifest.settings || {});

    // 1) o que já dá para exibir, exibe imediatamente
    playable = await filterPlayable(manifest.items || []);
    if (manifest.emergency) showEmergency(manifest.emergency);
    else { hideEmergency(); restartPlayback(); }
    checkPower();

    // 2) baixa o que falta, sequencialmente (não compete com o vídeo em exibição)
    const cachedKeys = new Set(await idb.keys());
    const missing = [...new Set(cacheableUrls(manifest))].filter((u) => !cachedKeys.has(u));
    let done = 0;
    for (const url of missing) {
      if (run !== cachingRun) return; // chegou manifesto mais novo
      cacheProgress(`Baixando conteúdo… ${done + 1}/${missing.length}`);
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        await idb.put(url, blob);
        done++;
        if (run !== cachingRun) return;
        playable = await filterPlayable(manifest.items || []);
        if (playIndex === -1) restartPlayback(); // estava em standby, já pode começar
      } catch { /* tenta na próxima sincronização */ }
    }
    cacheProgress(null);
    if (run !== cachingRun) return;
    playable = await filterPlayable(manifest.items || []);

    // 3) evicção: remove do cache o que saiu do manifesto
    const valid = new Set(cacheableUrls(manifest));
    for (const key of await idb.keys()) {
      if (!valid.has(key)) await idb.del(key);
    }
    sendStatus();
  }

  // ---------- configurações da tela (orientação, volume, rodapé, energia) ----------
  function applySettings(s) {
    settings = {
      orientation: s.orientation || 0,
      volume: s.volume ?? 100,
      muted: !!s.muted,
      overlay: s.overlay || { ticker: '', showClock: false },
      powerSchedule: s.powerSchedule || null
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
    // velocidade proporcional ao texto (~8 chars/s, mínimo 18s por volta)
    ticker.style.setProperty('--ticker-s', `${Math.max(18, Math.round(text.length / 4))}s`);

    clearInterval(clockTimer);
    if (ov.showClock) {
      const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
      tick();
      clockTimer = setInterval(tick, 5000);
    }
  }

  // ---------- energia (soft power via agenda) ----------
  function inPowerWindow(ps, now = new Date()) {
    if (!ps) return true; // sem agenda: sempre ligada
    if (!ps.days.includes(now.getDay())) return false;
    const hhmm = now.toTimeString().slice(0, 5);
    if (ps.on <= ps.off) return hhmm >= ps.on && hhmm < ps.off;
    return hhmm >= ps.on || hhmm < ps.off; // janela que cruza a meia-noite
  }
  function setPower(on) {
    if (on === !poweredOff) return;
    poweredOff = !on;
    $('#power-off').classList.toggle('show', poweredOff);
    if (poweredOff) stopPlayback();
    else if (!emergencyShowing) restartPlayback();
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
    sendStatus(`⚠ EMERGÊNCIA${em.name ? ` — ${em.name}` : ''}`);
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
  function logPlay(item, dur) {
    logBuffer.push({ mediaId: item.id, name: item.name, ts: Date.now(), dur: Math.round(dur || 0) });
    if (logBuffer.length > 500) logBuffer = logBuffer.slice(-500);
  }
  async function flushLogs() {
    if (!logBuffer.length || !deviceToken) return;
    const events = logBuffer.splice(0, logBuffer.length);
    try {
      const res = await fetch('/api/player/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': deviceToken },
        body: JSON.stringify({ events })
      });
      if (!res.ok) throw new Error();
    } catch {
      logBuffer = events.concat(logBuffer).slice(-500); // devolve ao buffer, tenta depois
    }
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
      $('#standby-name').textContent = manifest?.deviceName || '';
      show('standby');
      return;
    }
    show(null);
    playIndex = -1;
    next();
  }

  async function next() {
    const seq = ++playSeq; // se outro next() começar durante um await, este aborta
    clearTimeout(advanceTimer);
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
      // autoplay com som pode ser bloqueado; se for, toca mudo
      el.play().catch(() => { el.muted = true; el.play().catch(advance); });
      // rede de segurança: se 'ended' não disparar (codec ruim), avança
      const armFallback = () => {
        if (isFinite(el.duration) && el.duration > 0) {
          advanceTimer = setTimeout(advance, (el.duration + 3) * 1000);
          logPlay(item, el.duration);
        } else {
          logPlay(item, 0);
        }
      };
      if (el.readyState >= 1) armFallback();
      else el.onloadedmetadata = armFallback;
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

    sendStatus(item.name);
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
    socket.on('connect', fetchManifest);
  }

  async function sendStatus(playing) {
    if (!socket?.connected) return;
    socket.emit('status', {
      playing: playing || playable[playIndex]?.name || null,
      cached: (await idb.keys()).length,
      version: manifest?.version || null
    });
  }

  // ---------- boot ----------
  async function boot() {
    show('standby');
    connectSocket();

    // offline-first: restaura o último manifesto salvo antes mesmo de falar com o servidor
    const saved = localStorage.getItem('sb_manifest');
    if (saved) {
      try {
        manifest = JSON.parse(saved);
        await applyManifest();
      } catch { /* ignora manifesto corrompido */ }
    }
    await fetchManifest();
    setInterval(fetchManifest, POLL_MS);   // polling = rede de segurança do realtime
    setInterval(() => sendStatus(), HEARTBEAT_MS);
    setInterval(flushLogs, LOG_FLUSH_MS);  // proof-of-play em lotes
    setInterval(checkPower, POWER_CHECK_MS);
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
