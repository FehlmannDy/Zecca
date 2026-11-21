package ch.ixh.zeccatill

import android.nfc.cardemulation.HostApduService
import android.os.Bundle
import android.util.Log

/**
 * Serves the open charge's pay link as a read-only NFC Forum Type 4 Tag (AID D2760000850101), the way
 * apps/merchant-nfc does, but reading the link from this process ([ServedLink]) instead of another app.
 * APDUs are logged without the link: adb logcat -s ZeccaTillHCE
 */
class TillApduService : HostApduService() {

    /** One emulator per reader session, built with the link current at the first APDU. */
    private var emulator: Type4TagEmulator? = null

    override fun processCommandApdu(commandApdu: ByteArray, extras: Bundle?): ByteArray {
        val emu = emulator ?: ServedLink.url?.let { Type4TagEmulator(NdefUri.message(it)) }?.also { emulator = it }
        val response = emu?.process(commandApdu) ?: Type4TagEmulator.SW_FILE_NOT_FOUND
        Log.i(TAG, "APDU ins=%02X -> %02X%02X".format(commandApdu.getOrElse(1) { 0 }, response[response.size - 2], response[response.size - 1]))
        return response
    }

    override fun onDeactivated(reason: Int) {
        val emu = emulator
        Log.i(TAG, if (emu == null) "reader seen, no charge open" else "NDEF ${emu.ndefBytesRead}/${emu.ndefFile.size} bytes read" + if (emu.ndefFullyRead) " (complete)" else " (incomplete)")
        emulator = null
    }

    companion object {
        const val TAG = "ZeccaTillHCE"
    }
}
