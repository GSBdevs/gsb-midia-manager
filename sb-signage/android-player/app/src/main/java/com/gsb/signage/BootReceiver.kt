package com.gsb.signage

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Reabre o player quando o aparelho liga ou quando o app é atualizado.
 * A partir do Android 10 isso exige a permissão "sobrepor a outros apps" (ver README).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Log.i("SBPlayer", "abrindo o player após ${intent.action}")
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
