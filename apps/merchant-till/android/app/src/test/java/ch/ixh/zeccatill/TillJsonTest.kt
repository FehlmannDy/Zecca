package ch.ixh.zeccatill

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The API's answers, as services/api/src/connectors/till sends them. */
class TillJsonTest {

    private val chargeJson = """
        {"id":"pr_01abc","merchantId":"usr_1","merchantName":"Caffè Bruno","amountMinor":450,"reference":"Table 4",
         "status":"opened","url":"https://zecca-beta.vercel.app/pay/pr_01abc","expiresAt":"2026-11-21T09:10:00.000Z"}
    """.trimIndent()

    @Test fun `a charge (payment request)`() {
        val c = TillJson.charge(chargeJson)
        assertEquals("pr_01abc", c.id)
        assertEquals(ChargeStatus.OPENED, c.status)
        assertEquals(450L, c.amountMinor)
        assertEquals("Table 4", c.reference)
        assertEquals("https://zecca-beta.vercel.app/pay/pr_01abc", c.url)
        assertEquals(Iso.parse("2026-11-21T09:10:00.000Z"), c.expiresAtMs)
        assertNull(c.paidAtMs)
        assertEquals("Caffè Bruno", c.merchantName)
    }

    @Test fun `a paid charge without a reference`() {
        val c = TillJson.charge("""{"id":"pr_2","merchantName":"M","amountMinor":100,"status":"paid","url":"https://x/pay/pr_2","expiresAt":"2026-11-21T09:10:00.000Z","paidAt":"2026-11-21T09:01:02.000Z"}""")
        assertEquals(ChargeStatus.PAID, c.status)
        assertNull(c.reference)
        assertEquals(Iso.parse("2026-11-21T09:01:02.000Z"), c.paidAtMs)
    }

    @Test fun `an unknown status reads as unknown, not a crash`() {
        assertEquals(ChargeStatus.UNKNOWN, TillJson.charge(chargeJson.replace("\"opened\"", "\"weird\"")).status)
    }

    @Test fun `the pairing answer`() {
        val p = TillJson.paired("""{"tillToken":"till_abc","merchantName":"Caffè Bruno","tillId":"till_01"}""")
        assertEquals(Paired("till_abc", "Caffè Bruno", "till_01"), p)
    }

    @Test(expected = Json.ParseError::class) fun `a pairing answer without a token is refused`() {
        TillJson.paired("""{"merchantName":"x","tillId":"t"}""")
    }

    @Test fun `API errors keep their English message`() {
        val e = TillJson.error(401, """{"error":{"code":"unauthorized","message":"This till is not paired. Pair it again from your Zecca merchant space."}}""")
        assertEquals(401, e.status)
        assertEquals("unauthorized", e.code)
        assertEquals("This till is not paired. Pair it again from your Zecca merchant space.", e.message)
    }

    @Test fun `a body that is not an API error gets a plain message`() {
        assertEquals("Something went wrong on our side. Try again in a moment.", TillJson.error(502, "<html>Bad gateway</html>").message)
        assertEquals("Something went wrong on our side. Try again in a moment.", TillJson.error(500, null).message)
    }

    @Test fun `request bodies`() {
        assertEquals("""{"code":"ABCD2345","name":"Pixel 8"}""", TillJson.pairBody("ABCD2345", "Pixel 8"))
        assertEquals("""{"amountMinor":450,"reference":"Table 4"}""", TillJson.chargeBody(450, "Table 4"))
        assertEquals("""{"amountMinor":450}""", TillJson.chargeBody(450, "  "))
    }
}
