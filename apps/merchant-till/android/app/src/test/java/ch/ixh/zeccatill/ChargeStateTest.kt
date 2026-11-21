package ch.ixh.zeccatill

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same copy as the web till (UI.md §5.8, apps/web/components/merchant/till-model.ts). */
class ChargeStateTest {

    @Test fun `status lines`() {
        assertEquals("Waiting for the customer", ChargeStatus.CREATED.line)
        assertEquals("Customer is paying", ChargeStatus.OPENED.line)
        assertEquals("Paid", ChargeStatus.PAID.line)
        assertEquals("This request has expired.", ChargeStatus.EXPIRED.line)
        assertEquals("Charge cancelled.", ChargeStatus.CANCELLED.line)
    }

    @Test fun `open charges are served over NFC, finished ones are not`() {
        assertTrue(ChargeStatus.CREATED.open)
        assertTrue(ChargeStatus.OPENED.open)
        for (s in listOf(ChargeStatus.PAID, ChargeStatus.EXPIRED, ChargeStatus.CANCELLED)) assertFalse(s.open)
    }

    @Test fun `polls never move a charge backwards`() {
        assertEquals(ChargeStatus.PAID, ChargeStatus.furthest(ChargeStatus.PAID, ChargeStatus.OPENED))
        assertEquals(ChargeStatus.OPENED, ChargeStatus.furthest(ChargeStatus.CREATED, ChargeStatus.OPENED))
        assertEquals(ChargeStatus.CREATED, ChargeStatus.furthest(ChargeStatus.CREATED, ChargeStatus.UNKNOWN))
    }

    @Test fun `time left before the request expires`() {
        val exp = Iso.parse("2026-11-21T09:10:00.000Z")
        assertEquals("10:00", ChargeStatus.expiresIn(exp, exp - 600_000))
        assertEquals("9:41", ChargeStatus.expiresIn(exp, exp - 580_500))
        assertEquals("0:00", ChargeStatus.expiresIn(exp, exp + 5_000))
    }

    @Test fun `ISO times from the API`() {
        assertEquals(0L, Iso.parse("1970-01-01T00:00:00.000Z"))
        assertEquals(1_795_671_600_000L, Iso.parse("2026-11-26T05:40:00Z"))
        assertEquals(Iso.parse("2026-11-21T09:10:00Z") + 123, Iso.parse("2026-11-21T09:10:00.123Z"))
        assertEquals(951_782_400_000L, Iso.parse("2000-02-29T00:00:00.000Z"))
    }
}
