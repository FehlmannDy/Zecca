package ch.ixh.zeccatill
// Copied from apps/merchant-nfc (NFC PayLink), unchanged apart from the package.

import java.net.URI

/**
 * Builds a one-record NDEF message holding an NFC Forum URI record (RTD "U").
 * Pure Kotlin, no Android dependencies.
 */
object NdefUri {

    /** URI identifier codes from the NFC Forum URI RTD. Longest prefix first. */
    private val PREFIXES = listOf(
        "https://www." to 0x02,
        "http://www." to 0x01,
        "https://" to 0x04,
        "http://" to 0x03,
    )

    /** Returns an error message, or null if [url] can be served. */
    fun checkUrl(url: String): String? {
        if (url.isBlank() || url.any { it.isWhitespace() }) return "URL is empty or contains spaces"
        val uri = try { URI(url) } catch (e: Exception) { return "Not a valid URL" }
        if (uri.scheme != "https" && uri.scheme != "http") return "URL must start with https:// (or http:// for local tests)"
        if (uri.host.isNullOrEmpty()) return "URL has no host"
        if (url.toByteArray(Charsets.UTF_8).size > 1000) return "URL is too long (max 1000 bytes)"
        return null
    }

    fun message(url: String): ByteArray {
        val prefix = PREFIXES.firstOrNull { url.startsWith(it.first) }
        val code = prefix?.second ?: 0x00
        val rest = if (prefix != null) url.substring(prefix.first.length) else url
        val payload = byteArrayOf(code.toByte()) + rest.toByteArray(Charsets.UTF_8)
        val type = byteArrayOf(0x55) // "U"
        return if (payload.size <= 0xFF) {
            // MB=1 ME=1 CF=0 SR=1 IL=0 TNF=0x01 (well-known)
            byteArrayOf(0xD1.toByte(), type.size.toByte(), payload.size.toByte()) + type + payload
        } else {
            // Same, but SR=0 and a 4-byte payload length
            val n = payload.size
            byteArrayOf(
                0xC1.toByte(), type.size.toByte(),
                (n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte(),
            ) + type + payload
        }
    }
}
