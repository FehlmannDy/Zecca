package ch.ixh.zeccatill

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingPayloadTest {

    private val prod = "https://zecca-api-production.up.railway.app"
    private fun ok(r: PairingPayload.Result) = (r as PairingPayload.Result.Ok).pairing
    private fun refused(r: PairingPayload.Result) = (r as PairingPayload.Result.Refused).reason

    @Test fun `reads the merchant space QR payload`() {
        val p = ok(PairingPayload.parse("zecca-till://pair?api=https%3A%2F%2Fzecca-api-production.up.railway.app&code=ABCD2345", allowHttp = false))
        assertEquals(Pairing(prod, "ABCD2345"), p)
    }

    @Test fun `accepts the origin unencoded and a trailing slash, and a typed code with spaces`() {
        val p = ok(PairingPayload.parse("zecca-till://pair?api=$prod/&code=abcd%202345", allowHttp = false))
        assertEquals(Pairing(prod, "ABCD2345"), p)
    }

    @Test fun `https only, except localhost and the emulator host in a debug build`() {
        assertTrue(refused(PairingPayload.parse("zecca-till://pair?api=http%3A%2F%2Fzecca-api-production.up.railway.app&code=ABCD2345", allowHttp = true)).contains("https"))
        assertTrue(refused(PairingPayload.parse("zecca-till://pair?api=http%3A%2F%2F10.0.2.2%3A8990&code=ABCD2345", allowHttp = false)).contains("https"))
        assertEquals(Pairing("http://10.0.2.2:8990", "ABCD2345"), ok(PairingPayload.parse("zecca-till://pair?api=http%3A%2F%2F10.0.2.2%3A8990&code=ABCD2345", allowHttp = true)))
        assertEquals(Pairing("http://localhost:8800", "ABCD2345"), ok(PairingPayload.parse("zecca-till://pair?api=http%3A%2F%2Flocalhost%3A8800&code=ABCD2345", allowHttp = true)))
    }

    @Test fun `only Zecca's servers`() {
        for (api in listOf("https://evil.example.com", "https://zecca-api-production.up.railway.app.evil.com", "https://user@zecca-api-production.up.railway.app", "https://up.railway.app")) {
            assertTrue(api, PairingPayload.checkApi(api, allowHttp = true) != null)
        }
        assertNull(PairingPayload.checkApi(prod, allowHttp = false))
        assertNull(PairingPayload.checkApi("https://localhost:8443", allowHttp = false))
    }

    @Test fun `an origin only, no path or query`() {
        assertTrue(PairingPayload.checkApi("$prod/v1/till", allowHttp = false) != null)
        assertTrue(PairingPayload.checkApi("$prod?x=1", allowHttp = false) != null)
        assertEquals(prod, PairingPayload.normalizeApi("$prod/"))
        assertEquals(prod, PairingPayload.normalizeApi("  HTTPS://Zecca-API-production.up.railway.app  "))
    }

    @Test fun `refuses anything that is not a pairing link`() {
        assertTrue(PairingPayload.parse("https://zecca-beta.vercel.app/pay/x", allowHttp = false) is PairingPayload.Result.Refused)
        assertTrue(PairingPayload.parse("zecca-till://other?api=$prod&code=ABCD2345", allowHttp = false) is PairingPayload.Result.Refused)
        assertTrue(PairingPayload.parse("zecca-till://pair?api=$prod", allowHttp = false) is PairingPayload.Result.Refused)
        assertTrue(PairingPayload.parse("zecca-till://pair?code=ABCD2345", allowHttp = false) is PairingPayload.Result.Refused)
        assertTrue(PairingPayload.parse("zecca-till://pair?api=$prod&code=ABC", allowHttp = false) is PairingPayload.Result.Refused)
    }

    @Test fun `codes are 8 characters from the code alphabet, case, spaces and dashes do not matter`() {
        assertEquals("ABCD2345", PairingPayload.normalizeCode(" abcd-2345 "))
        assertNull(PairingPayload.normalizeCode("ABCD234"))
        assertNull(PairingPayload.normalizeCode("ABCD2340")) // 0 is not in the alphabet
        assertNull(PairingPayload.normalizeCode("ABCD234I"))
    }
}
