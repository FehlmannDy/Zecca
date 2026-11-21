package ch.ixh.zeccatill

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.view.View
import android.view.animation.DecelerateInterpolator
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/** The mint without its letters (apps/web/components/zecca/wordmark.tsx LogoMark): dome, pediment, arches, line art. */
class LogoMarkView(context: Context, color: Int) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        strokeWidth = 26f
        this.color = color
    }
    private val path = Path().apply {
        moveTo(643f, 103f); lineTo(643f, 128f)
        arc(643f, 185f, 50f)
        moveTo(578f, 185f); lineTo(708f, 185f)
        moveTo(596f, 185f); lineTo(596f, 250f); lineTo(690f, 250f); lineTo(690f, 185f)
        moveTo(592f, 255f); lineTo(197f, 384f); moveTo(694f, 255f); lineTo(1089f, 384f)
        moveTo(197f, 410f); lineTo(1089f, 410f); moveTo(197f, 467f); lineTo(1089f, 467f)
        moveTo(197f, 845f); lineTo(1083f, 845f); moveTo(197f, 902f); lineTo(1083f, 902f)
        for (i in 0 until 7) {
            val x = 205f + i * 131f
            moveTo(x, 1138f); lineTo(x, 995f)
            arcTo(RectF(x, 950f, x + 90f, 1040f), 180f, 180f)
            lineTo(x + 90f, 1138f)
        }
    }

    /** A half circle over the top, from the left end to the right end. */
    private fun Path.arc(cx: Float, cy: Float, r: Float) {
        moveTo(cx - r, cy)
        arcTo(RectF(cx - r, cy - r, cx + r, cy + r), 180f, 180f)
    }

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val h = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension((h * VB_W / VB_H).toInt(), h)
    }

    override fun onDraw(canvas: Canvas) {
        val s = height / VB_H
        canvas.save()
        canvas.scale(s, s)
        canvas.translate(-VB_X, -VB_Y)
        canvas.drawPath(path, paint)
        canvas.restore()
    }

    private companion object {
        const val VB_X = 170f
        const val VB_Y = 80f
        const val VB_W = 945f
        const val VB_H = 1080f
    }
}

/**
 * The seven arches (UI.md §1, apps/web/components/zecca/arches.tsx): a --line track and, over it, each arch drawn
 * from its left foot to its right one. [complete] fills them left to right, one after the other.
 */
class ArchesView(context: Context, private val track: Int, private val stroke: Int) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        strokeWidth = 2.4f
    }
    private val arches = (0 until N).map { i ->
        val x = i * (W + GAP) + 2f
        Path().apply {
            moveTo(x, H); lineTo(x, R + 2f)
            arcTo(RectF(x, 2f, x + W, 2f + W), 180f, 180f)
            lineTo(x + W, H)
        }
    }
    private val measures = arches.map { PathMeasure(it, false) }
    private val segment = Path()
    private var animator: ValueAnimator? = null

    /** 0..7, fractional. */
    var fill = 0f
        set(v) {
            field = v.coerceIn(0f, N.toFloat())
            invalidate()
        }

    init {
        contentDescription = "Payment complete"
    }

    /** Each arch fills in [archMs], [stepMs] after the one before it (the web's 260 ms ease-out, 30 ms apart, slowed a little). */
    fun complete(archMs: Long = 340, stepMs: Long = 70, onEnd: (() -> Unit)? = null) {
        animator?.cancel()
        val from = fill
        val total = archMs + stepMs * (N - 1)
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = total
            addUpdateListener {
                val t = it.animatedFraction * total
                var f = 0f
                for (i in 0 until N) {
                    val local = ((t - i * stepMs) / archMs).coerceIn(0f, 1f)
                    f += maxOf(if (from - i >= 1f) 1f else 0f, ease.getInterpolation(local))
                }
                fill = f
            }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) {
                    fill = N.toFloat()
                    onEnd?.invoke()
                }
            })
            start()
        }
    }

    override fun onDetachedFromWindow() {
        animator?.cancel()
        super.onDetachedFromWindow()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val h = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension((h * VB_W / VB_H).toInt(), h)
    }

    override fun onDraw(canvas: Canvas) {
        val s = height / VB_H
        canvas.save()
        canvas.scale(s, s)
        for (i in 0 until N) {
            paint.color = track
            canvas.drawPath(arches[i], paint)
            val f = (fill - i).coerceIn(0f, 1f)
            if (f > 0f) {
                segment.reset()
                measures[i].getSegment(0f, measures[i].length * f, segment, true)
                paint.color = stroke
                canvas.drawPath(segment, paint)
            }
        }
        canvas.restore()
    }

    private companion object {
        const val N = 7
        const val W = 22f
        const val GAP = 10f
        const val H = 40f
        const val R = W / 2
        const val VB_W = N * W + (N - 1) * GAP + 4f
        const val VB_H = H + 2f
        val ease = DecelerateInterpolator(1.6f)
    }
}

/** A QR code of [value], always dark on white so any phone camera reads it (apps/web/components/merchant/qr-code.tsx). */
class QrView(context: Context, private val dark: Int, private val light: Int, private val radius: Float, private val padding: Float, private val border: Int, private val borderWidth: Float) : View(context) {
    private var matrix: BitMatrix? = null
    private val fill = Paint().apply { style = Paint.Style.FILL }
    private val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val box = RectF()

    fun show(value: String, label: String) {
        matrix = encode(value)
        contentDescription = label
        invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        setMeasuredDimension(w, w)
    }

    override fun onDraw(canvas: Canvas) {
        bg.color = light
        box.set(borderWidth / 2, borderWidth / 2, width - borderWidth / 2, height - borderWidth / 2)
        canvas.drawRoundRect(box, radius, radius, bg)
        edge.color = border
        edge.strokeWidth = borderWidth
        canvas.drawRoundRect(box, radius, radius, edge)
        val m = matrix ?: return
        // Whole pixels per module, centred, so the code stays crisp.
        val avail = (width - 2 * padding).toInt()
        val cell = maxOf(1, avail / m.width)
        val off = (width - cell * m.width) / 2f
        fill.color = dark
        for (y in 0 until m.height) {
            var x = 0
            while (x < m.width) {
                if (!m[x, y]) { x++; continue }
                val start = x
                while (x < m.width && m[x, y]) x++
                canvas.drawRect(off + start * cell, off + y * cell, off + x * cell, off + (y + 1) * cell, fill)
            }
        }
    }

    companion object {
        /** Error correction M and no quiet zone (the white padding is the quiet zone), as on the web. */
        fun encode(value: String): BitMatrix =
            QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 0, EncodeHintType.CHARACTER_SET to "UTF-8"))
    }
}
