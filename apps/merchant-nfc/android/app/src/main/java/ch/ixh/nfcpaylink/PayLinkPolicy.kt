package ch.ixh.nfcpaylink

import java.net.URI
import java.net.URLDecoder

/**
 * Decides which links this phone may send over NFC. Any app can start MainActivity with a link,
 * so every link (Chrome intent: link, zecca-nfc:// deep link, typed in) must pass [check]:
 * https only, host on the allowlist, path /pay/<id>. Pure Kotlin, no Android dependencies.
 *
 * The allowlist is the Gradle property `zeccaNfcHosts` (android/gradle.properties, or
 * `./gradlew assembleDebug -PzeccaNfcHosts=pay.example.com`), compiled into BuildConfig.
 */
object PayLinkPolicy {

    const val MAX_URL_BYTES = 1000
    const val DEEP_LINK_PREFIX = "zecca-nfc://emit?"

    private val PAY_PATH = Regex("/pay/[A-Za-z0-9_-]{1,80}")
    private val HOST_NAME = Regex("[a-z0-9-]+(\\.[a-z0-9-]+)*")

    sealed interface Incoming {
        data object None : Incoming
        data class Accepted(val url: String) : Incoming
        data class Refused(val reason: String) : Incoming
    }

    val configuredHosts: List<String> by lazy { parseHosts(BuildConfig.PAYLINK_HOSTS) }

    /**
     * Comma-separated host names. `*.example.com` allows any subdomain of example.com (not
     * example.com itself). Entries that are not plain host names are dropped, so `*`, `*.com`
     * or `a.*.com` never widen the list.
     */
    fun parseHosts(csv: String): List<String> =
        csv.split(',').map { it.trim().lowercase() }.filter { entry ->
            if (entry.startsWith("*.")) {
                val rest = entry.removePrefix("*.")
                rest.contains('.') && HOST_NAME.matches(rest)
            } else {
                HOST_NAME.matches(entry)
            }
        }

    /** Returns null if [url] may be sent, otherwise the reason, for the merchant. */
    fun check(url: String?, hosts: List<String> = configuredHosts): String? {
        if (url.isNullOrEmpty()) return "No payment link received."
        if (url.toByteArray(Charsets.UTF_8).size > MAX_URL_BYTES) return "This link is too long (max $MAX_URL_BYTES characters)."
        if (url.any { it.code !in 0x21..0x7E || it == '\\' }) return "This link contains spaces or unusual characters."
        if (!url.startsWith("https://")) return "Only secure links (https://) can be sent."
        val uri = try { URI(url) } catch (e: Exception) { return "This is not a valid link." }
        if (uri.rawUserInfo != null || uri.rawAuthority?.contains('@') == true) {
            return "This link hides its real address (it contains @)."
        }
        val host = uri.host?.lowercase()
        if (host.isNullOrEmpty()) return "This link has no valid address."
        if (!hosts.any { hostMatches(host, it) }) return "This is not a Zecca payment link: $host is not allowed."
        if (!PAY_PATH.matches(uri.rawPath ?: "")) return "This is not a Zecca payment link: it must open a /pay/ page."
        return null
    }

    /**
     * What MainActivity received. [data] is the intent's data URI (the deep link
     * `zecca-nfc://emit?url=<encoded>`); [extraUrl] is the `url` string extra (Chrome intent: link,
     * adb). The deep link wins when both are present.
     */
    fun incoming(data: String?, extraUrl: String?, hosts: List<String> = configuredHosts): Incoming {
        val url = when {
            data != null -> deepLinkUrl(data) ?: return Incoming.Refused("This app link is not valid.")
            extraUrl != null -> extraUrl
            else -> return Incoming.None
        }
        return check(url, hosts)?.let { Incoming.Refused(it) } ?: Incoming.Accepted(url)
    }

    /** The decoded `url` parameter of `zecca-nfc://emit?url=…`, or null if the link is malformed. */
    private fun deepLinkUrl(data: String): String? {
        if (!data.startsWith(DEEP_LINK_PREFIX)) return null
        val values = data.removePrefix(DEEP_LINK_PREFIX).split('&')
            .filter { it.startsWith("url=") }
            .map { it.removePrefix("url=") }
        if (values.size != 1) return null
        return try { URLDecoder.decode(values[0], "UTF-8") } catch (e: IllegalArgumentException) { null }
    }

    private fun hostMatches(host: String, entry: String): Boolean =
        if (entry.startsWith("*.")) host.endsWith(entry.substring(1)) && host.length > entry.length - 1
        else host == entry
}
