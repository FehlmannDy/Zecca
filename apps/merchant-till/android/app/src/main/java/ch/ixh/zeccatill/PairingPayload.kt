package ch.ixh.zeccatill

import java.net.URI
import java.net.URLDecoder

data class Pairing(val api: String, val code: String)

/**
 * The pairing link the merchant space shows as a QR code (services/api/src/connectors/till):
 * zecca-till://pair?api=<encoded API origin>&code=<8 characters>. Anyone can show this phone a QR code, so the API
 * must be one of Zecca's servers, over https (http only for localhost and the emulator's host, in a debug build).
 */
object PairingPayload {

    const val PROD_API = "https://zecca-api-production.up.railway.app"
    const val PREFIX = "zecca-till://pair?"
    /** Same alphabet as the API's codes: no 0/O, 1/I/L. */
    const val CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
    const val CODE_LENGTH = 8

    private val HOSTS = setOf("zecca-api-production.up.railway.app", "localhost", "10.0.2.2")
    private val LOCAL = setOf("localhost", "10.0.2.2")

    sealed interface Result {
        data class Ok(val pairing: Pairing) : Result
        data class Refused(val reason: String) : Result
    }

    const val NOT_A_PAIRING_CODE = "This is not a Zecca Till pairing code. Scan the code in your Zecca merchant space."
    const val BAD_CODE = "Type the 8-character code shown in your Zecca merchant space."

    fun parse(raw: String, allowHttp: Boolean): Result {
        val s = raw.trim()
        if (!s.startsWith(PREFIX, ignoreCase = true)) return Result.Refused(NOT_A_PAIRING_CODE)
        val params = HashMap<String, String>()
        for (part in s.substring(PREFIX.length).split('&')) {
            val eq = part.indexOf('=')
            if (eq <= 0) continue
            val v = try { URLDecoder.decode(part.substring(eq + 1), "UTF-8") } catch (e: IllegalArgumentException) { return Result.Refused(NOT_A_PAIRING_CODE) }
            params[part.substring(0, eq)] = v
        }
        val api = params["api"] ?: return Result.Refused(NOT_A_PAIRING_CODE)
        val code = params["code"]?.let(::normalizeCode) ?: return Result.Refused(BAD_CODE)
        checkApi(api, allowHttp)?.let { return Result.Refused(it) }
        return Result.Ok(Pairing(normalizeApi(api), code))
    }

    /** Null when the till may talk to [api], otherwise why not. */
    fun checkApi(api: String, allowHttp: Boolean): String? {
        val s = api.trim().trimEnd('/')
        val uri = try { URI(s) } catch (e: Exception) { return "This is not a valid server address." }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "https" && scheme != "http") return "The server address must start with https://."
        if (uri.rawUserInfo != null || s.contains('@')) return "This is not a Zecca server."
        val host = uri.host?.lowercase() ?: return "This is not a valid server address."
        if (!uri.rawPath.isNullOrEmpty() || uri.rawQuery != null || uri.rawFragment != null) {
            return "The server address must be like $PROD_API, with nothing after it."
        }
        if (host !in HOSTS) return "This is not a Zecca server: $host."
        if (scheme == "http" && !(allowHttp && host in LOCAL)) return "Only secure server addresses (https://) can be used."
        return null
    }

    /** "  HTTPS://Zecca-API-production.up.railway.app/ " -> "https://zecca-api-production.up.railway.app". */
    fun normalizeApi(api: String): String {
        val s = api.trim().trimEnd('/')
        val uri = try { URI(s) } catch (e: Exception) { return s }
        val scheme = uri.scheme?.lowercase() ?: return s
        val host = uri.host?.lowercase() ?: return s
        return "$scheme://$host" + (if (uri.port >= 0) ":${uri.port}" else "")
    }

    /** " abcd-2345 " -> "ABCD2345", or null when it is not a code. */
    fun normalizeCode(raw: String): String? {
        val c = raw.uppercase().filterNot { it.isWhitespace() || it == '-' }
        return if (c.length == CODE_LENGTH && c.all { it in CODE_ALPHABET }) c else null
    }
}
