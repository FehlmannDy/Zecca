package ch.ixh.zeccatill

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.BitMatrix
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/** QR codes with zxing core (pure Java): the pay link out, the pairing link in. */
object Qr {
    /** Error correction M and no quiet zone (the white padding around it is the quiet zone), as on the web. */
    fun encode(value: String): BitMatrix =
        QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 0, EncodeHintType.CHARACTER_SET to "UTF-8"))

    private val hints = mapOf(DecodeHintType.TRY_HARDER to true)

    /** The text of the QR code in [source], or null when there is none. */
    fun decode(source: LuminanceSource): String? = try {
        QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), hints).text
    } catch (e: ReaderException) {
        null
    }
}
