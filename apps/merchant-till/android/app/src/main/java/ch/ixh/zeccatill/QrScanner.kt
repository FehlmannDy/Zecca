@file:Suppress("DEPRECATION") // android.hardware.Camera: no AndroidX, and a preview plus frames is all a QR scan needs.

package ch.ixh.zeccatill

import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.hardware.Camera
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.TextureView
import com.google.zxing.PlanarYUVLuminanceSource
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Reads a QR code from the back camera into [onText], once. The preview fills [view], centre-cropped. The camera
 * runs on its own thread with two reused frame buffers, so the screen never waits for it; a frame is decoded only
 * when the previous one is done, and only its centre square (where the frame on screen is).
 */
class QrScanner(private val view: TextureView, private val onText: (String) -> Unit, private val onError: (String) -> Unit) : TextureView.SurfaceTextureListener {

    private val thread = HandlerThread("qr-camera").apply { start() }
    private val cam = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())
    private val done = AtomicBoolean(false)
    private var camera: Camera? = null

    fun start() {
        view.surfaceTextureListener = this
        if (view.isAvailable) onSurfaceTextureAvailable(view.surfaceTexture!!, view.width, view.height)
    }

    fun stop() {
        done.set(true)
        cam.post {
            camera?.let {
                it.setPreviewCallbackWithBuffer(null)
                try { it.stopPreview() } catch (_: RuntimeException) {}
                it.release()
            }
            camera = null
            thread.quitSafely()
        }
    }

    private fun fail(message: String) {
        if (done.compareAndSet(false, true)) main.post { onError(message) }
    }

    /** On the camera thread. */
    private fun open(surface: SurfaceTexture, w: Int, h: Int) {
        if (camera != null || done.get()) return
        val id = (0 until Camera.getNumberOfCameras()).firstOrNull { i ->
            Camera.CameraInfo().also { Camera.getCameraInfo(i, it) }.facing == Camera.CameraInfo.CAMERA_FACING_BACK
        } ?: return fail("This phone has no back camera. Type the code instead.")
        val c = try { Camera.open(id) } catch (e: RuntimeException) { return fail("The camera is busy. Close other camera apps, or type the code instead.") }
        camera = c
        try {
            val info = Camera.CameraInfo().also { Camera.getCameraInfo(id, it) }
            // The till is portrait only: the preview turns by the sensor's own angle.
            c.setDisplayOrientation(info.orientation % 360)
            val p = c.parameters
            val size = p.supportedPreviewSizes.minByOrNull { Math.abs(it.width * it.height - 1280 * 720) }!!
            p.setPreviewSize(size.width, size.height)
            p.previewFormat = android.graphics.ImageFormat.NV21
            if (Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE in p.supportedFocusModes) p.focusMode = Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE
            else if (Camera.Parameters.FOCUS_MODE_AUTO in p.supportedFocusModes) p.focusMode = Camera.Parameters.FOCUS_MODE_AUTO
            c.parameters = p
            val turned = info.orientation % 180 != 0
            main.post { cropToFill(w, h, if (turned) size.height else size.width, if (turned) size.width else size.height) }
            c.setPreviewTexture(surface)
            repeat(2) { c.addCallbackBuffer(ByteArray(size.width * size.height * 3 / 2)) }
            c.setPreviewCallbackWithBuffer { data, camera -> frame(data, size.width, size.height, camera) }
            c.startPreview()
        } catch (e: Exception) {
            c.release()
            camera = null
            fail("The camera could not start. Type the code instead.")
        }
    }

    /** On the camera thread: decode the centre square, then hand the buffer back for another frame. */
    private fun frame(data: ByteArray, w: Int, h: Int, c: Camera) {
        if (done.get()) return
        val side = minOf(w, h) * 4 / 5
        val text = Qr.decode(PlanarYUVLuminanceSource(data, w, h, (w - side) / 2, (h - side) / 2, side, side, false))
        if (text != null && done.compareAndSet(false, true)) main.post { onText(text) }
        else c.addCallbackBuffer(data)
    }

    /** The preview keeps its proportions and fills the view; the overflow is cut off. */
    private fun cropToFill(viewW: Int, viewH: Int, previewW: Int, previewH: Int) {
        if (viewW == 0 || viewH == 0) return
        val scale = maxOf(viewW.toFloat() / previewW, viewH.toFloat() / previewH)
        val m = Matrix()
        m.setScale(previewW * scale / viewW, previewH * scale / viewH, viewW / 2f, viewH / 2f)
        view.setTransform(m)
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        cam.post { open(surface, width, height) }
    }
    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {}
    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        stop()
        return true
    }
    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}
}
