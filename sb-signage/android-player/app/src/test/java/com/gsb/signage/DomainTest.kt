package com.gsb.signage

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class DomainTest {
    private val friday = 5
    private val saturday = 6

    @Test
    fun `janela no mesmo dia`() {
        val days = setOf(friday)
        assertTrue(Schedule.weeklyWindowActive(days, "08:00", "18:00", "08:00", friday))
        assertFalse("o fim não entra", Schedule.weeklyWindowActive(days, "08:00", "18:00", "18:00", friday))
        assertFalse(Schedule.weeklyWindowActive(days, "08:00", "18:00", "12:00", saturday))
    }

    @Test
    fun `janela noturna começa no dia marcado e termina no seguinte`() {
        val days = setOf(friday)
        assertTrue(Schedule.weeklyWindowActive(days, "22:00", "02:00", "23:00", friday))
        assertTrue("madrugada de sábado", Schedule.weeklyWindowActive(days, "22:00", "02:00", "01:00", saturday))
        assertFalse("madrugada da própria sexta", Schedule.weeklyWindowActive(days, "22:00", "02:00", "01:00", friday))
    }

    @Test
    fun `início igual ao fim vale o dia inteiro`() {
        assertTrue(Schedule.weeklyWindowActive(setOf(1), "00:00", "00:00", "13:37", 1))
        assertFalse(Schedule.weeklyWindowActive(setOf(1), "00:00", "00:00", "13:37", 2))
    }

    @Test
    fun `hora vem no fuso do servidor, não no do aparelho`() {
        // 2026-11-06 01:30 UTC = quinta-feira 22:30 em São Paulo
        val epoch = java.time.Instant.parse("2026-11-06T01:30:00Z").toEpochMilli()
        val parts = ServerClock.partsAt(epoch, "America/Sao_Paulo")
        assertEquals("22:30", parts.hhmm)
        assertEquals(4, parts.day)
    }

    @Test
    fun `relógio corrige aparelho com hora errada`() {
        val clock = ServerClock(localNow = { 1_000L })
        clock.sync(61_000L)
        assertEquals(60_000L, clock.offsetMs)
        assertEquals(61_000L, clock.now())
    }

    @Test
    fun `endereço do servidor`() {
        assertEquals("http://192.168.0.10:4000", ServerAddress.normalize(" 192.168.0.10:4000/ "))
        assertEquals("https://telas.cliente.com.br", ServerAddress.normalize("https://telas.cliente.com.br/"))
        assertNull(ServerAddress.normalize(""))
        assertNull(ServerAddress.normalize("ftp://x"))
    }

    private val sample = """
        {"format":2,"version":"abc","deviceName":"TV","settings":{"orientation":90,"volume":30,"muted":false,
         "overlay":{"ticker":" oferta ","showClock":true},
         "powerSchedule":{"on":"08:00","off":"18:00","days":[1,2]},"timezone":"America/Sao_Paulo"},
         "branding":{"brandName":"Loja","accent":"#ff0000","logoUrl":null},
         "emergency":null,
         "items":[
          {"id":"1","name":"foto","type":"image","url":"/m/a.jpg","hls":null,"duration":7,"mediaDuration":null},
          {"id":"2","name":"filme","type":"video","url":"/m/b.mp4","hls":null,"duration":null,"mediaDuration":12.5},
          {"id":"3","name":"site","type":"webpage","url":"https://x","duration":9}]}
    """.trimIndent()

    @Test
    fun `lê o manifesto formato 2`() {
        val m = Manifest.parse(sample)
        assertEquals(90, m.settings.orientation)
        assertEquals("oferta", m.settings.ticker)
        assertEquals(setOf(1, 2), m.settings.powerSchedule?.days)
        assertNull(m.branding.logoUrl)
        assertNull(m.emergency)
        assertEquals(7, m.items[0].duration)
        assertEquals(12, m.items[1].mediaDuration)
        assertEquals("página web não vai para o cache", listOf("/m/a.jpg", "/m/b.mp4"), m.cacheableUrls)
    }

    @Test
    fun `emergência em texto e em mídia`() {
        val texto = Manifest.parse(
            sample.replace("\"emergency\":null", "\"emergency\":{\"type\":\"message\",\"message\":\"FOGO\"}")
        )
        assertEquals("FOGO", texto.emergency?.message)
        assertNull(texto.emergency?.item)

        val midia = Manifest.parse(
            sample.replace(
                "\"emergency\":null",
                "\"emergency\":{\"id\":\"9\",\"name\":\"alerta\",\"type\":\"image\",\"url\":\"/m/z.jpg\",\"duration\":10}"
            )
        )
        assertEquals("/m/z.jpg", midia.emergency?.item?.url)
        assertTrue("mídia de emergência também vai para o cache", "/m/z.jpg" in midia.cacheableUrls)
    }

    @Test
    fun `ajuste de configuração não muda a assinatura dos itens`() {
        val a = Manifest.parse(sample)
        val b = Manifest.parse(sample.replace("\"volume\":30", "\"volume\":80"))
        val c = Manifest.parse(sample.replace("\"duration\":7", "\"duration\":8"))
        assertEquals(a.itemsSignature, b.itemsSignature)
        assertNotEquals(a.itemsSignature, c.itemsSignature)
    }

    @Test
    fun `registro de exibição sobrevive a reinício e só sai o que foi confirmado`() {
        val file = File(Files.createTempDirectory("sb").toFile(), "log.jsonl")
        val log = PlayLog(file)
        repeat(3) { log.add(JSONObject().put("mediaId", "m$it")) }

        val batch = PlayLog(file).peek(2)
        assertEquals(2, batch.length())
        log.add(JSONObject().put("mediaId", "m3")) // chegou durante o envio
        log.drop(batch.length())

        val reopened = PlayLog(file)
        assertEquals(2, reopened.size)
        assertEquals("m2", reopened.peek(1).getJSONObject(0).getString("mediaId"))
    }

    @Test
    fun `linha cortada por queda de energia é descartada`() {
        val file = File(Files.createTempDirectory("sb").toFile(), "log.jsonl")
        file.writeText("{\"mediaId\":\"ok\"}" + "\n" + "{\"mediaId\":\"cor")
        val log = PlayLog(file)
        assertEquals(1, log.size)
        assertEquals("ok", log.peek(5).getJSONObject(0).getString("mediaId"))
    }

    @Test
    fun `registro de exibição tem limite`() {
        val file = File(Files.createTempDirectory("sb").toFile(), "log.jsonl")
        val log = PlayLog(file, max = 2)
        repeat(5) { log.add(JSONObject().put("mediaId", "m$it")) }
        assertEquals(2, log.size)
        assertEquals("m3", log.peek(1).getJSONObject(0).getString("mediaId"))
    }
}
