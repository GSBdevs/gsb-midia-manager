package com.gsb.signage

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

// Regras puras (sem Android): espelham server/domain/manifest.js e public/player/player.js.
// Cobertas por testes em src/test — rode com `./gradlew testDebugUnitTest`.

data class Item(
    val id: String,
    val name: String,
    val type: String,          // image | video | webpage
    val url: String,
    val duration: Int,         // segundos (imagem/página)
    val mediaDuration: Int     // segundos (vídeo)
) {
    val isLocalMedia get() = type == "image" || type == "video"
}

data class PowerSchedule(val on: String, val off: String, val days: Set<Int>)

data class Settings(
    val orientation: Int = 0,
    val volume: Int = 100,
    val muted: Boolean = false,
    val ticker: String = "",
    val showClock: Boolean = false,
    val powerSchedule: PowerSchedule? = null,
    val timezone: String? = null
)

data class Branding(
    val brandName: String = "SB Signage",
    val accent: String = "#ffd60a",
    val logoUrl: String? = null
)

data class Emergency(val message: String, val item: Item?)

class Manifest(
    val version: String,
    val deviceName: String,
    val settings: Settings,
    val branding: Branding,
    val emergency: Emergency?,
    val items: List<Item>
) {
    /** Muda só quando a lista muda: ajuste de volume ou rodapé não recomeça a playlist. */
    val itemsSignature: String = items.joinToString("|") { "${it.id}:${it.url}:${it.duration}" }

    /** O que precisa estar em disco, inclusive a mídia de emergência. */
    val cacheableUrls: List<String> =
        (items + listOfNotNull(emergency?.item)).filter { it.isLocalMedia }.map { it.url }.distinct()

    companion object {
        const val SUPPORTED_FORMAT = 2

        fun parse(raw: String): Manifest {
            val json = JSONObject(raw)
            val list = json.optJSONArray("items")
            val items = (0 until (list?.length() ?: 0)).mapNotNull { parseItem(list!!.getJSONObject(it)) }
            return Manifest(
                version = json.getString("version"),
                deviceName = json.str("deviceName") ?: "",
                settings = parseSettings(json.optJSONObject("settings")),
                branding = parseBranding(json.optJSONObject("branding")),
                emergency = parseEmergency(json.optJSONObject("emergency")),
                items = items
            )
        }

        private fun parseItem(o: JSONObject): Item? {
            val id = o.str("id") ?: return null
            val url = o.str("url") ?: return null
            val type = o.str("type") ?: return null
            return Item(
                id = id,
                name = o.str("name") ?: "",
                type = type,
                url = url,
                duration = o.optInt("duration", 10).coerceAtLeast(1),
                mediaDuration = o.optDouble("mediaDuration", 0.0).let { if (it.isNaN()) 0 else it.toInt() }
            )
        }

        private fun parseSettings(o: JSONObject?): Settings {
            if (o == null) return Settings()
            val overlay = o.optJSONObject("overlay")
            return Settings(
                orientation = o.optInt("orientation", 0),
                volume = o.optInt("volume", 100).coerceIn(0, 100),
                muted = o.optBoolean("muted", false),
                ticker = overlay?.str("ticker")?.trim() ?: "",
                showClock = overlay?.optBoolean("showClock", false) ?: false,
                powerSchedule = parsePower(o.optJSONObject("powerSchedule")),
                timezone = o.str("timezone")
            )
        }

        private fun parsePower(o: JSONObject?): PowerSchedule? {
            if (o == null) return null
            val on = o.str("on") ?: return null
            val off = o.str("off") ?: return null
            val days = o.optJSONArray("days") ?: return null
            return PowerSchedule(on, off, (0 until days.length()).map { days.getInt(it) }.toSet())
        }

        fun parseBranding(o: JSONObject?): Branding {
            if (o == null) return Branding()
            return Branding(
                brandName = o.str("brandName") ?: "SB Signage",
                accent = o.str("accent") ?: "#ffd60a",
                logoUrl = o.str("logoUrl")
            )
        }

        private fun parseEmergency(o: JSONObject?): Emergency? {
            if (o == null) return null
            return Emergency(o.str("message") ?: o.str("name") ?: "", parseItem(o))
        }

        /** optString devolve o texto "null" para JSON null; aqui null continua null. */
        private fun JSONObject.str(key: String): String? =
            if (isNull(key)) null else getString(key)
    }
}

object Schedule {
    /**
     * Os dias marcados são os dias em que a janela COMEÇA:
     * "sexta 22:00 → 02:00" vai até a madrugada de sábado (igual a weeklyWindowActive no servidor).
     */
    fun weeklyWindowActive(days: Set<Int>, start: String, end: String, hhmm: String, day: Int): Boolean {
        if (start == end) return day in days
        if (start < end) return day in days && hhmm >= start && hhmm < end
        val previous = (day + 6) % 7
        return (day in days && hhmm >= start) || (previous in days && hhmm < end)
    }
}

/** Hora do servidor: TV box costuma ter relógio e fuso errados. */
class ServerClock(initialOffsetMs: Long = 0, private val localNow: () -> Long = System::currentTimeMillis) {
    @Volatile
    var offsetMs: Long = initialOffsetMs
        private set

    data class Parts(val hhmm: String, val day: Int)

    fun now(): Long = localNow() + offsetMs

    fun sync(serverDateMs: Long) {
        offsetMs = serverDateMs - localNow()
    }

    fun parts(timezone: String?): Parts = partsAt(now(), timezone)

    companion object {
        fun partsAt(epochMs: Long, timezone: String?): Parts {
            val tz = if (timezone.isNullOrEmpty()) TimeZone.getDefault() else TimeZone.getTimeZone(timezone)
            val cal = Calendar.getInstance(tz, Locale.ROOT).apply { timeInMillis = epochMs }
            val hhmm = String.format(
                Locale.ROOT, "%02d:%02d", cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE)
            )
            return Parts(hhmm, cal.get(Calendar.DAY_OF_WEEK) - 1) // domingo = 0, como no servidor
        }
    }
}

object ServerAddress {
    /** Aceita "192.168.0.10:4000" ou "https://telas.cliente.com.br/"; null se for inválido. */
    fun normalize(input: String?): String? {
        val text = input?.trim()?.trimEnd('/') ?: return null
        if (text.isEmpty()) return null
        val full = if (text.contains("://")) text else "http://$text"
        val url = full.toHttpUrlOrNull() ?: return null
        return full.takeIf { url.scheme == "http" || url.scheme == "https" }
    }
}
