package com.gsb.signage

import android.content.Context
import org.json.JSONObject
import java.util.Calendar

/**
 * Janela de energia vinda do painel ({ on:"HH:MM", off:"HH:MM", days:[0..6] }).
 * Soft power: MainActivity mostra tela preta fora da janela.
 * CEC: só funciona como system-app (permissão android.permission.HDMI_CEC é
 * de plataforma) — o gancho fica isolado aqui para essa evolução.
 */
class PowerScheduler(private val context: Context) {
    var schedule: JSONObject? = null // null = sempre ligada

    fun shouldBeOn(now: Calendar = Calendar.getInstance()): Boolean {
        val ps = schedule ?: return true
        val days = ps.optJSONArray("days") ?: return true
        val today = now.get(Calendar.DAY_OF_WEEK) - 1 // Calendar.SUNDAY=1 → 0
        var dayOk = false
        for (i in 0 until days.length()) if (days.getInt(i) == today) dayOk = true
        if (!dayOk) return false

        val hhmm = String.format("%02d:%02d", now.get(Calendar.HOUR_OF_DAY), now.get(Calendar.MINUTE))
        val on = ps.optString("on", "00:00")
        val off = ps.optString("off", "23:59")
        return if (on <= off) hhmm >= on && hhmm < off
        else hhmm >= on || hhmm < off // janela cruza a meia-noite
    }

    /**
     * Liga/desliga a TV via HDMI-CEC quando possível.
     * Em app comum é um no-op silencioso (sem a permissão de sistema o
     * HdmiControlManager retorna null) — o soft power cobre o resto.
     */
    fun tvPower(on: Boolean) {
        try {
            val mgr = context.getSystemService("hdmi_control") ?: return
            // API oculta/da plataforma: via reflexão para não quebrar o build em SDK público.
            val method = mgr.javaClass.getMethod(if (on) "onTvPowerOn" else "onTvPowerOff")
            method.invoke(mgr)
        } catch (_: Exception) {
            // sem privilégio de sistema: ignora (soft power assume)
        }
    }
}
