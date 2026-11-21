package ch.ixh.zeccatill

/** A payment request's status as the till shows it (apps/web/components/merchant/till-model.ts, UI.md §5.8). */
enum class ChargeStatus(val api: String?, val line: String, val open: Boolean, private val rank: Int) {
    CREATED("created", "Waiting for the customer", true, 0),
    OPENED("opened", "Customer is paying", true, 1),
    PAID("paid", "Paid", false, 2),
    EXPIRED("expired", "This request has expired.", false, 2),
    CANCELLED("cancelled", "Charge cancelled.", false, 2),
    UNKNOWN(null, "", false, -1);

    companion object {
        fun fromApi(s: String?): ChargeStatus = entries.firstOrNull { it.api != null && it.api == s } ?: UNKNOWN

        /** Polls can arrive out of order: keep the furthest state. */
        fun furthest(current: ChargeStatus, incoming: ChargeStatus): ChargeStatus =
            if (incoming.rank >= current.rank) incoming else current

        /** "9:41" left before the request expires; "0:00" once it has. */
        fun expiresIn(expiresAtMs: Long, nowMs: Long): String {
            val left = expiresAtMs - nowMs
            val s = if (left <= 0) 0 else (left + 999) / 1000
            return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
        }
    }
}

data class Charge(
    val id: String,
    val merchantName: String,
    val amountMinor: Long,
    val reference: String?,
    val status: ChargeStatus,
    val url: String,
    val expiresAtMs: Long,
    val paidAtMs: Long?,
) {
    /** The newer answer about the same charge, unless it would move the charge backwards. */
    fun merge(incoming: Charge): Charge =
        if (incoming.id != id || ChargeStatus.furthest(status, incoming.status) != incoming.status) this else incoming
}

/** ISO 8601 UTC times as the API writes them (Date.toISOString): 2026-11-21T09:10:00.000Z. No java.time below API 26. */
object Iso {
    private val RE = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$""")

    fun parse(s: String): Long {
        val m = RE.matchEntire(s.trim()) ?: throw Json.ParseError("Not an ISO time: $s")
        val g = m.groupValues
        val days = daysFromCivil(g[1].toInt(), g[2].toInt(), g[3].toInt())
        val ms = g[7].padEnd(3, '0').take(3).toLong()
        return ((days * 24 + g[4].toInt()) * 60 + g[5].toInt()) * 60_000 + g[6].toInt() * 1000L + ms
    }

    /** Days since 1970-01-01 (H. Hinnant's days_from_civil). */
    private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
        val y = if (month <= 2) year - 1 else year
        val era = (if (y >= 0) y else y - 399) / 400
        val yoe = y - era * 400
        val mp = (month + 9) % 12
        val doy = (153 * mp + 2) / 5 + day - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097L + doe - 719_468
    }
}
