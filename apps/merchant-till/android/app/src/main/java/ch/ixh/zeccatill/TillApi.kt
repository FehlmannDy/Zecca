package ch.ixh.zeccatill

import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

/**
 * The till's calls (services/api/src/connectors/till). Network on a background thread, answers on the main thread.
 * A till token can only create, read and cancel this till's charges.
 */
class TillApi(private val api: String, private val token: () -> String?) {

    fun pair(code: String, name: String, done: (Result<Paired>) -> Unit) =
        call("POST", "/v1/till/pair", TillJson.pairBody(code, name), auth = false, parse = TillJson::paired, done = done)

    fun createCharge(amountMinor: Long, reference: String?, done: (Result<Charge>) -> Unit) =
        call("POST", "/v1/till/charges", TillJson.chargeBody(amountMinor, reference), parse = TillJson::charge, done = done)

    fun charge(id: String, done: (Result<Charge>) -> Unit) =
        call("GET", "/v1/till/charges/${enc(id)}", null, parse = TillJson::charge, done = done)

    fun cancel(id: String, done: (Result<Charge>) -> Unit) =
        call("POST", "/v1/till/charges/${enc(id)}/cancel", "{}", parse = TillJson::charge, done = done)

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun <T> call(method: String, path: String, body: String?, auth: Boolean = true, parse: (String) -> T, done: (Result<T>) -> Unit) {
        val bearer = if (auth) token() else null
        pool.execute {
            val r = try {
                Result.success(parse(send(method, path, body, bearer)))
            } catch (e: TillApiError) {
                Result.failure(e)
            } catch (e: Json.ParseError) {
                Result.failure(TillApiError(0, "internal", TillJson.UNKNOWN_ERROR))
            } catch (e: IOException) {
                Result.failure(TillApiError(0, "offline", TillJson.OFFLINE))
            }
            main.post { done(r) }
        }
    }

    private fun send(method: String, path: String, body: String?, bearer: String?): String {
        val c = URL(api + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 10_000
            c.readTimeout = 15_000
            c.useCaches = false
            c.instanceFollowRedirects = false
            c.setRequestProperty("Accept", "application/json")
            if (bearer != null) c.setRequestProperty("Authorization", "Bearer $bearer")
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = c.responseCode
            val stream = if (status in 200..299) c.inputStream else c.errorStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) }
            if (status !in 200..299) throw TillJson.error(status, text)
            return text ?: throw Json.ParseError("Empty answer.")
        } finally {
            c.disconnect()
        }
    }

    companion object {
        private val pool = Executors.newFixedThreadPool(3)
        private val main = Handler(Looper.getMainLooper())
    }
}
