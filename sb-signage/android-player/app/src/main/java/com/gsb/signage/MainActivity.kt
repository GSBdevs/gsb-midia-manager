package com.gsb.signage

import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Orquestra: pareamento → sync (polling 60s do manifesto, pull como fonte de
 * verdade) → download sequencial → loop de reprodução offline-first.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var api: SignageApi
    private lateinit var cache: MediaCache
    private lateinit var playback: PlaybackController
    private val power = PowerScheduler(this)

    private var deviceToken: String? = null
    private var manifestVersion: String? = null
    private var manifest: JSONObject? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUi()

        api = SignageApi(BuildConfig.SERVER_URL)
        cache = MediaCache(this, api)
        playback = PlaybackController(
            lifecycleScope,
            findViewById<PlayerView>(R.id.playerView),
            findViewById<ImageView>(R.id.imageView),
            cache
        )
        playback.attach(ExoPlayer.Builder(this).build())

        deviceToken = getSharedPreferences("sb", MODE_PRIVATE).getString("token", null)
        if (deviceToken == null) startPairing() else startSync()
    }

    // ---------- pareamento ----------
    private fun startPairing() {
        val view = findViewById<LinearLayout>(R.id.pairingView)
        view.visibility = View.VISIBLE
        lifecycleScope.launch(Dispatchers.IO) {
            while (deviceToken == null) {
                try {
                    val pairing = api.requestPairing()
                    withContext(Dispatchers.Main) {
                        findViewById<TextView>(R.id.pairCode).text = pairing.code
                    }
                    // aguarda o painel reivindicar o código
                    while (true) {
                        delay(3000)
                        try {
                            if (api.pairingClaimed(pairing.token)) {
                                deviceToken = pairing.token
                                getSharedPreferences("sb", MODE_PRIVATE).edit()
                                    .putString("token", pairing.token).apply()
                                withContext(Dispatchers.Main) {
                                    view.visibility = View.GONE
                                    startSync()
                                }
                                return@launch
                            }
                        } catch (_: SignageApi.PairingExpired) {
                            break // pede código novo
                        } catch (_: Exception) { /* sem rede: insiste */ }
                    }
                } catch (_: Exception) {
                    delay(5000) // servidor fora do ar
                }
            }
        }
    }

    private fun unpair() {
        getSharedPreferences("sb", MODE_PRIVATE).edit().remove("token").apply()
        deviceToken = null
        manifestVersion = null
        manifest = null
        playback.stop()
        cache.clear()
        startPairing()
    }

    // ---------- sync ----------
    private fun startSync() {
        lifecycleScope.launch(Dispatchers.IO) {
            while (deviceToken != null) {
                try {
                    val m = api.fetchManifest(deviceToken!!, manifestVersion)
                    if (m != null) {
                        manifestVersion = m.version
                        manifest = m.raw
                        applyManifest(m.raw)
                    }
                    flushLogs()
                } catch (_: SignageApi.Unauthorized) {
                    withContext(Dispatchers.Main) { unpair() }
                    return@launch
                } catch (_: Exception) { /* offline: cache local segue tocando */ }
                checkPower()
                delay(60_000)
            }
        }
    }

    private suspend fun applyManifest(m: JSONObject) {
        val settings = m.optJSONObject("settings") ?: JSONObject()
        power.schedule = settings.optJSONObject("powerSchedule")
        withContext(Dispatchers.Main) { playback.applySettings(settings) }

        val items = m.optJSONArray("items") ?: JSONArray()
        // 1) toca imediatamente o que já está em cache
        refreshPlayable(items)
        // 2) baixa o que falta, sequencialmente
        val urls = mutableListOf<String>()
        for (i in 0 until items.length()) {
            val it = items.getJSONObject(i)
            if (it.getString("type") == "webpage") continue // sem WebView neste player
            urls.add(it.getString("url"))
            if (!cache.isCached(it.getString("url"))) {
                try {
                    cache.ensure(it.getString("url"))
                    refreshPlayable(items)
                } catch (_: Exception) { /* tenta no próximo ciclo */ }
            }
        }
        // 3) evicção
        cache.evictExcept(urls)
    }

    private suspend fun refreshPlayable(items: JSONArray) {
        val cached = JSONArray()
        for (i in 0 until items.length()) {
            val it = items.getJSONObject(i)
            if (it.getString("type") != "webpage" && cache.isCached(it.getString("url"))) cached.put(it)
        }
        withContext(Dispatchers.Main) {
            if (power.shouldBeOn()) playback.setPlaylist(cached)
        }
    }

    private fun flushLogs() {
        if (playback.playLog.length() == 0) return
        try {
            api.sendLogs(deviceToken!!, playback.playLog)
            while (playback.playLog.length() > 0) playback.playLog.remove(0)
        } catch (_: Exception) { /* mantém no buffer */ }
    }

    // ---------- energia ----------
    private suspend fun checkPower() {
        val on = power.shouldBeOn()
        power.tvPower(on) // CEC quando privilegiado; no-op caso contrário
        withContext(Dispatchers.Main) {
            findViewById<View>(R.id.powerOffView).visibility = if (on) View.GONE else View.VISIBLE
            if (!on) playback.stop()
            else if (manifest != null && playback.playLog.length() == 0) {
                // religou: repõe a playlist do último manifesto
                lifecycleScope.launch(Dispatchers.IO) {
                    manifest?.optJSONArray("items")?.let { refreshPlayable(it) }
                }
            }
        }
    }

    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION)
    }

    override fun onDestroy() {
        playback.release()
        super.onDestroy()
    }
}
