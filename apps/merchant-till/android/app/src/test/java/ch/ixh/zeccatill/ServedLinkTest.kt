package ch.ixh.zeccatill

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The pay link goes out over NFC only while an open charge is on screen, with the app in the foreground. */
class ServedLinkTest {
    private fun charge(status: ChargeStatus, url: String = "https://zecca.example/pay/pr_1") =
        Charge("pr_1", "Caffè Bruno", 450, null, status, url, 0, null)

    @Test fun `an open charge on screen is served`() {
        assertEquals("https://zecca.example/pay/pr_1", ServedLink.of(charge(ChargeStatus.CREATED), onScreen = true, allowHttp = false))
        assertEquals("https://zecca.example/pay/pr_1", ServedLink.of(charge(ChargeStatus.OPENED), onScreen = true, allowHttp = false))
    }

    @Test fun `nothing is served while the app is in the background`() {
        assertNull(ServedLink.of(charge(ChargeStatus.CREATED), onScreen = false, allowHttp = false))
        assertNull(ServedLink.of(charge(ChargeStatus.OPENED), onScreen = false, allowHttp = true))
    }

    @Test fun `finished charges and no charge are not served`() {
        for (s in listOf(ChargeStatus.PAID, ChargeStatus.EXPIRED, ChargeStatus.CANCELLED, ChargeStatus.UNKNOWN)) {
            assertNull(ServedLink.of(charge(s), onScreen = true, allowHttp = true))
        }
        assertNull(ServedLink.of(null, onScreen = true, allowHttp = true))
    }

    @Test fun `http only in a debug build, and never a link the tag cannot hold`() {
        val local = charge(ChargeStatus.CREATED, "http://10.0.2.2:3000/pay/pr_1")
        assertNull(ServedLink.of(local, onScreen = true, allowHttp = false))
        assertEquals("http://10.0.2.2:3000/pay/pr_1", ServedLink.of(local, onScreen = true, allowHttp = true))
        assertNull(ServedLink.of(charge(ChargeStatus.CREATED, "https://zecca.example/pay/" + "x".repeat(1000)), onScreen = true, allowHttp = false))
        assertNull(ServedLink.of(charge(ChargeStatus.CREATED, "zecca-till://pair"), onScreen = true, allowHttp = true))
    }
}
