package ch.ixh.zeccatill

import com.google.zxing.RGBLuminanceSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The codes the till draws can be read back, and what a scan reads goes through the pairing parser. */
class QrTest {

    /** The matrix drawn black on white, [cell] pixels per module, with a quiet zone of four modules. */
    private fun picture(value: String, cell: Int = 4): RGBLuminanceSource {
        val m = Qr.encode(value)
        val n = (m.width + 8) * cell
        val px = IntArray(n * n) { 0xFFFFFFFF.toInt() }
        for (y in 0 until m.height) for (x in 0 until m.width) if (m[x, y]) {
            for (dy in 0 until cell) for (dx in 0 until cell) px[((y + 4) * cell + dy) * n + (x + 4) * cell + dx] = 0xFF0C0C0D.toInt()
        }
        return RGBLuminanceSource(n, n, px)
    }

    @Test fun `a pay link reads back`() {
        val url = "https://zecca-beta.vercel.app/pay/pr_0rtgxe1nzr72zs0j"
        assertEquals(url, Qr.decode(picture(url)))
    }

    @Test fun `a scanned pairing code pairs`() {
        val payload = "zecca-till://pair?api=https%3A%2F%2Fzecca-api-production.up.railway.app&code=ABCD2345"
        val read = Qr.decode(picture(payload, cell = 3))!!
        assertEquals(PairingPayload.Result.Ok(Pairing(PairingPayload.PROD_API, "ABCD2345")), PairingPayload.parse(read, allowHttp = false))
    }

    @Test fun `a blank picture reads nothing`() {
        assertNull(Qr.decode(RGBLuminanceSource(64, 64, IntArray(64 * 64) { 0xFFFFFFFF.toInt() })))
    }
}
