package com.gsb.signage

import android.content.Context
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * Cache de mídia em disco (filesDir/media). Chave = sha1 da URL: as URLs do servidor têm hash
 * de conteúdo, então um arquivo nunca muda. Só entra na rotação o que está 100% baixado.
 */
class MediaCache(context: Context) {
    private val dir = File(context.filesDir, "media").apply { mkdirs() }

    private fun keyFor(url: String): String =
        MessageDigest.getInstance("SHA-1").digest(url.toByteArray())
            .joinToString("") { "%02x".format(it) }

    fun fileFor(url: String): File = File(dir, keyFor(url))

    fun isCached(url: String): Boolean = fileFor(url).length() > 0

    /** Baixa se necessário. Atômico: arquivo incompleto nunca entra na rotação. */
    suspend fun ensure(api: SignageApi, url: String, onProgress: (Float?) -> Unit = {}) {
        val dest = fileFor(url)
        if (dest.length() > 0) return
        val tmp = File(dir, dest.name + TMP)
        try {
            api.download(url, tmp, onProgress)
            if (!tmp.renameTo(dest)) throw IOException("não foi possível gravar o arquivo")
        } finally {
            tmp.delete()
        }
    }

    /** Libera o que saiu do manifesto. Roda ANTES do download: disco de TV box é pequeno. */
    fun evictExcept(validUrls: Collection<String>) {
        val valid = validUrls.map { keyFor(it) }.toSet()
        files().forEach { if (it.name !in valid) it.delete() }
    }

    fun clear() {
        files().forEach { it.delete() }
    }

    fun count(): Int = files().count { !it.name.endsWith(TMP) }

    fun usageBytes(): Long = files().sumOf { it.length() }

    fun quotaBytes(): Long = usageBytes() + dir.usableSpace

    private fun files(): List<File> = dir.listFiles()?.toList() ?: emptyList()

    private companion object {
        const val TMP = ".tmp"
    }
}
