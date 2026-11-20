package ch.ixh.nfcpaylink

import ch.ixh.nfcpaylink.PayLinkPolicy.Incoming
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class MerchantScreenTest {

    private val hosts = PayLinkPolicy.parseHosts("*.trycloudflare.com")
    private val old = "https://abc.trycloudflare.com/pay/pr_old"

    @Test fun `an accepted link fills the field`() {
        assertEquals(old, MerchantScreen.fieldAfter(Incoming.Accepted(old)))
    }

    @Test fun `a refused link empties the field so Serve cannot resend the old link`() {
        val refused = PayLinkPolicy.incoming(null, "http://abc.trycloudflare.com/pay/pr_new", hosts)
        val field = MerchantScreen.fieldAfter(refused)
        assertEquals("", field)
        assertNotNull(PayLinkPolicy.check(field, hosts)) // tapping Serve now sends nothing
    }

    @Test fun `a start without a link leaves the field as it is`() {
        assertNull(MerchantScreen.fieldAfter(Incoming.None))
    }
}
