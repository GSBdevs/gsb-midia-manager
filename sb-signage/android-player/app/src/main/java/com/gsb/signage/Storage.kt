package com.gsb.signage

import android.content.Context
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** Configuração local e último manifesto: a tela precisa ligar e exibir mesmo sem rede. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("sb", Context.MODE_PRIVATE)
    private val manifestFile = File(context.filesDir, "manifest.json")

    var server: String?
        get() = sp.getString("server", null)
        set(value) = sp.edit().putString("server", value).apply()

    var token: String?
        get() = sp.getString("token", null)
        set(value) = sp.edit().putString("token", value).apply()

    var clockOffsetMs: Long
        get() = sp.getLong("clockOffset", 0)
        set(value) = sp.edit().putLong("clockOffset", value).apply()

    fun loadManifest(): String? = try {
        manifestFile.takeIf { it.exists() }?.readText()
    } catch (_: IOException) {
        null
    }

    /** Escrita atômica: queda de energia não deixa um manifesto pela metade. */
    fun saveManifest(raw: String) {
        val tmp = File(manifestFile.path + ".tmp")
        tmp.writeText(raw)
        if (!tmp.renameTo(manifestFile)) throw IOException("não foi possível salvar o manifesto")
    }

    fun clearManifest() {
        manifestFile.delete()
    }
}

/**
 * Registro de exibição pendente de envio. Fica em disco para sobreviver a queda de energia
 * e a dias sem rede; é base da cobrança de quem vende anúncio.
 */
class PlayLog(private val file: File, private val max: Int = 2000) {
    private val lines = ArrayDeque<String>()

    init {
        try {
            // queda de energia durante a gravação deixa a última linha cortada: ela é descartada
            if (file.exists()) lines.addAll(file.readLines().filter(::isValid).takeLast(max))
        } catch (_: IOException) { /* registro ilegível não impede a exibição */ }
    }

    private fun isValid(line: String): Boolean = try {
        JSONObject(line)
        true
    } catch (_: JSONException) {
        false
    }

    @get:Synchronized
    val size: Int get() = lines.size

    @Synchronized
    fun add(event: JSONObject) {
        val line = event.toString()
        lines.addLast(line)
        while (lines.size > max) lines.removeFirst()
        try {
            file.appendText(line + "\n")
        } catch (_: IOException) { /* disco cheio: segue só em memória */ }
    }

    @Synchronized
    fun peek(count: Int): JSONArray {
        val batch = JSONArray()
        lines.take(count).forEach { batch.put(JSONObject(it)) }
        return batch
    }

    /** Remove só o que o servidor confirmou; o que entrou durante o envio continua na fila. */
    @Synchronized
    fun drop(count: Int) {
        repeat(count.coerceAtMost(lines.size)) { lines.removeFirst() }
        try {
            file.writeText(if (lines.isEmpty()) "" else lines.joinToString("\n", postfix = "\n"))
        } catch (_: IOException) { /* na próxima gravação tenta de novo */ }
    }
}
