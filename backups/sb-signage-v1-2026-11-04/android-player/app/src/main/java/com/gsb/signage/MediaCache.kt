package com.gsb.signage

import android.content.Context
import java.io.File
import java.security.MessageDigest

/**
 * Cache de mídia em disco (filesDir/media). Chave = sha1 da URL — as URLs do
 * servidor já têm hash de conteúdo, então um arquivo nunca muda de conteúdo.
 * Offline-first: só entra na rotação o que está 100% baixado.
 */
class MediaCache(context: Context, private val api: SignageApi) {
    private val dir = File(context.filesDir, "media").apply { mkdirs() }

    private fun keyFor(url: String): String =
        MessageDigest.getInstance("SHA-1").digest(url.toByteArray())
            .joinToString("") { "%02x".format(it) }

    fun fileFor(url: String): File = File(dir, keyFor(url))

    fun isCached(url: String): Boolean = fileFor(url).length() > 0

    /** Baixa se necessário (atômico via arquivo temporário). */
    fun ensure(url: String) {
        val dest = fileFor(url)
        if (dest.length() > 0) return
        val tmp = File(dir, dest.name + ".tmp")
        try {
            api.download(url, tmp)
            if (!tmp.renameTo(dest)) throw RuntimeException("rename falhou")
        } finally {
            tmp.delete()
        }
    }

    /** Remove do cache tudo que não está na lista de URLs válidas. */
    fun evictExcept(validUrls: Collection<String>) {
        val valid = validUrls.map { keyFor(it) }.toSet()
        dir.listFiles()?.forEach { f ->
            if (!f.name.endsWith(".tmp") && f.name !in valid) f.delete()
        }
    }

    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
    }
}
