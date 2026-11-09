package com.gsb.signage

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.drawable.Animatable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.ceil
import kotlin.math.max

/**
 * Loop de reprodução: vídeo no ExoPlayer (decodificação por hardware), imagem na ImageView.
 * Tudo roda na thread principal; `seq` invalida timers e decodificações de itens antigos.
 */
class PlaybackController(
    private val context: Context,
    private val scope: CoroutineScope,
    private val videoHost: FrameLayout,
    private val imageView: ImageView,
    private val cache: MediaCache,
    private val listener: Listener
) {
    interface Listener {
        fun onNowPlaying(item: Item)
        fun onPlaybackError(message: String)
        fun onQueueEmpty()
    }

    private val exo = ExoPlayer.Builder(context).build()
    private var playerView: PlayerView? = null
    private var textureMode = false

    private var items: List<Item> = emptyList()
    private var index = -1
    private var current: Item? = null
    private var seq = 0
    private var advanceJob: Job? = null
    private var stallJob: Job? = null
    private var looping = false

    /** true enquanto há item em exibição (ou sendo preparado). */
    val isActive: Boolean get() = current != null

    init {
        exo.addListener(object : Player.Listener {
            override fun onRenderedFirstFrame() {
                // a imagem anterior só sai quando o vídeo já tem imagem: evita piscar preto
                if (current?.type == "video") hideImage()
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED && current?.type == "video" && !looping) next()
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.w(TAG, "erro no vídeo ${current?.name}", error)
                fail("vídeo não reproduziu: ${current?.name}")
            }
        })
    }

    /**
     * SurfaceView é mais leve, mas não gira junto com a tela. Em orientação 0° usa ela;
     * em tela girada, TextureView.
     */
    fun setRotated(rotated: Boolean) {
        if (playerView != null && rotated == textureMode) return
        textureMode = rotated
        playerView?.player = null
        videoHost.removeAllViews()
        val layout = if (rotated) R.layout.video_texture else R.layout.video_surface
        val view = LayoutInflater.from(context).inflate(layout, videoHost, false) as PlayerView
        videoHost.addView(view)
        view.player = exo
        playerView = view
    }

    fun setAudio(volume: Int, muted: Boolean) {
        exo.volume = if (muted) 0f else volume / 100f
    }

    /** Começa a lista do início. */
    fun play(newItems: List<Item>) {
        cancelTimers()
        items = newItems
        index = -1
        current = null
        next()
    }

    /** Troca a lista sem interromper o que está na tela (download novo terminou). */
    fun update(newItems: List<Item>) {
        items = newItems
        val cur = current ?: return
        if (newItems.getOrNull(index)?.id != cur.id) index = newItems.indexOfFirst { it.id == cur.id }
    }

    /** Exibe um item sem parar (emergência). false se a mídia ainda não está disponível. */
    fun playLoop(item: Item, streamUrl: String): Boolean {
        val file = cache.fileFor(item.url)
        val cached = file.length() > 0
        if (item.type == "video") {
            stop()
            looping = true
            current = item
            val uri = if (cached) Uri.fromFile(file) else Uri.parse(streamUrl)
            exo.repeatMode = Player.REPEAT_MODE_ONE
            exo.setMediaItem(MediaItem.fromUri(uri))
            exo.prepare()
            exo.play()
            return true
        }
        if (!cached) return false
        stop()
        looping = true
        current = item
        val run = seq
        scope.launch {
            val drawable = withContext(Dispatchers.Default) { decode(file) }
            if (run == seq && drawable != null) showImage(drawable)
        }
        return true
    }

    fun stop() {
        seq++
        cancelTimers()
        index = -1
        current = null
        looping = false
        exo.repeatMode = Player.REPEAT_MODE_OFF
        exo.stop()
        exo.clearMediaItems()
        imageView.setImageDrawable(null)
        hideImage()
    }

    fun release() {
        cancelTimers()
        exo.release()
    }

    private fun next() {
        val run = ++seq
        cancelTimers()
        if (items.isEmpty()) {
            stop()
            listener.onQueueEmpty()
            return
        }
        index = (index + 1) % items.size
        val item = items[index]
        current = item
        val file = cache.fileFor(item.url)
        when {
            file.length() == 0L -> fail("arquivo ausente: ${item.name}")
            item.type == "video" -> playVideo(item, file)
            else -> playImage(item, file, run)
        }
    }

    private fun playVideo(item: Item, file: File) {
        exo.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
        exo.prepare()
        exo.play()
        listener.onNowPlaying(item)
        watchStall()
    }

    private fun playImage(item: Item, file: File, run: Int) {
        scope.launch {
            val drawable = withContext(Dispatchers.Default) { decode(file) }
            if (run != seq) return@launch
            if (drawable == null) {
                fail("imagem não suportada: ${item.name}")
                return@launch
            }
            showImage(drawable)
            exo.stop()
            listener.onNowPlaying(item)
            advanceJob = scope.launch {
                delay(item.duration * 1000L)
                if (run == seq) next()
            }
        }
    }

    private fun showImage(drawable: Drawable) {
        imageView.setImageDrawable(drawable)
        imageView.visibility = View.VISIBLE
        (drawable as? Animatable)?.start() // GIF e WebP animados
    }

    private fun hideImage() {
        imageView.visibility = View.GONE
    }

    /** Vídeo que para de avançar (decoder travado) é pulado: a tela nunca fica parada. */
    private fun watchStall() {
        val run = seq
        stallJob = scope.launch {
            var last = -1L
            var since = System.currentTimeMillis()
            while (run == seq) {
                delay(STALL_CHECK_MS)
                val position = exo.currentPosition
                if (position != last) {
                    last = position
                    since = System.currentTimeMillis()
                } else if (System.currentTimeMillis() - since > STALL_LIMIT_MS) {
                    fail("vídeo travado: ${current?.name}")
                    return@launch
                }
            }
        }
    }

    /** Pausa antes de avançar: uma playlist só com itens ruins não vira loop sem freio. */
    private fun fail(message: String) {
        if (looping) return
        listener.onPlaybackError(message)
        val run = seq
        cancelTimers()
        advanceJob = scope.launch {
            delay(ERROR_DELAY_MS)
            if (run == seq) next()
        }
    }

    private fun cancelTimers() {
        advanceJob?.cancel()
        stallJob?.cancel()
    }

    private fun decode(file: File): Drawable? = try {
        if (Build.VERSION.SDK_INT >= 28) {
            ImageDecoder.decodeDrawable(ImageDecoder.createSource(file)) { decoder, info, _ ->
                decoder.setTargetSampleSize(sampleFor(info.size.width, info.size.height))
            }
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            val options = BitmapFactory.Options().apply {
                inSampleSize = sampleFor(bounds.outWidth, bounds.outHeight)
            }
            BitmapFactory.decodeFile(file.path, options)?.let { BitmapDrawable(context.resources, it) }
        }
    } catch (e: Exception) {
        Log.w(TAG, "imagem ilegível: ${file.name}", e)
        null
    } catch (e: OutOfMemoryError) {
        Log.w(TAG, "imagem grande demais: ${file.name}", e)
        null
    }

    // GIF, WebP e AVIF chegam sem redução do servidor; bitmap enorme derruba o app.
    private fun sampleFor(width: Int, height: Int): Int =
        max(1, ceil(max(width, height) / MAX_IMAGE_SIDE.toDouble()).toInt())

    private companion object {
        const val TAG = "SBPlayback"
        const val STALL_CHECK_MS = 2_000L
        const val STALL_LIMIT_MS = 20_000L
        const val ERROR_DELAY_MS = 1_500L
        const val MAX_IMAGE_SIDE = 2560
    }
}
