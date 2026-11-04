package com.gsb.signage

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Cliente REST do protocolo SB Signage (mesmo contrato do player web). */
class SignageApi(private val baseUrl: String) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val json = "application/json".toMediaType()

    data class Pairing(val code: String, val token: String)
    data class Manifest(val version: String, val raw: JSONObject)

    /** Pede um código de pareamento. */
    fun requestPairing(): Pairing {
        val res = http.newCall(
            Request.Builder().url("$baseUrl/api/pair/request").post("".toRequestBody(json)).build()
        ).execute()
        res.use {
            val body = JSONObject(it.body!!.string())
            return Pairing(body.getString("code"), body.getString("token"))
        }
    }

    /** true quando o painel reivindicou o código (token virou credencial). */
    fun pairingClaimed(token: String): Boolean {
        val res = http.newCall(
            Request.Builder().url("$baseUrl/api/pair/status")
                .header("X-Device-Token", token).build()
        ).execute()
        res.use {
            if (it.code == 404) throw PairingExpired()
            return it.isSuccessful && JSONObject(it.body!!.string()).optBoolean("claimed")
        }
    }

    /** Busca o manifesto; retorna null em 304 (nada mudou). Lança Unauthorized em 401. */
    fun fetchManifest(token: String, etag: String?): Manifest? {
        val req = Request.Builder().url("$baseUrl/api/player/manifest")
            .header("X-Device-Token", token)
        if (etag != null) req.header("If-None-Match", etag)
        val res = http.newCall(req.build()).execute()
        res.use {
            when {
                it.code == 304 -> return null
                it.code == 401 -> throw Unauthorized()
                !it.isSuccessful -> throw RuntimeException("manifest HTTP ${it.code}")
            }
            val body = JSONObject(it.body!!.string())
            return Manifest(body.getString("version"), body)
        }
    }

    /** Envia lote de proof-of-play. */
    fun sendLogs(token: String, events: JSONArray) {
        val body = JSONObject().put("events", events).toString().toRequestBody(json)
        http.newCall(
            Request.Builder().url("$baseUrl/api/player/logs")
                .header("X-Device-Token", token).post(body).build()
        ).execute().close()
    }

    /** Baixa uma mídia para o arquivo destino (usado pelo MediaCache). */
    fun download(url: String, dest: java.io.File) {
        val full = if (url.startsWith("http")) url else "$baseUrl$url"
        val res = http.newCall(Request.Builder().url(full).build()).execute()
        res.use {
            if (!it.isSuccessful) throw RuntimeException("download HTTP ${it.code}")
            dest.outputStream().use { out -> it.body!!.byteStream().copyTo(out) }
        }
    }

    class Unauthorized : RuntimeException()
    class PairingExpired : RuntimeException()
}
