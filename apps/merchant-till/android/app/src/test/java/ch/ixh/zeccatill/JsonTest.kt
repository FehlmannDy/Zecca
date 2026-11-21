package ch.ixh.zeccatill

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonTest {
    @Test fun `parses objects, arrays, strings with escapes, numbers, booleans and null`() {
        val v = Json.parse("""{"a":"Caffè \"Bruno\"\n","n":450,"neg":-3,"f":1.5,"t":true,"x":null,"l":[1,"two",{"k":false}]}""") as Map<*, *>
        assertEquals("Caffè \"Bruno\"\n", v["a"])
        assertEquals(450L, v["n"])
        assertEquals(-3L, v["neg"])
        assertEquals(1.5, v["f"])
        assertEquals(true, v["t"])
        assertTrue(v.containsKey("x"))
        assertNull(v["x"])
        assertEquals(listOf(1L, "two", mapOf("k" to false)), v["l"])
    }

    @Test(expected = Json.ParseError::class) fun `refuses broken JSON`() {
        Json.parse("""{"a":""")
    }

    @Test(expected = Json.ParseError::class) fun `refuses trailing garbage`() {
        Json.parse("""{"a":1} x""")
    }

    @Test fun `writes a flat object with escaped strings`() {
        assertEquals("""{"code":"AB\"C\\","amountMinor":450,"none":null}""", Json.obj("code" to "AB\"C\\", "amountMinor" to 450L, "none" to null))
        assertEquals("""{"s":"line\nnext\u0001"}""", Json.obj("s" to "line\nnext\u0001"))
    }
}
