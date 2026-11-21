package ch.ixh.zeccatill

import ch.ixh.zeccatill.Type4TagEmulator.Companion.hex
import ch.ixh.zeccatill.Type4TagEmulator.Companion.toHex
import ch.ixh.zeccatill.Type4TagEmulator.State
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class Type4TagEmulatorTest {

    private val url = "https://pay.example.com/pay/demo"
    private val msg = NdefUri.message(url)
    private val tag = Type4TagEmulator(msg)

    private val selectApp = hex("00A4040007D276000085010100")
    private val selectAppNoLe = hex("00A4040007D2760000850101")
    private val selectCc = hex("00A4000C02E103")
    private val selectNdef = hex("00A4000C02E104")
    private val readCc = hex("00B000000F")
    private val readNlen = hex("00B0000002")

    private fun send(apdu: ByteArray) = tag.process(apdu)
    private fun sw(resp: ByteArray) = resp.copyOfRange(resp.size - 2, resp.size).toHex()
    private fun data(resp: ByteArray) = resp.copyOfRange(0, resp.size - 2)
    private fun read(offset: Int, le: Int) =
        send(byteArrayOf(0x00, 0xB0.toByte(), (offset ushr 8).toByte(), offset.toByte(), le.toByte()))

    // --- happy path ---------------------------------------------------------

    @Test fun `select NDEF application returns 9000`() {
        assertEquals("9000", send(selectApp).toHex())
        assertEquals(State.APP_SELECTED, tag.state)
    }

    @Test fun `select application without Le byte is accepted`() {
        assertEquals("9000", send(selectAppNoLe).toHex())
    }

    @Test fun `select and read capability container`() {
        send(selectApp)
        assertEquals("9000", send(selectCc).toHex())
        assertEquals(State.CC_SELECTED, tag.state)
        val resp = send(readCc)
        assertEquals("9000", sw(resp))
        val cc = data(resp)
        val fileSize = msg.size + 2
        assertEquals(
            "000F" + "20" + "00FF" + "00FF" + "0406" + "E104" + "%04X".format(fileSize) + "00" + "FF",
            cc.toHex(),
        )
    }

    @Test fun `full NDEF read returns the exact message`() {
        send(selectApp); send(selectCc); send(readCc)
        assertEquals("9000", send(selectNdef).toHex())
        val nlenResp = send(readNlen)
        assertEquals("9000", sw(nlenResp))
        val nlen = data(nlenResp).let { ((it[0].toInt() and 0xFF) shl 8) or (it[1].toInt() and 0xFF) }
        assertEquals(msg.size, nlen)
        assertFalse(tag.ndefFullyRead)
        val body = read(2, nlen)
        assertEquals("9000", sw(body))
        assertArrayEquals(msg, data(body))
        assertTrue(tag.ndefFullyRead)
    }

    @Test fun `select file with P2 00 (T4T v1 style) also works`() {
        send(selectApp)
        assertEquals("9000", send(hex("00A4000002E104")).toHex())
        assertEquals(State.NDEF_SELECTED, tag.state)
    }

    @Test fun `long URL is read in MLe sized chunks`() {
        val longUrl = "https://pay.example.com/pay/" + "x".repeat(600)
        val longMsg = NdefUri.message(longUrl)
        val t = Type4TagEmulator(longMsg)
        t.process(selectApp); t.process(selectNdef)
        val out = ArrayList<Byte>()
        var offset = 2
        val end = longMsg.size + 2
        while (offset < end) {
            val le = minOf(Type4TagEmulator.MLE, end - offset)
            val r = t.process(byteArrayOf(0x00, 0xB0.toByte(), (offset ushr 8).toByte(), offset.toByte(), le.toByte()))
            assertEquals("9000", sw(r))
            out.addAll(data(r).toList())
            offset += le
        }
        assertArrayEquals(longMsg, out.toByteArray())
        assertTrue(t.ndefFullyRead)
    }

    @Test fun `Le 00 means 256 but is capped at MLe`() {
        val t = Type4TagEmulator(NdefUri.message("https://a.example/" + "y".repeat(400)))
        t.process(selectApp); t.process(selectNdef)
        val r = t.process(hex("00B0000000"))
        assertEquals(Type4TagEmulator.MLE, r.size - 2)
    }

    @Test fun `extended 3-byte Le is accepted and capped at MLe`() {
        send(selectApp); send(selectNdef)
        val r = send(hex("00B00000000400")) // Le = 0x0400
        assertEquals("9000", sw(r))
        assertArrayEquals(tag.ndefFile, data(r)) // file is shorter than MLe
    }

    @Test fun `iOS style read of whole file from offset 0 then the tail`() {
        // Reported iOS pattern: read NLEN, then offset 0 for NLEN bytes, then the last 2 bytes.
        send(selectApp); send(selectCc); send(readCc); send(selectNdef); send(selectNdef)
        assertEquals("9000", sw(send(readNlen)))
        val first = read(0, msg.size)
        val tail = read(msg.size, 2)
        assertEquals("9000", sw(first)); assertEquals("9000", sw(tail))
        assertArrayEquals(tag.ndefFile, data(first) + data(tail))
        assertTrue(tag.ndefFullyRead)
    }

    @Test fun `select file with trailing Le byte is accepted`() {
        send(selectApp)
        assertEquals("9000", send(hex("00A4000C02E10300")).toHex())
    }

    @Test fun `read past end of file returns what is left`() {
        send(selectApp); send(selectCc)
        val r = read(10, 0x20)
        assertEquals("9000", sw(r))
        assertEquals(5, data(r).size)
    }

    // --- wrong order ----------------------------------------------------------

    @Test fun `read binary before any select is rejected`() {
        assertEquals("6986", send(readCc).toHex())
    }

    @Test fun `select CC before selecting the application is rejected`() {
        assertEquals("6A82", send(selectCc).toHex())
        assertEquals(State.IDLE, tag.state)
    }

    @Test fun `select NDEF file before selecting the application is rejected`() {
        assertEquals("6A82", send(selectNdef).toHex())
    }

    @Test fun `read binary after app select but before file select is rejected`() {
        send(selectApp)
        assertEquals("6986", send(readNlen).toHex())
    }

    @Test fun `reselecting the application drops the selected file`() {
        send(selectApp); send(selectNdef)
        send(selectApp)
        assertEquals(State.APP_SELECTED, tag.state)
        assertEquals("6986", send(readNlen).toHex())
    }

    @Test fun `reset returns to idle`() {
        send(selectApp); send(selectNdef); send(readNlen); read(2, msg.size)
        tag.reset()
        assertEquals(State.IDLE, tag.state)
        assertFalse(tag.ndefFullyRead)
        assertEquals("6986", send(readNlen).toHex())
    }

    // --- unknown / malformed --------------------------------------------------

    @Test fun `selecting another AID fails and deselects`() {
        send(selectApp)
        assertEquals("6A82", send(hex("00A4040007A000000003101000")).toHex())
        assertEquals(State.IDLE, tag.state)
    }

    @Test fun `T4T v1 AID is not served`() {
        assertEquals("6A82", send(hex("00A4040007D276000085010000")).toHex())
    }

    @Test fun `unknown file id is rejected and keeps current selection`() {
        send(selectApp); send(selectCc)
        assertEquals("6A82", send(hex("00A4000C02E105")).toHex())
        assertEquals(State.CC_SELECTED, tag.state)
    }

    @Test fun `unknown instruction`() {
        assertEquals("6D00", send(hex("00CA000000")).toHex())
    }

    @Test fun `unknown class byte`() {
        assertEquals("6E00", send(hex("80A4040007D276000085010100")).toHex())
    }

    @Test fun `update binary is refused, tag is read-only`() {
        send(selectApp); send(selectNdef)
        assertEquals("6982", send(hex("00D6000002 0000")).toHex())
    }

    @Test fun `unsupported select P1`() {
        assertEquals("6A86", send(hex("00A4080002E103")).toHex())
    }

    @Test fun `too short APDUs`() {
        assertEquals("6700", send(hex("00A4")).toHex())
        assertEquals("6700", send(hex("00A40400")).toHex())
        assertEquals("6700", send(hex("00A4040007D276")).toHex()) // Lc says 7, only 2 data bytes
    }

    @Test fun `read binary without Le`() {
        send(selectApp); send(selectCc)
        assertEquals("6700", send(hex("00B00000")).toHex())
    }

    @Test fun `read binary offset beyond file`() {
        send(selectApp); send(selectCc)
        assertEquals("6B00", read(0x0F, 1).toHex())
    }

    @Test fun `read binary with short EF identifier is not supported`() {
        send(selectApp); send(selectCc)
        assertEquals("6A86", send(hex("00B0810002")).toHex())
    }
}
