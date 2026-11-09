package com.gsb.signage

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Cliente REST do protocolo SB Signage (mesmo contrato do player web). */
class SignageApi(val baseUrl: String) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS) // download parado por 30 s é abortado e refeito
        .build()
    private val jsonType = "application/json".toMediaType()

    data class Pairing(val code: String, val token: String)

    /** raw == null significa 304: nada mudou. */
    class ManifestResponse(val raw: String?, val serverDateMs: Long?)

    class Unauthorized : IOException("tela removida no painel")
    class PairingExpired : IOException("código expirado")
    class NoSpace : IOException("sem espaço de armazenamento na tela")

    fun absolute(url: String): String = if (url.startsWith("http")) url else baseUrl + url

    /** Portal cativo ou proxy devolvem HTML com status 200: conta como falha de rede. */
    private fun json(body: String): JSONObject = try {
        JSONObject(body)
    } catch (e: JSONException) {
        throw IOException("resposta inválida do servidor", e)
    }

    fun branding(): Branding {
        http.newCall(Request.Builder().url("$baseUrl/api/branding").build()).execute().use {
            if (!it.isSuccessful) throw IOException("branding HTTP ${it.code}")
            return Manifest.parseBranding(json(it.body!!.string()))
        }
    }

    fun requestPairing(): Pairing {
        val req = Request.Builder().url("$baseUrl/api/pair/request").post("".toRequestBody(jsonType)).build()
        http.newCall(req).execute().use {
            if (!it.isSuccessful) throw IOException("pareamento HTTP ${it.code}")
            val body = json(it.body!!.string())
            try {
                return Pairing(body.getString("code"), body.getString("token"))
            } catch (e: JSONException) {
                throw IOException("resposta inválida do servidor", e)
            }
        }
    }

    /** true quando o painel vinculou o código (o token vira a credencial da tela). */
    fun pairingClaimed(token: String): Boolean {
        val req = Request.Builder().url("$baseUrl/api/pair/status")
            .header("X-Device-Token", token).build()
        http.newCall(req).execute().use {
            if (it.code == 404) throw PairingExpired()
            return it.isSuccessful && json(it.body!!.string()).optBoolean("claimed")
        }
    }

    fun fetchManifest(token: String, version: String?): ManifestResponse {
        val req = Request.Builder().url("$baseUrl/api/player/manifest")
            .header("X-Device-Token", token)
        if (version != null) req.header("If-None-Match", "\"$version\"")
        http.newCall(req.build()).execute().use {
            val date = it.headers.getDate("Date")?.time
            return when {
                it.code == 304 -> ManifestResponse(null, date)
                it.code == 401 -> throw Unauthorized()
                !it.isSuccessful -> throw IOException("manifesto HTTP ${it.code}")
                else -> ManifestResponse(it.body!!.string(), date)
            }
        }
    }

    fun sendLogs(token: String, events: JSONArray) {
        val body = JSONObject().put("events", events).toString().toRequestBody(jsonType)
        val req = Request.Builder().url("$baseUrl/api/player/logs")
            .header("X-Device-Token", token).post(body).build()
        http.newCall(req).execute().use {
            if (!it.isSuccessful) throw IOException("logs HTTP ${it.code}")
        }
    }

    /** Baixa para `dest`, informando o progresso (0..1, ou null sem tamanho conhecido). */
    suspend fun download(url: String, dest: File, onProgress: (Float?) -> Unit = {}) {
        http.newCall(Request.Builder().url(absolute(url)).build()).execute().use { res ->
            if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
            val body = res.body!!
            val total = body.contentLength()
            val free = dest.parentFile?.usableSpace ?: Long.MAX_VALUE
            if (total > 0 && free < total + MIN_FREE_BYTES) throw NoSpace()

            dest.outputStream().use { out ->
                val input = body.byteStream()
                val buffer = ByteArray(64 * 1024)
                var received = 0L
                var lastReport = 0L
                while (true) {
                    currentCoroutineContext().ensureActive() // manifesto novo cancela o download
                    val read = input.read(buffer)
                    if (read < 0) break
                    out.write(buffer, 0, read)
                    received += read
                    if (received - lastReport >= REPORT_EVERY_BYTES) {
                        lastReport = received
                        onProgress(if (total > 0) received.toFloat() / total else null)
                    }
                }
            }
        }
    }

    private companion object {
        const val MIN_FREE_BYTES = 50L * 1024 * 1024  // o sistema da TV box também precisa de disco
        const val REPORT_EVERY_BYTES = 512L * 1024
    }
}
