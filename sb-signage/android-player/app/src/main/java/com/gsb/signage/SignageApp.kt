package com.gsb.signage

import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Process
import android.util.Log
import kotlin.system.exitProcess

/**
 * Recuperação de falha: se o app quebrar, ele reabre sozinho em alguns segundos.
 * Não substitui o watchdog em processo separado previsto no plano técnico (§4.10):
 * cobre exceção do app, não um processo morto pelo sistema nem um aparelho travado.
 */
class SignageApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            Log.e("SBPlayer", "falha fatal em ${thread.name}; reabrindo", error)
            val intent = Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            val pending = PendingIntent.getActivity(
                this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            val alarms = getSystemService(Context.ALARM_SERVICE) as AlarmManager
            alarms.set(AlarmManager.RTC, System.currentTimeMillis() + RESTART_DELAY_MS, pending)
            Process.killProcess(Process.myPid())
            exitProcess(10)
        }
    }

    private companion object {
        const val RESTART_DELAY_MS = 3_000L
    }
}
