package ch.ixh.zeccatill

/**
 * The small JSON the till needs: parse an API answer into maps, lists, strings, Long, Double, Boolean and null,
 * and write a flat request body. Pure Kotlin (org.json is not on the JVM test classpath).
 */
object Json {

    class ParseError(message: String) : Exception(message)

    fun parse(text: String): Any? {
        val p = Parser(text)
        p.space()
        val v = p.value()
        p.space()
        if (!p.done()) throw ParseError("Unexpected text after the JSON value.")
        return v
    }

    /** {"k":v,...} with String, Long/Int, Boolean or null values. */
    fun obj(vararg pairs: Pair<String, Any?>): String =
        pairs.joinToString(",", "{", "}") { (k, v) -> "${str(k)}:${value(v)}" }

    private fun value(v: Any?): String = when (v) {
        null -> "null"
        is String -> str(v)
        is Long, is Int -> v.toString()
        is Boolean -> v.toString()
        else -> throw IllegalArgumentException("Unsupported JSON value: ${v::class.simpleName}")
    }

    private fun str(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) {
            when {
                c == '"' -> b.append("\\\"")
                c == '\\' -> b.append("\\\\")
                c == '\n' -> b.append("\\n")
                c == '\r' -> b.append("\\r")
                c == '\t' -> b.append("\\t")
                c < ' ' -> b.append("\\u%04x".format(c.code))
                else -> b.append(c)
            }
        }
        return b.append('"').toString()
    }

    private class Parser(private val s: String) {
        private var i = 0

        fun done() = i >= s.length

        fun space() {
            while (i < s.length && s[i] in " \t\r\n") i++
        }

        fun value(): Any? {
            if (done()) throw ParseError("The JSON ends too early.")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> string()
                't' -> word("true", true)
                'f' -> word("false", false)
                'n' -> word("null", null)
                else -> if (c == '-' || c in '0'..'9') number() else throw ParseError("Unexpected '$c' in the JSON.")
            }
        }

        private fun word(w: String, v: Any?): Any? {
            if (!s.startsWith(w, i)) throw ParseError("Unexpected text in the JSON.")
            i += w.length
            return v
        }

        private fun expect(c: Char) {
            if (done() || s[i] != c) throw ParseError("Expected '$c' in the JSON.")
            i++
        }

        private fun obj(): Map<String, Any?> {
            expect('{')
            val m = LinkedHashMap<String, Any?>()
            space()
            if (!done() && s[i] == '}') { i++; return m }
            while (true) {
                space()
                val k = string()
                space()
                expect(':')
                space()
                m[k] = value()
                space()
                if (!done() && s[i] == ',') { i++; continue }
                expect('}')
                return m
            }
        }

        private fun arr(): List<Any?> {
            expect('[')
            val l = ArrayList<Any?>()
            space()
            if (!done() && s[i] == ']') { i++; return l }
            while (true) {
                space()
                l.add(value())
                space()
                if (!done() && s[i] == ',') { i++; continue }
                expect(']')
                return l
            }
        }

        private fun string(): String {
            expect('"')
            val b = StringBuilder()
            while (true) {
                if (done()) throw ParseError("A JSON string is not closed.")
                val c = s[i++]
                when {
                    c == '"' -> return b.toString()
                    c == '\\' -> {
                        if (done()) throw ParseError("A JSON string is not closed.")
                        when (val e = s[i++]) {
                            '"', '\\', '/' -> b.append(e)
                            'b' -> b.append('\b')
                            'f' -> b.append('\u000C')
                            'n' -> b.append('\n')
                            'r' -> b.append('\r')
                            't' -> b.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) throw ParseError("A JSON escape is cut short.")
                                b.append(s.substring(i, i + 4).toIntOrNull(16)?.toChar() ?: throw ParseError("Bad JSON escape."))
                                i += 4
                            }
                            else -> throw ParseError("Bad JSON escape.")
                        }
                    }
                    c < ' ' -> throw ParseError("A control character in a JSON string.")
                    else -> b.append(c)
                }
            }
        }

        private fun number(): Any {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && s[i] in '0'..'9') i++
            var fraction = false
            if (i < s.length && s[i] == '.') { fraction = true; i++; while (i < s.length && s[i] in '0'..'9') i++ }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                fraction = true
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                while (i < s.length && s[i] in '0'..'9') i++
            }
            val t = s.substring(start, i)
            return (if (fraction) t.toDoubleOrNull() else t.toLongOrNull()) ?: throw ParseError("Bad JSON number '$t'.")
        }
    }
}
