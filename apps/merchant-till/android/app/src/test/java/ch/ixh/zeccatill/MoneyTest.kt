package ch.ixh.zeccatill

import org.junit.Assert.assertEquals
import org.junit.Test

class MoneyTest {
    @Test fun `dollars with thousands separators and two-digit cents`() {
        assertEquals(Money.Parts("4", "50"), Money.split(450))
        assertEquals(Money.Parts("1,234,567", "89"), Money.split(123456789))
        assertEquals(Money.Parts("0", "05"), Money.split(5))
    }

    @Test fun `formats like the web`() {
        assertEquals("$4.50", Money.format(450))
        assertEquals("$1,000.00", Money.format(100000))
        assertEquals("$0.00", Money.format(0))
    }

    @Test fun `spoken for screen readers`() {
        assertEquals("4 dollars 50", Money.spoken(450))
        assertEquals("12 dollars", Money.spoken(1200))
    }
}
