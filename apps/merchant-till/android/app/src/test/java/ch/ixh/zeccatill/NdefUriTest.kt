package ch.ixh.zeccatill

import ch.ixh.zeccatill.Type4TagEmulator.Companion.toHex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class NdefUriTest {

    @Test fun `https URL uses prefix code 04 and short record`() {
        val m = NdefUri.message("https://a.ch/p/1")
        // D1 = MB|ME|SR|TNF well-known, 01 type len, 09 payload len (1 + 8), 55 'U', 04 'https://'
        assertEquals("D101095504" + "a.ch/p/1".toByteArray().toHex(), m.toHex())
    }

    @Test fun `https www prefix wins over https`() {
        assertEquals(0x02, NdefUri.message("https://www.a.ch")[4].toInt())
    }

    @Test fun `http prefixes`() {
        assertEquals(0x03, NdefUri.message("http://10.0.0.2:3000/pay/x")[4].toInt())
        assertEquals(0x01, NdefUri.message("http://www.a.ch")[4].toInt())
    }

    @Test fun `payload over 255 bytes uses long record format`() {
        val m = NdefUri.message("https://a.ch/" + "z".repeat(300))
        assertEquals(0xC1, m[0].toInt() and 0xFF)
        val len = ((m[2].toInt() and 0xFF) shl 24) or ((m[3].toInt() and 0xFF) shl 16) or
            ((m[4].toInt() and 0xFF) shl 8) or (m[5].toInt() and 0xFF)
        assertEquals(1 + "a.ch/".length + 300, len)
        assertEquals(0x55, m[6].toInt())
        assertEquals(m.size, 7 + len)
    }

    @Test fun `url validation`() {
        assertNull(NdefUri.checkUrl("https://pay.example.com/pay/demo"))
        assertNull(NdefUri.checkUrl("http://192.168.1.20:3000/pay/demo"))
        assertNotNull(NdefUri.checkUrl(""))
        assertNotNull(NdefUri.checkUrl("pay.example.com/pay/demo"))
        assertNotNull(NdefUri.checkUrl("ftp://example.com/x"))
        assertNotNull(NdefUri.checkUrl("https://exa mple.com"))
        assertNotNull(NdefUri.checkUrl("https:///nohost"))
    }
}
