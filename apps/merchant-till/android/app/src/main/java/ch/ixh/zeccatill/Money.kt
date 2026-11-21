package ch.ixh.zeccatill

/** Integer cents in, text out; text in, integer cents out (packages/contracts/src/money.ts). Never floats. */
object Money {

    data class Parts(val dollars: String, val cents: String)

    /** Dollars with thousands separators, and two-digit cents, for setting cents smaller. */
    fun split(minor: Long): Parts {
        val abs = Math.abs(minor)
        val dollars = (abs / 100).toString().reversed().chunked(3).joinToString(",").reversed()
        return Parts(dollars, (abs % 100).toString().padStart(2, '0'))
    }

    fun format(minor: Long): String {
        val p = split(minor)
        return (if (minor < 0) "-" else "") + "$" + p.dollars + "." + p.cents
    }

    /** "$4.50" -> "4 dollars 50", for screen readers. */
    fun spoken(minor: Long): String {
        val p = split(minor)
        val d = p.dollars.replace(",", "")
        return if (p.cents == "00") "$d dollars" else "$d dollars ${p.cents.toInt()}"
    }

    private val INPUT = Regex("""^(\d{1,9})(?:\.(\d{0,2}))?$""")

    /** What a person typed ("12", "12.5", "12.50", "1,200") in cents, or null. */
    fun parse(input: String): Long? {
        val s = input.trim().removePrefix("$").replace(",", "")
        val m = INPUT.matchEntire(s) ?: return null
        return m.groupValues[1].toLong() * 100 + m.groupValues[2].padEnd(2, '0').toLong()
    }
}

/** The till keypad's text editing (apps/web/lib/keypad.ts): the value stays a string until [Money.parse]. */
object Keypad {
    const val BACK = "back"
    const val MAX_DOLLAR_DIGITS = 7

    fun press(current: String, key: String): String {
        if (key == BACK) return current.dropLast(1)
        if (key == ".") return if (current.contains('.')) current else current.ifEmpty { "0" } + "."
        if (key.length != 1 || key[0] !in '0'..'9') return current
        val dot = current.indexOf('.')
        if (dot >= 0) return if (current.length - dot - 1 >= 2) current else current + key
        if (current == "0") return key
        if (current.length >= MAX_DOLLAR_DIGITS) return current
        return current + key
    }

    fun shown(text: String): String = text.ifEmpty { "0" }
}
