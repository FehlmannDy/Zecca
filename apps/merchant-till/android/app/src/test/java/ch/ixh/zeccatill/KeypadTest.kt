package ch.ixh.zeccatill

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Same rules as the web till's keypad (apps/web/lib/keypad.ts) and parseUsdInput (packages/contracts/src/money.ts). */
class KeypadTest {

    private fun type(keys: String): String = keys.fold("") { acc, c -> Keypad.press(acc, if (c == '<') Keypad.BACK else c.toString()) }

    @Test fun `digits build dollars, a point starts cents, two decimals at most`() {
        assertEquals("12", type("12"))
        assertEquals("12.5", type("12.5"))
        assertEquals("12.50", type("12.507"))
        assertEquals("0.", type("."))
        assertEquals("0.5", type(".5"))
    }

    @Test fun `one decimal point only, a leading zero is replaced`() {
        assertEquals("1.2", type("1..2"))
        assertEquals("7", type("07"))
        assertEquals("0", type("00"))
    }

    @Test fun `back deletes one character, and nothing on empty`() {
        assertEquals("12.", type("12.5<"))
        assertEquals("", type("1<<"))
    }

    @Test fun `at most seven dollar digits`() {
        assertEquals("1234567", type("12345678"))
        assertEquals("1234567.89", type("12345678.89"))
    }

    @Test fun `unknown keys are ignored`() {
        assertEquals("1", Keypad.press("1", "x"))
    }

    @Test fun `parses into integer cents, never floats`() {
        assertEquals(1250L, Money.parse("12.5"))
        assertEquals(1205L, Money.parse("12.05"))
        assertEquals(1200L, Money.parse("12."))
        assertEquals(50L, Money.parse("0.50"))
        assertEquals(120000L, Money.parse("1,200"))
        assertNull(Money.parse(""))
        assertNull(Money.parse("."))
        assertNull(Money.parse("1.234"))
        assertNull(Money.parse("abc"))
    }

    @Test fun `the amount shown while typing`() {
        assertEquals("0", Keypad.shown(""))
        assertEquals("12.5", Keypad.shown("12.5"))
    }
}
