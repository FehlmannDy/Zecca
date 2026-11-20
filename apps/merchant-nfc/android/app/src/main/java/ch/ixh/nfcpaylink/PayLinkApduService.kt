package ch.ixh.nfcpaylink

import android.nfc.cardemulation.HostApduService
import android.os.Bundle
import android.util.Log
import ch.ixh.nfcpaylink.Type4TagEmulator.Companion.toHex
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Serves the configured URL as a read-only NFC Forum Type 4 Tag (AID D2760000850101).
 * Every APDU is logged under tag "PayLinkHCE": adb logcat -s PayLinkHCE
 */
class PayLinkApduService : HostApduService() {

    /** One emulator per reader session, built with the URL current at the first APDU. */
    private var emulator: Type4TagEmulator? = null
    private var sessionUrl: String? = null

    override fun processCommandApdu(commandApdu: ByteArray, extras: Bundle?): ByteArray {
        val emu = emulator ?: PayLinkStore.servedUrl(this)?.let { url ->
            sessionUrl = url
            Type4TagEmulator(NdefUri.message(url))
        }?.also { emulator = it }
        val response = emu?.process(commandApdu) ?: Type4TagEmulator.SW_FILE_NOT_FOUND
        Log.i(TAG, "C-APDU ${commandApdu.toHex()} -> R-APDU ${response.toHex()}")
        return response
    }

    override fun onDeactivated(reason: Int) {
        val emu = emulator
        val why = if (reason == DEACTIVATION_LINK_LOSS) "link lost" else "deselected"
        val time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        val summary = if (emu == null) {
            "$time: reader seen, but no URL configured"
        } else {
            "$time: NDEF ${emu.ndefBytesRead}/${emu.ndefFile.size} bytes read" +
                (if (emu.ndefFullyRead) " (complete)" else " (INCOMPLETE)") + ", $why\n$sessionUrl"
        }
        Log.i(TAG, "deactivated: $summary")
        PayLinkStore.setLastTap(this, summary)
        emulator = null
        sessionUrl = null
    }

    companion object {
        const val TAG = "PayLinkHCE"
    }
}
