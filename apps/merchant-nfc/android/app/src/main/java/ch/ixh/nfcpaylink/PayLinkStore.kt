package ch.ixh.nfcpaylink

import android.content.Context
import android.content.SharedPreferences

/** The URL currently served, plus a one-line summary of the last NFC tap (shown in the UI). */
object PayLinkStore {
    const val KEY_URL = "url"
    const val KEY_LAST_TAP = "last_tap"

    fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences("paylink", Context.MODE_PRIVATE)

    fun url(ctx: Context): String? = prefs(ctx).getString(KEY_URL, null)

    fun setUrl(ctx: Context, url: String) = prefs(ctx).edit().putString(KEY_URL, url).apply()

    fun clearUrl(ctx: Context) = prefs(ctx).edit().remove(KEY_URL).apply()

    /** The stored URL if [PayLinkPolicy] still allows it (a link saved by an older build may not pass). */
    fun servedUrl(ctx: Context): String? = url(ctx)?.takeIf { PayLinkPolicy.check(it) == null }

    fun lastTap(ctx: Context): String? = prefs(ctx).getString(KEY_LAST_TAP, null)

    fun setLastTap(ctx: Context, summary: String) =
        prefs(ctx).edit().putString(KEY_LAST_TAP, summary).apply()
}
