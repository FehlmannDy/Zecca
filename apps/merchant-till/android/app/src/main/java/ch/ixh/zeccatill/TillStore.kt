package ch.ixh.zeccatill

import android.content.Context

/** The pairing, in this app's private SharedPreferences (never backed up or transferred: android:allowBackup="false", res/xml/data_extraction_rules.xml). */
class TillStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("till", Context.MODE_PRIVATE)

    data class SavedPairing(val api: String, val token: String, val merchantName: String, val tillId: String)

    fun pairing(): SavedPairing? {
        val api = prefs.getString(API, null)
        val token = prefs.getString(TOKEN, null)
        if (api.isNullOrEmpty() || token.isNullOrEmpty()) return null
        return SavedPairing(api, token, prefs.getString(MERCHANT, null).orEmpty(), prefs.getString(TILL, null).orEmpty())
    }

    fun save(api: String, p: Paired) {
        prefs.edit().putString(API, api).putString(TOKEN, p.tillToken).putString(MERCHANT, p.merchantName).putString(TILL, p.tillId).apply()
    }

    fun forget() {
        prefs.edit().remove(TOKEN).remove(MERCHANT).remove(TILL).apply()
    }

    /** The last server used, to prefill the pairing form. */
    fun lastApi(): String? = prefs.getString(API, null)

    private companion object {
        const val API = "api"
        const val TOKEN = "tillToken"
        const val MERCHANT = "merchantName"
        const val TILL = "tillId"
    }
}

/**
 * The pay link the NFC service serves, in process: set while a charge is open on screen with the app in the
 * foreground, cleared otherwise (onPause too). After the app's process ends it is empty, so a tap finds no tag
 * rather than an old charge.
 */
object ServedLink {
    @Volatile var url: String? = null

    /** [charge]'s link if it is open and [onScreen]; https only (http too when [allowHttp], a debug build). */
    fun of(charge: Charge?, onScreen: Boolean, allowHttp: Boolean): String? {
        val url = charge?.takeIf { onScreen && it.status.open }?.url ?: return null
        val scheme = url.startsWith("https://") || (allowHttp && url.startsWith("http://"))
        return url.takeIf { scheme && NdefUri.checkUrl(it) == null }
    }
}
