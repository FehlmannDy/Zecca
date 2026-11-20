package ch.ixh.nfcpaylink

import ch.ixh.nfcpaylink.PayLinkPolicy.Incoming

/** Merchant screen rules that need no Android, so they are unit-tested. */
object MerchantScreen {

    /**
     * What the link field holds after a link arrives from outside (Chrome, deep link, adb); null
     * leaves it as it is. A refused link empties it, so one tap on Serve cannot resend the link
     * the refused one was meant to replace.
     */
    fun fieldAfter(incoming: Incoming): String? = when (incoming) {
        Incoming.None -> null
        is Incoming.Accepted -> incoming.url
        is Incoming.Refused -> ""
    }
}
