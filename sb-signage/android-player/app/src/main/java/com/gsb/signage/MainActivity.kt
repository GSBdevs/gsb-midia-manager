package com.gsb.signage

import android.animation.ObjectAnimator
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings as AndroidSettings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import com.gsb.signage.databinding.ActivityMainBinding
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URI
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Orquestra o player: configuração → pareamento → sincronização → exibição offline-first.
 * Segue o mesmo comportamento de public/player/player.js:
 *  - pull é a fonte de verdade; o socket só avisa "há novidade" e entrega comandos;
 *  - o último manifesto fica em disco, para ligar e exibir mesmo sem rede;
 *  - relógio e fuso vêm do servidor.
 */
class MainActivity : AppCompatActivity(), PlaybackController.Listener {
    private enum class Screen { NONE, SETUP, PAIRING, STANDBY }

    private lateinit var b: ActivityMainBinding
    private lateinit var prefs: Prefs
    private lateinit var clock: ServerClock
    private lateinit var log: PlayLog
    private lateinit var cache: MediaCache
    private lateinit var playback: PlaybackController
    private lateinit var api: SignageApi

    private var session: Job? = null
    private var sessionScope: CoroutineScope = lifecycleScope
    private var cacheJob: Job? = null
    private var clockJob: Job? = null
    private var socket: Socket? = null
    private val syncSignal = Channel<Unit>(Channel.CONFLATED)

    private var manifest: Manifest? = null
    private var settings = Settings()
    private var itemsSignature: String? = null
    private var emergency: Emergency? = null
    private var emergencyMedia = false
    private var poweredOff = false
    private var offline = false
    private var stoppedInBackground = false
    private var progressText: String? = null
    private var tickerAnimator: ObjectAnimator? = null
    private var tickerText = ""
    private var footerHeight = 0
    private var logoUrl: String? = null

    // o que o painel mostra no card da tela
    private var playingName: String? = null
    private var playingId: String? = null
    private var missing = 0
    private var cacheErrors = 0
    private var lastError: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enterImmersive()

        prefs = Prefs(this)
        clock = ServerClock(prefs.clockOffsetMs)
        log = PlayLog(File(filesDir, "play-log.jsonl"))
        cache = MediaCache(this)
        playback = PlaybackController(this, lifecycleScope, b.videoHost, b.imageView, cache, this)
        playback.setRotated(false)

        // só o tamanho da tela importa: qualquer texto novo também dispara layout aqui
        b.root.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) layoutStage()
        }
        b.setupConnect.setOnClickListener { connectToServer() }
        b.serverInput.setOnEditorActionListener { _, _, _ ->
            connectToServer()
            true
        }
        b.changeServer.setOnClickListener { showSetup() }
        b.allowAutostart.setOnClickListener { openOverlaySettings() }
        // TV box: o botão Voltar do controle remoto não pode derrubar a programação
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = Unit
        })

        provision()
        if (prefs.server == null) showSetup() else start()
    }

    /**
     * Endereço por extra só vale na primeira execução (ou em build de depuração): a activity é
     * exportada, e outro app instalado não pode apontar a tela para um servidor qualquer.
     */
    private fun provision() {
        val extra = intent.getStringExtra("server")
        val wanted = when {
            prefs.server == null -> extra ?: BuildConfig.DEFAULT_SERVER.ifEmpty { null }
            BuildConfig.DEBUG -> extra
            else -> null
        }
        val server = ServerAddress.normalize(wanted) ?: return
        if (server != prefs.server) {
            prefs.server = server
            prefs.token = null
            prefs.clearManifest()
        }
    }

    private fun start() {
        api = SignageApi(prefs.server!!)
        if (prefs.token == null) startPairing() else boot()
    }

    /** Cada fase (pareamento ou operação) roda num escopo próprio, cancelado de uma vez. */
    private fun newSession(): CoroutineScope {
        session?.cancel()
        val job = Job(lifecycleScope.coroutineContext[Job])
        session = job
        sessionScope = CoroutineScope(lifecycleScope.coroutineContext + job)
        return sessionScope
    }

    // ---------- configuração inicial ----------
    private fun showSetup() {
        newSession()
        b.serverInput.setText(prefs.server ?: "")
        b.setupError.text = ""
        show(Screen.SETUP)
        b.serverInput.requestFocus()
    }

    private fun connectToServer() {
        val server = ServerAddress.normalize(b.serverInput.text.toString())
        if (server == null) {
            b.setupError.text = getString(R.string.setup_invalid)
            return
        }
        b.setupError.text = getString(R.string.setup_connecting)
        sessionScope.launch {
            try {
                withContext(Dispatchers.IO) { SignageApi(server).branding() }
                if (server != prefs.server) {
                    prefs.server = server
                    prefs.token = null
                    prefs.clearManifest()
                }
                start()
            } catch (e: IOException) {
                Log.w(TAG, "servidor inacessível: $server", e)
                b.setupError.text = getString(R.string.setup_unreachable, server)
            }
        }
    }

    // ---------- pareamento ----------
    private fun startPairing() {
        val scope = newSession()
        show(Screen.PAIRING)
        b.pairCode.text = getString(R.string.pair_placeholder)
        b.allowAutostart.isVisible = needsOverlayPermission()

        scope.launch {
            try {
                applyBranding(withContext(Dispatchers.IO) { api.branding() })
            } catch (e: IOException) {
                Log.w(TAG, "sem marca do servidor", e)
            }
        }
        scope.launch {
            while (isActive) {
                val pairing = try {
                    withContext(Dispatchers.IO) { api.requestPairing() }
                } catch (e: IOException) {
                    Log.w(TAG, "pareamento indisponível", e)
                    setOffline(true)
                    b.pairCode.text = getString(R.string.pair_offline)
                    delay(RETRY_MS)
                    continue
                }
                setOffline(false)
                b.pairCode.text = pairing.code
                while (isActive) {
                    delay(PAIR_POLL_MS)
                    try {
                        if (withContext(Dispatchers.IO) { api.pairingClaimed(pairing.token) }) {
                            prefs.token = pairing.token
                            boot()
                            return@launch
                        }
                    } catch (_: SignageApi.PairingExpired) {
                        break // código venceu: pede outro
                    } catch (e: IOException) {
                        Log.w(TAG, "aguardando rede para confirmar o pareamento", e)
                    }
                }
            }
        }
    }

    private fun unpair() {
        newSession()
        disconnectSocket()
        prefs.token = null
        prefs.clearManifest()
        manifest = null
        itemsSignature = null
        hideEmergency()
        setPower(true)
        applySettings(Settings())
        playback.stop()
        cache.clear()
        startPairing()
    }

    // ---------- operação ----------
    private fun boot() {
        val scope = newSession()
        show(Screen.STANDBY)
        connectSocket()

        // offline-first: restaura o último manifesto antes mesmo de falar com o servidor
        prefs.loadManifest()?.let { raw ->
            try {
                applyManifest(Manifest.parse(raw))
            } catch (e: org.json.JSONException) {
                Log.w(TAG, "manifesto salvo corrompido; ignorado", e)
                prefs.clearManifest()
            }
        }

        scope.launch {
            while (isActive) {
                fetchManifest()
                withTimeoutOrNull(POLL_MS) { syncSignal.receive() } // socket adianta o próximo pull
            }
        }
        scope.launch { every(HEARTBEAT_MS) { sendStatus() } }
        scope.launch { every(LOG_FLUSH_MS) { flushLogs() } }
        scope.launch { every(POWER_CHECK_MS) { checkPower() } }
    }

    private suspend fun every(periodMs: Long, action: suspend () -> Unit) {
        while (true) {
            delay(periodMs)
            action()
        }
    }

    private suspend fun fetchManifest() {
        val token = prefs.token ?: return
        val response = try {
            withContext(Dispatchers.IO) { api.fetchManifest(token, manifest?.version) }
        } catch (_: SignageApi.Unauthorized) {
            unpair() // tela removida no painel
            return
        } catch (e: IOException) {
            Log.i(TAG, "sem resposta do servidor: ${e.message}")
            setOffline(true) // segue tocando do cache
            return
        }
        setOffline(false)
        response.serverDateMs?.let {
            clock.sync(it)
            prefs.clockOffsetMs = clock.offsetMs
        }
        val raw = response.raw
        if (raw == null) { // 304: nada mudou, mas talvez algo não tenha baixado
            if (missing > 0 && cacheJob?.isActive != true) startCacheSync()
            return
        }
        val next = try {
            Manifest.parse(raw)
        } catch (e: org.json.JSONException) {
            Log.e(TAG, "manifesto inválido", e)
            return
        }
        if (next.version == manifest?.version) return
        withContext(Dispatchers.IO) {
            try {
                prefs.saveManifest(raw)
            } catch (e: IOException) {
                Log.w(TAG, "manifesto não foi salvo", e)
            }
        }
        applyManifest(next)
    }

    private fun applyManifest(m: Manifest) {
        manifest = m
        applySettings(m.settings)
        applyBranding(m.branding)
        b.standbyName.text = m.deviceName

        val itemsChanged = m.itemsSignature != itemsSignature
        itemsSignature = m.itemsSignature

        if (m.emergency != null) {
            showEmergency(m.emergency)
        } else {
            val wasEmergency = emergency != null
            hideEmergency()
            // ajuste de volume, rodapé ou nome não recomeça a playlist
            if (itemsChanged || wasEmergency || !playback.isActive) restartPlayback()
        }
        checkPower()
        startCacheSync()
    }

    private fun playableItems(): List<Item> =
        manifest?.items.orEmpty().filter { it.isLocalMedia && cache.isCached(it.url) }

    private fun restartPlayback() {
        if (emergency != null || poweredOff) return
        val items = playableItems()
        if (items.isEmpty()) {
            playback.stop()
            playingName = null
            playingId = null
            show(Screen.STANDBY)
            return
        }
        show(Screen.NONE)
        playback.play(items)
    }

    /** Sincroniza o disco com o manifesto: libera espaço primeiro, depois baixa o que falta. */
    private fun startCacheSync() {
        val m = manifest ?: return
        val previous = cacheJob
        cacheJob = sessionScope.launch {
            previous?.cancelAndJoin()
            val urls = m.cacheableUrls
            withContext(Dispatchers.IO) { cache.evictExcept(urls) }
            val pending = urls.filter { !cache.isCached(it) }
            missing = pending.size
            pending.forEachIndexed { i, url ->
                try {
                    withContext(Dispatchers.IO) {
                        cache.ensure(api, url) { fraction ->
                            val pct = fraction?.let { " — ${(it * 100).toInt()}%" } ?: ""
                            b.root.post { setProgress("Baixando conteúdo ${i + 1}/${pending.size}$pct") }
                        }
                    }
                    missing--
                    onFileReady(url)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: SignageApi.NoSpace) {
                    cacheErrors++
                    lastError = e.message
                } catch (e: IOException) {
                    Log.w(TAG, "falha ao baixar $url", e)
                    cacheErrors++
                    lastError = "falha ao baixar: ${e.message}"
                }
            }
            setProgress(null)
            if (missing == 0) lastError = null
            sendStatus()
        }
    }

    private fun onFileReady(url: String) {
        val em = emergency
        if (em != null) {
            if (em.item?.url == url) showEmergency(em)
            return
        }
        if (poweredOff) return
        if (playback.isActive) playback.update(playableItems()) else restartPlayback()
    }

    // ---------- configurações da tela ----------
    private fun applySettings(s: Settings) {
        settings = s
        playback.setRotated(s.orientation != 0)
        playback.setAudio(s.volume, s.muted)
        playback.setFill(s.fill)
        layoutStage()
        updateFooter()
        updateClock()
    }

    /** O palco gira como um todo: funciona até em TV box que ignora a rotação do sistema. */
    private fun layoutStage() {
        val width = b.root.width
        val height = b.root.height
        if (width == 0 || height == 0) return
        val rotated = settings.orientation == 90 || settings.orientation == 270
        val stageW = if (rotated) height else width
        val stageH = if (rotated) width else height

        val lp = b.stage.layoutParams as FrameLayout.LayoutParams
        if (lp.width != stageW || lp.height != stageH) {
            lp.width = stageW
            lp.height = stageH
            lp.gravity = Gravity.CENTER
            b.stage.layoutParams = lp
        }
        b.stage.rotation = settings.orientation.toFloat()

        px(b.pairCode, min(stageW * 0.12f, stageH * 0.22f))
        px(b.emergencyText, min(stageW * 0.06f, stageH * 0.11f))
        px(b.identify, min(stageW * 0.03f, stageH * 0.06f))
        px(b.standbyName, min(stageW * 0.03f, stageH * 0.06f))
        val hint = max(16f, min(stageW * 0.016f, stageH * 0.03f))
        listOf(b.pairHint, b.standbyHint, b.pairBrand, b.standbyBrand).forEach { px(it, hint) }

        val footer = max(48, (stageH * 0.07f).toInt())
        if (footer != footerHeight) {
            footerHeight = footer
            b.footer.layoutParams = b.footer.layoutParams.apply { this.height = footer }
            px(b.ticker, footer * 0.42f)
            px(b.clock, footer * 0.5f)
            tickerText = "" // refaz a animação com a largura nova
        }
        updateFooter()
    }

    private fun px(view: TextView, size: Float) {
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, size)
    }

    private fun updateFooter() {
        val active = (settings.ticker.isNotEmpty() || settings.showClock) && !emergencyMedia
        b.footer.isVisible = active
        val lp = b.mediaArea.layoutParams as FrameLayout.LayoutParams
        val margin = if (active) footerHeight else 0
        if (lp.bottomMargin != margin) {
            lp.bottomMargin = margin
            b.mediaArea.layoutParams = lp
        }
        b.clock.isVisible = settings.showClock
        updateTicker(if (active) settings.ticker else "")
    }

    private fun updateClock() {
        clockJob?.cancel()
        if (!settings.showClock) return
        clockJob = sessionScope.launch {
            while (isActive) {
                b.clock.text = clock.parts(settings.timezone).hhmm
                delay(CLOCK_TICK_MS)
            }
        }
    }

    private fun updateTicker(text: String) {
        if (text == tickerText) return
        tickerText = text
        tickerAnimator?.cancel()
        b.ticker.text = text
        if (text.isEmpty()) return
        b.tickerWrap.post {
            val wrapWidth = b.tickerWrap.width.toFloat()
            val textWidth = b.ticker.paint.measureText(text)
            b.ticker.layoutParams = b.ticker.layoutParams.apply { width = ceil(textWidth).toInt() + 2 }
            val speed = max(60f, wrapWidth / TICKER_SECONDS_ACROSS) // pixels por segundo
            tickerAnimator = ObjectAnimator
                .ofFloat(b.ticker, View.TRANSLATION_X, wrapWidth, -textWidth)
                .apply {
                    duration = ((wrapWidth + textWidth) / speed * 1000).toLong()
                    interpolator = LinearInterpolator()
                    repeatCount = ObjectAnimator.INFINITE
                    start()
                }
        }
    }

    private fun applyBranding(br: Branding) {
        val accent = try {
            Color.parseColor(br.accent)
        } catch (_: IllegalArgumentException) {
            Color.parseColor("#FFD60A")
        }
        b.pairCode.setTextColor(accent)
        b.clock.setTextColor(accent)
        b.footerLine.setBackgroundColor(accent)
        b.identify.setBackgroundColor(accent)
        val title = "▶ ${br.brandName}"
        b.pairBrand.text = title
        b.standbyBrand.text = title
        loadLogo(br.logoUrl)
    }

    private fun loadLogo(url: String?) {
        if (url == logoUrl) return
        logoUrl = url
        b.pairLogo.isVisible = false
        b.standbyLogo.isVisible = false
        b.pairBrand.isVisible = true
        b.standbyBrand.isVisible = true
        if (url == null) return
        sessionScope.launch {
            val file = File(filesDir, "brand-logo")
            val bitmap = try {
                withContext(Dispatchers.IO) {
                    val tmp = File(filesDir, "brand-logo.tmp")
                    api.download(url, tmp)
                    tmp.renameTo(file)
                    BitmapFactory.decodeFile(file.path)
                }
            } catch (e: IOException) {
                Log.w(TAG, "logo indisponível", e)
                file.takeIf { it.exists() }?.let { BitmapFactory.decodeFile(it.path) }
            }
            // SVG não decodifica aqui: fica o nome em texto
            if (bitmap != null && url == logoUrl) {
                listOf(b.pairLogo, b.standbyLogo).forEach {
                    it.setImageBitmap(bitmap)
                    it.isVisible = true
                }
                b.pairBrand.isVisible = false
                b.standbyBrand.isVisible = false
            }
        }
    }

    // ---------- energia (soft power via agenda) ----------
    private fun inPowerWindow(): Boolean {
        val ps = settings.powerSchedule ?: return true
        val now = clock.parts(settings.timezone)
        return Schedule.weeklyWindowActive(ps.days, ps.on, ps.off, now.hhmm, now.day)
    }

    private fun checkPower() {
        // emergência acende a tela mesmo em janela de desligamento
        setPower(emergency != null || inPowerWindow())
    }

    private fun setPower(on: Boolean) {
        if (on == !poweredOff) return
        poweredOff = !on
        b.powerOff.isVisible = poweredOff
        if (poweredOff) playback.stop() else restartPlayback()
        sendStatus()
    }

    // ---------- emergência ----------
    private fun showEmergency(em: Emergency) {
        emergency = em
        checkPower()
        show(Screen.NONE)
        val item = em.item
        emergencyMedia = item != null && item.isLocalMedia && playback.playLoop(item, api.absolute(item.url))
        if (!emergencyMedia) {
            playback.stop()
            b.emergencyText.text = em.message.ifBlank { getString(R.string.emergency_default) }
        }
        b.emergencyView.isVisible = !emergencyMedia
        updateFooter()
        playingName = "EMERGÊNCIA" + if (em.message.isBlank()) "" else " — ${em.message}"
        playingId = null
        sendStatus()
    }

    private fun hideEmergency() {
        if (emergency == null) return
        emergency = null
        emergencyMedia = false
        b.emergencyView.isVisible = false
        playback.stop()
        updateFooter()
        checkPower()
    }

    // ---------- tempo real / status ----------
    private fun connectSocket() {
        disconnectSocket()
        val token = prefs.token ?: return
        val options = IO.Options.builder()
            .setForceNew(true)
            .setAuth(mapOf("role" to "player", "token" to token))
            .setExtraHeaders(mapOf("User-Agent" to listOf(userAgent())))
            .setReconnection(true)
            .setReconnectionDelay(2_000)
            .setReconnectionDelayMax(30_000)
            .build()
        socket = IO.socket(URI.create(api.baseUrl), options).apply {
            on(Socket.EVENT_CONNECT) {
                runOnUiThread {
                    syncSignal.trySend(Unit)
                    sendStatus()
                    sessionScope.launch { flushLogs() }
                }
            }
            on("sync") { syncSignal.trySend(Unit) }
            on("command") { args ->
                val type = (args.getOrNull(0) as? JSONObject)?.optString("type")
                runOnUiThread { onCommand(type) }
            }
            connect()
        }
    }

    private fun disconnectSocket() {
        socket?.off()
        socket?.disconnect()
        socket = null
    }

    private fun onCommand(type: String?) {
        when (type) {
            "identify" -> identify()
            "reload" -> recreate()
            "unpaired" -> unpair()
            "clear-cache" -> {
                playback.stop()
                cache.clear()
                recreate()
            }
        }
    }

    private fun identify() {
        b.identify.text = manifest?.deviceName ?: getString(R.string.identify_default)
        b.identify.isVisible = true
        b.identify.removeCallbacks(hideIdentify)
        b.identify.postDelayed(hideIdentify, IDENTIFY_MS)
    }

    private val hideIdentify = Runnable { b.identify.isVisible = false }

    private fun sendStatus() {
        val s = socket ?: return
        if (!s.connected()) return
        s.emit(
            "status",
            JSONObject()
                .put("playing", if (poweredOff) JSONObject.NULL else playingName ?: JSONObject.NULL)
                .put("mediaId", playingId ?: JSONObject.NULL)
                .put("cached", cache.count())
                .put("missing", missing)
                .put("cacheErrors", cacheErrors)
                .put("lastError", lastError ?: JSONObject.NULL)
                .put("storageUsage", cache.usageBytes())
                .put("storageQuota", cache.quotaBytes())
                .put("persisted", true) // arquivo em disco: o sistema não descarta sob pressão
                .put("emergency", emergency != null)
                .put("poweredOff", poweredOff)
                .put("version", manifest?.version ?: JSONObject.NULL)
        )
    }

    private fun userAgent() =
        "SBSignagePlayer/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; ${Build.MODEL})"

    private suspend fun flushLogs() {
        val token = prefs.token ?: return
        while (true) {
            val batch = log.peek(LOG_BATCH)
            if (batch.length() == 0) return
            try {
                withContext(Dispatchers.IO) { api.sendLogs(token, batch) }
            } catch (e: IOException) {
                Log.i(TAG, "registro de exibição fica para depois: ${e.message}")
                return
            }
            log.drop(batch.length())
            if (batch.length() < LOG_BATCH) return
        }
    }

    // ---------- PlaybackController.Listener ----------
    override fun onNowPlaying(item: Item) {
        val duration = if (item.type == "video") item.mediaDuration else item.duration
        log.add(
            JSONObject()
                .put("mediaId", item.id)
                .put("name", item.name)
                .put("ts", clock.now())
                .put("dur", duration)
        )
        playingName = item.name
        playingId = item.id
        sendStatus()
    }

    override fun onPlaybackError(message: String) {
        Log.w(TAG, message)
        lastError = message
        sendStatus()
    }

    override fun onQueueEmpty() {
        restartPlayback()
    }

    // ---------- telas ----------
    private fun show(screen: Screen) {
        b.setupView.isVisible = screen == Screen.SETUP
        b.pairingView.isVisible = screen == Screen.PAIRING
        b.standbyView.isVisible = screen == Screen.STANDBY
        updateBadges(screen != Screen.NONE && screen != Screen.SETUP)
    }

    // avisos técnicos só aparecem fora da exibição: nunca por cima de um anúncio
    private fun updateBadges(idle: Boolean = b.pairingView.isVisible || b.standbyView.isVisible) {
        b.offlineBadge.isVisible = offline && idle
        b.cacheProgress.isVisible = progressText != null && idle
        b.cacheProgress.text = progressText
    }

    private fun setOffline(value: Boolean) {
        offline = value
        updateBadges()
    }

    private fun setProgress(text: String?) {
        progressText = text
        updateBadges()
    }

    private fun enterImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= 28) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    /** A partir do Android 10, abrir a tela sozinho no boot exige esta permissão. */
    private fun needsOverlayPermission() =
        Build.VERSION.SDK_INT >= 29 && !AndroidSettings.canDrawOverlays(this)

    private fun openOverlaySettings() {
        try {
            startActivity(
                Intent(AndroidSettings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
            )
        } catch (e: android.content.ActivityNotFoundException) {
            Log.w(TAG, "aparelho sem tela de permissão; use adb appops", e)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    override fun onResume() {
        super.onResume()
        if (b.pairingView.isVisible) b.allowAutostart.isVisible = needsOverlayPermission()
    }

    override fun onStop() {
        super.onStop()
        if (manifest == null) return
        stoppedInBackground = true
        playback.stop()
    }

    override fun onStart() {
        super.onStart()
        if (!stoppedInBackground) return
        stoppedInBackground = false
        val em = emergency
        if (em != null) showEmergency(em) else restartPlayback()
    }

    override fun onDestroy() {
        disconnectSocket()
        tickerAnimator?.cancel()
        playback.release()
        super.onDestroy()
    }

    private companion object {
        const val TAG = "SBPlayer"
        const val POLL_MS = 60_000L
        const val HEARTBEAT_MS = 30_000L
        const val PAIR_POLL_MS = 3_000L
        const val RETRY_MS = 5_000L
        const val LOG_FLUSH_MS = 60_000L
        const val LOG_BATCH = 500
        const val POWER_CHECK_MS = 30_000L
        const val CLOCK_TICK_MS = 5_000L
        const val IDENTIFY_MS = 8_000L
        const val TICKER_SECONDS_ACROSS = 12f
    }
}
