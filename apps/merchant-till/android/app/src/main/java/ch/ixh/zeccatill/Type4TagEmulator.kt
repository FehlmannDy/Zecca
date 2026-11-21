package ch.ixh.zeccatill
// Copied from apps/merchant-nfc (NFC PayLink), unchanged apart from the package.

/**
 * NFC Forum Type 4 Tag (mapping version 2.0), read-only, as a pure APDU state machine.
 * No Android dependencies, so it runs as plain JVM unit tests.
 *
 * Sequence a reader performs (T4T NDEF detection + read procedure):
 *   SELECT NDEF app   00 A4 04 00 07 D2760000850101 [00]
 *   SELECT CC file    00 A4 00 0C 02 E103
 *   READ BINARY CC    00 B0 00 00 0F
 *   SELECT NDEF file  00 A4 00 0C 02 E104
 *   READ BINARY NLEN  00 B0 00 00 02
 *   READ BINARY data  00 B0 00 02 <Le>   (repeated in chunks of at most MLe)
 *
 * One instance = one reader session. Call [reset] (or drop the instance) on deactivation.
 */
class Type4TagEmulator(ndefMessage: ByteArray) {

    enum class State { IDLE, APP_SELECTED, CC_SELECTED, NDEF_SELECTED }

    var state = State.IDLE
        private set

    /** NLEN (2 bytes, big endian) followed by the NDEF message. */
    val ndefFile: ByteArray

    /** Capability Container file (15 bytes). */
    val ccFile: ByteArray

    /** Highest NDEF file offset (exclusive) returned to the reader in this session. */
    var ndefBytesRead = 0
        private set

    val ndefFullyRead: Boolean get() = ndefBytesRead >= ndefFile.size

    init {
        require(ndefMessage.isNotEmpty() && ndefMessage.size <= MAX_NDEF_MESSAGE) {
            "NDEF message must be 1..$MAX_NDEF_MESSAGE bytes"
        }
        val n = ndefMessage.size
        ndefFile = byteArrayOf((n ushr 8).toByte(), n.toByte()) + ndefMessage
        val f = ndefFile.size
        ccFile = byteArrayOf(
            0x00, 0x0F,                            // CCLEN = 15
            0x20,                                  // mapping version 2.0
            (MLE ushr 8).toByte(), MLE.toByte(),   // MLe: max data bytes per READ BINARY
            (MLC ushr 8).toByte(), MLC.toByte(),   // MLc: max data bytes per UPDATE BINARY
            0x04, 0x06,                            // NDEF File Control TLV (T=04, L=06)
            0xE1.toByte(), 0x04,                   // NDEF file identifier E104
            (f ushr 8).toByte(), f.toByte(),       // max NDEF file size
            0x00,                                  // read access: granted
            0xFF.toByte(),                         // write access: none (read-only tag)
        )
    }

    fun process(apdu: ByteArray): ByteArray {
        if (apdu.size < 4) return SW_WRONG_LENGTH
        if (apdu[0].u() != 0x00) return SW_CLA_NOT_SUPPORTED
        val p1 = apdu[2].u()
        val p2 = apdu[3].u()
        return when (apdu[1].u()) {
            0xA4 -> select(apdu, p1)
            0xB0 -> readBinary(apdu, p1, p2)
            0xD6 -> SW_SECURITY_NOT_SATISFIED // UPDATE BINARY: tag is read-only
            else -> SW_INS_NOT_SUPPORTED
        }
    }

    fun reset() {
        state = State.IDLE
        ndefBytesRead = 0
    }

    private fun select(apdu: ByteArray, p1: Int): ByteArray {
        if (apdu.size < 5) return SW_WRONG_LENGTH
        val lc = apdu[4].u()
        if (apdu.size < 5 + lc) return SW_WRONG_LENGTH
        val data = apdu.copyOfRange(5, 5 + lc)
        return when (p1) {
            0x04 -> { // select by DF name (AID)
                if (data.contentEquals(NDEF_AID)) {
                    state = State.APP_SELECTED
                    SW_OK
                } else {
                    state = State.IDLE
                    SW_FILE_NOT_FOUND
                }
            }
            0x00 -> { // select by file identifier (P2 = 0C in T4T v2.0, 00 in v1.0; both accepted)
                when {
                    state == State.IDLE -> SW_FILE_NOT_FOUND
                    data.contentEquals(CC_FILE_ID) -> { state = State.CC_SELECTED; SW_OK }
                    data.contentEquals(NDEF_FILE_ID) -> { state = State.NDEF_SELECTED; SW_OK }
                    else -> SW_FILE_NOT_FOUND
                }
            }
            else -> SW_WRONG_P1P2
        }
    }

    private fun readBinary(apdu: ByteArray, p1: Int, p2: Int): ByteArray {
        val file = when (state) {
            State.CC_SELECTED -> ccFile
            State.NDEF_SELECTED -> ndefFile
            else -> return SW_NO_CURRENT_EF
        }
        val le = when {
            apdu.size == 5 -> apdu[4].u().let { if (it == 0) 256 else it }
            // Extended Le (00 Lh Ll), which some Android readers send
            apdu.size == 7 && apdu[4].u() == 0 ->
                ((apdu[5].u() shl 8) or apdu[6].u()).let { if (it == 0) 65536 else it }
            else -> return SW_WRONG_LENGTH
        }
        if (p1 and 0x80 != 0) return SW_WRONG_P1P2 // short EF identifier: not supported
        val offset = (p1 shl 8) or p2
        if (offset >= file.size) return SW_WRONG_OFFSET
        val end = minOf(file.size, offset + minOf(le, MLE))
        if (file === ndefFile) ndefBytesRead = maxOf(ndefBytesRead, end)
        return file.copyOfRange(offset, end) + SW_OK
    }

    companion object {
        /** NDEF Tag Application AID, mapping version 2.0. */
        val NDEF_AID = hex("D2760000850101")
        val CC_FILE_ID = hex("E103")
        val NDEF_FILE_ID = hex("E104")

        const val MLE = 0x00FF
        const val MLC = 0x00FF
        /** READ BINARY offsets are 15 bits, NLEN takes 2 bytes. */
        const val MAX_NDEF_MESSAGE = 0x7FFF - 2

        val SW_OK = hex("9000")
        val SW_WRONG_LENGTH = hex("6700")
        val SW_SECURITY_NOT_SATISFIED = hex("6982")
        val SW_NO_CURRENT_EF = hex("6986")
        val SW_FILE_NOT_FOUND = hex("6A82")
        val SW_WRONG_P1P2 = hex("6A86")
        val SW_WRONG_OFFSET = hex("6B00")
        val SW_INS_NOT_SUPPORTED = hex("6D00")
        val SW_CLA_NOT_SUPPORTED = hex("6E00")

        fun hex(s: String): ByteArray =
            s.replace(" ", "").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

        fun ByteArray.toHex(): String = joinToString("") { "%02X".format(it) }

        private fun Byte.u(): Int = toInt() and 0xFF
    }
}
