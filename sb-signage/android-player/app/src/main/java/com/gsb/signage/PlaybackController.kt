package com.gsb.signage

import android.graphics.BitmapFactory
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Loop de reprodução: vídeos via ExoPlayer (decodificação por hardware),
 * imagens via ImageView com timer. Proof-of-play acumulado em memória.
 */
class PlaybackController(
    private val scope: CoroutineScope,
    private val playerView: PlayerView,
    private val imageView: ImageView,
    private val cache: MediaCache
) {
    private var exo: ExoPlayer? = null
    private var items = JSONArray()
    private var index = -1
    private var advanceJob: Job? = null
    private var volume = 1f
    private var muted = false
    val playLog = JSONArray() // { mediaId, name, ts, dur } — MainActivity drena e envia

    fun attach(player: ExoPlayer) {
        exo = player
        playerView.player = player
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) next()
            }
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                next()
            }
        })
    }

    fun applySettings(settings: JSONObject) {
        volume = (settings.optInt("volume", 100) / 100f).coerceIn(0f, 1f)
        muted = settings.optBoolean("muted", false)
        exo?.volume = if (muted) 0f else volume
    }

    /** Recebe os itens do manifesto que já estão em cache. */
    fun setPlaylist(cachedItems: JSONArray) {
        items = cachedItems
        index = -1
        if (items.length() == 0) stop() else next()
    }

    fun stop() {
        advanceJob?.cancel()
        exo?.stop()
        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.GONE
        index = -1
    }

    private fun next() {
        advanceJob?.cancel()
        if (items.length() == 0) return
        index = (index + 1) % items.length()
        val item = items.getJSONObject(index)
        val file = cache.fileFor(item.getString("url"))
        if (file.length() == 0L) { next(); return }

        log(item)
        when (item.getString("type")) {
            "video" -> {
                imageView.visibility = android.view.View.GONE
                playerView.visibility = android.view.View.VISIBLE
                exo?.let {
                    it.volume = if (muted) 0f else volume
                    it.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(file)))
                    it.prepare()
                    it.play()
                }
            }
            else -> { // image
                exo?.stop()
                playerView.visibility = android.view.View.GONE
                imageView.visibility = android.view.View.VISIBLE
                imageView.setImageBitmap(BitmapFactory.decodeFile(file.absolutePath))
                val secs = item.optInt("duration", 10).coerceAtLeast(1)
                advanceJob = scope.launch {
                    delay(secs * 1000L)
                    next()
                }
            }
        }
    }

    private fun log(item: JSONObject) {
        if (playLog.length() >= 500) return
        playLog.put(JSONObject()
            .put("mediaId", item.getString("id"))
            .put("name", item.optString("name"))
            .put("ts", System.currentTimeMillis())
            .put("dur", if (item.getString("type") == "video") item.optInt("mediaDuration", 0)
                        else item.optInt("duration", 10)))
    }

    fun release() {
        advanceJob?.cancel()
        exo?.release()
        exo = null
    }
}
