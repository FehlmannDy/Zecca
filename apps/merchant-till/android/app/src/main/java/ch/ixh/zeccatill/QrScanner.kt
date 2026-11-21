@file:Suppress("DEPRECATION") // android.hardware.Camera: no AndroidX, and a preview plus frames is all a QR scan needs.

package ch.ixh.zeccatill

import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.hardware.Camera
import android.os.Handler
import android.os.Looper
import android.view.TextureView
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Reads a QR code from the back camera into [onText], once. The preview fills [view], centre-cropped. */
class QrScanner(private val view: TextureView, private val onText: (String) -> Unit, private val onError: (String) -> Unit) : TextureView.SurfaceTextureListener {

    private var camera: Camera? = null
    private val busy = AtomicBoolean(false)
    private val done = AtomicBoolean(false)
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    fun start() {
        view.surfaceTextureListener = this
        if (view.isAvailable) open(view.surfaceTexture!!, view.width, view.height)
    }

    fun stop() {
        done.set(true)
        camera?.let {
            it.setPreviewCallback(null)
            try { it.stopPreview() } catch (_: RuntimeException) {}
            it.release()
        }
        camera = null
        worker.shutdown()
    }

    private fun open(surface: SurfaceTexture, w: Int, h: Int) {
        if (camera != null || done.get()) return
        val id = (0 until Camera.getNumberOfCameras()).firstOrNull { i ->
            Camera.CameraInfo().also { Camera.getCameraInfo(i, it) }.facing == Camera.CameraInfo.CAMERA_FACING_BACK
        }
        if (id == null) return onError("This phone has no back camera. Type the code instead.")
        val cam = try { Camera.open(id) } catch (e: RuntimeException) { return onError("The camera is busy. Close other camera apps, or type the code instead.") }
        camera = cam
        try {
            val info = Camera.CameraInfo().also { Camera.getCameraInfo(id, it) }
            // The till is portrait only: the preview turns by the sensor's own angle.
            cam.setDisplayOrientation(info.orientation % 360)
            val p = cam.parameters
            val size = p.supportedPreviewSizes.minByOrNull { Math.abs(it.width * it.height - 1280 * 720) }!!
            p.setPreviewSize(size.width, size.height)
            if (Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE in p.supportedFocusModes) p.focusMode = Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE
            else if (Camera.Parameters.FOCUS_MODE_AUTO in p.supportedFocusModes) p.focusMode = Camera.Parameters.FOCUS_MODE_AUTO
            cam.parameters = p
            cropToFill(w, h, if (info.orientation % 180 == 0) size.width else size.height, if (info.orientation % 180 == 0) size.height else size.width)
            cam.setPreviewTexture(surface)
            cam.setPreviewCallback { data, _ -> frame(data, size.width, size.height) }
            cam.startPreview()
        } catch (e: Exception) {
            stop()
            onError("The camera could not start. Type the code instead.")
        }
    }

    private fun frame(data: ByteArray, w: Int, h: Int) {
        if (done.get() || !busy.compareAndSet(false, true)) return
        val copy = data.copyOf()
        worker.execute {
            val text = decode(PlanarYUVLuminanceSource(copy, w, h, 0, 0, w, h, false))
            busy.set(false)
            if (text != null && done.compareAndSet(false, true)) main.post { onText(text) }
        }
    }

    /** The preview keeps its proportions and fills the view; the overflow is cut off. */
    private fun cropToFill(viewW: Int, viewH: Int, previewW: Int, previewH: Int) {
        if (viewW == 0 || viewH == 0) return
        val scale = maxOf(viewW.toFloat() / previewW, viewH.toFloat() / previewH)
        val m = Matrix()
        m.setScale(previewW * scale / viewW, previewH * scale / viewH, viewW / 2f, viewH / 2f)
        view.setTransform(m)
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) = open(surface, width, height)
    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {}
    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        stop()
        return true
    }
    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}

    companion object {
        private val hints = mapOf(DecodeHintType.TRY_HARDER to true)

        /** The QR code's text in [source], or null. Pure zxing, so a JVM test can check it. */
        fun decode(source: LuminanceSource): String? = try {
            QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), hints).text
        } catch (e: NotFoundException) {
            null
        } catch (e: ReaderException) {
            null
        }
    }
}
