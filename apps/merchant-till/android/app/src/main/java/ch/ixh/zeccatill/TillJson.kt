package ch.ixh.zeccatill

data class Paired(val tillToken: String, val merchantName: String, val tillId: String)

/** An API error: its message is written to be shown as is (UI.md §6). Status 0 means the API was not reached. */
class TillApiError(val status: Int, val code: String, override val message: String) : Exception(message)

/** The till API's JSON (services/api/src/connectors/till), in and out. */
object TillJson {

    const val UNKNOWN_ERROR = "Something went wrong on our side. Try again in a moment."
    const val OFFLINE = "Can't reach Zecca right now. Check your connection and try again."

    fun charge(json: String): Charge {
        val o = obj(json)
        return Charge(
            id = str(o, "id"),
            merchantName = o["merchantName"] as? String ?: "",
            amountMinor = o["amountMinor"] as? Long ?: throw Json.ParseError("No amountMinor."),
            reference = (o["reference"] as? String)?.takeIf { it.isNotBlank() },
            status = ChargeStatus.fromApi(o["status"] as? String),
            url = str(o, "url"),
            expiresAtMs = Iso.parse(str(o, "expiresAt")),
            paidAtMs = (o["paidAt"] as? String)?.let(Iso::parse),
        )
    }

    fun paired(json: String): Paired {
        val o = obj(json)
        return Paired(str(o, "tillToken"), o["merchantName"] as? String ?: "", str(o, "tillId"))
    }

    fun error(status: Int, body: String?): TillApiError {
        val e = try { body?.let { (obj(it)["error"] as? Map<*, *>) } } catch (x: Json.ParseError) { null }
        val message = e?.get("message") as? String
        val code = e?.get("code") as? String
        return if (message.isNullOrBlank()) TillApiError(status, if (status >= 500 || status == 0) "internal" else "bad_request", UNKNOWN_ERROR)
        else TillApiError(status, code ?: "error", message)
    }

    fun pairBody(code: String, name: String): String = Json.obj("code" to code, "name" to name)

    fun chargeBody(amountMinor: Long, reference: String?): String {
        val ref = reference?.trim().orEmpty()
        return if (ref.isEmpty()) Json.obj("amountMinor" to amountMinor) else Json.obj("amountMinor" to amountMinor, "reference" to ref)
    }

    private fun obj(json: String): Map<*, *> = Json.parse(json) as? Map<*, *> ?: throw Json.ParseError("Not a JSON object.")

    private fun str(o: Map<*, *>, k: String): String =
        (o[k] as? String)?.takeIf { it.isNotEmpty() } ?: throw Json.ParseError("No $k.")
}
