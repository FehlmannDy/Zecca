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
import com.google.zxing.common.BitMatrix

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
    fun complete(archMs: Long = 420, stepMs: Long = 110, onEnd: (() -> Unit)? = null) {
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
        matrix = Qr.encode(value)
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
}

/**
 * The merchant space's backdrop (apps/web/components/zecca/glass/backdrop.tsx): the mint's dome, pediment and arches
 * in --line on --paper, under a warm light from the top right, a cool one from the bottom left and a soft vignette.
 * Drawn like the SVG's viewBox 0 0 1440 960 with preserveAspectRatio="xMidYMid slice".
 */
class BackdropDrawable(private val paper: Int, private val line: Int, private val brass: Int, private val sealed: Int, private val ink: Int) : android.graphics.drawable.Drawable() {
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = line
    }
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG)
    private val mint = Path().apply {
        moveTo(720f, 40f); lineTo(720f, 70f)
        moveTo(672f, 132f); arcTo(RectF(672f, 84f, 768f, 180f), 180f, 180f)
        moveTo(660f, 132f); lineTo(780f, 132f)
        moveTo(680f, 132f); lineTo(680f, 178f); lineTo(760f, 178f); lineTo(760f, 132f)
        moveTo(676f, 186f); lineTo(250f, 318f); moveTo(764f, 186f); lineTo(1190f, 318f)
    }
    private val arches = Path().apply {
        val w = 150f
        val x0 = (1440f - (7 * w + 6 * 46f)) / 2
        for (i in 0 until 7) {
            val x = x0 + i * (w + 46f)
            moveTo(x, 1010f); lineTo(x, 790f)
            arcTo(RectF(x, 790f - w / 2, x + w, 790f + w / 2), 180f, 180f)
            lineTo(x + w, 1010f)
        }
    }

    /** The light falloff changes only with the size: drawn once, at a quarter of the resolution (it is a soft glow). */
    private var light: android.graphics.Bitmap? = null
    private val bitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG)

    override fun draw(canvas: Canvas) {
        val b = bounds
        val w = b.width().toFloat()
        val h = b.height().toFloat()
        if (w <= 0f || h <= 0f) return
        canvas.drawColor(paper)
        val s = maxOf(w / 1440f, h / 960f)
        canvas.save()
        canvas.translate(b.left + (w - 1440f * s) / 2, b.top + (h - 960f * s) / 2)
        canvas.scale(s, s)
        stroke.strokeWidth = 2.5f
        canvas.drawPath(mint, stroke)
        stroke.strokeWidth = 3f
        canvas.drawPath(arches, stroke)
        canvas.restore()
        val l = light?.takeIf { it.width == (w / 4).toInt().coerceAtLeast(1) && it.height == (h / 4).toInt().coerceAtLeast(1) } ?: lightLayer(w / 4, h / 4).also { light = it }
        canvas.drawBitmap(l, null, android.graphics.RectF(b), bitmapPaint)
    }

    private fun lightLayer(w: Float, h: Float): android.graphics.Bitmap {
        val bmp = android.graphics.Bitmap.createBitmap(w.toInt().coerceAtLeast(1), h.toInt().coerceAtLeast(1), android.graphics.Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val r = android.graphics.RectF(0f, 0f, w, h)
        // radial-gradient(55% 45% at 68% 40%, brass 12%, transparent 70%)
        ellipse(c, r, w * 0.68f, h * 0.40f, w * 0.55f, h * 0.45f, intArrayOf(Ui.withAlpha(brass, 0.12f), Ui.withAlpha(brass, 0f)), floatArrayOf(0f, 0.7f))
        // radial-gradient(45% 40% at 12% 88%, sealed 9%, transparent 70%)
        ellipse(c, r, w * 0.12f, h * 0.88f, w * 0.45f, h * 0.40f, intArrayOf(Ui.withAlpha(sealed, 0.09f), Ui.withAlpha(sealed, 0f)), floatArrayOf(0f, 0.7f))
        // radial-gradient(120% 90% at 50% 40%, transparent 55%, color-mix(paper 70%, ink 6%) 100%)
        val mix = android.graphics.Color.rgb(
            (android.graphics.Color.red(paper) * 70 + android.graphics.Color.red(ink) * 6) / 76,
            (android.graphics.Color.green(paper) * 70 + android.graphics.Color.green(ink) * 6) / 76,
            (android.graphics.Color.blue(paper) * 70 + android.graphics.Color.blue(ink) * 6) / 76,
        )
        ellipse(c, r, w * 0.5f, h * 0.4f, w * 1.2f, h * 0.9f, intArrayOf(Ui.withAlpha(mix, 0f), Ui.withAlpha(mix, 0f), Ui.withAlpha(mix, 0.76f)), floatArrayOf(0f, 0.55f, 1f))
        return bmp
    }

    private fun ellipse(canvas: Canvas, area: android.graphics.RectF, cx: Float, cy: Float, rx: Float, ry: Float, colors: IntArray, stops: FloatArray) {
        val g = android.graphics.RadialGradient(cx, cy, rx, colors, stops, android.graphics.Shader.TileMode.CLAMP)
        g.setLocalMatrix(android.graphics.Matrix().apply { setScale(1f, ry / rx, cx, cy) })
        glow.shader = g
        canvas.drawRect(area, glow)
    }

    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = android.graphics.PixelFormat.OPAQUE
}

/** A full-width button whose icon sits next to its centred label (the web's inline-flex, gap-2), not at the edge. */
class IconButtonText(context: Context) : android.widget.TextView(context) {
    override fun onDraw(canvas: Canvas) {
        val d = compoundDrawablesRelative[0]
        val l = layout
        if (d == null || l == null) return super.onDraw(canvas)
        val content = l.getLineWidth(0) + d.bounds.width() + compoundDrawablePadding
        canvas.save()
        canvas.translate((width - content) / 2f - paddingLeft, 0f)
        super.onDraw(canvas)
        canvas.restore()
    }
}

/**
 * One line of large type set like CSS `leading-none` (the web's amounts and "Paid"): the view is as tall as the type
 * size, and the font's taller line (Manrope's is about 1.37 em) is centred on it, the way a browser does.
 */
class TightText(context: Context, color: Int, typeface: android.graphics.Typeface) : View(context) {
    private val paint = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        this.typeface = typeface
        fontFeatureSettings = "tnum"
    }
    private var layout: android.text.StaticLayout? = null

    /** The line box, in px: the largest type size in [text]. */
    var size = 0f
        set(v) { field = v; paint.textSize = v; layout = null; requestLayout(); invalidate() }

    var text: CharSequence = ""
        set(v) { field = v; layout = null; requestLayout(); invalidate() }

    var tracking: Float
        get() = paint.letterSpacing
        set(v) { paint.letterSpacing = v }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        setMeasuredDimension(w, Math.ceil(size.toDouble()).toInt())
    }

    override fun onDraw(canvas: Canvas) {
        val l = layout ?: android.text.StaticLayout.Builder.obtain(text, 0, text.length, paint, maxOf(1, width))
            .setAlignment(android.text.Layout.Alignment.ALIGN_CENTER)
            .setIncludePad(false)
            .setMaxLines(1)
            .build().also { layout = it }
        val ascent = -l.getLineAscent(0).toFloat()
        val descent = l.getLineDescent(0).toFloat()
        canvas.save()
        canvas.translate(0f, (height - ascent - descent) / 2f)
        l.draw(canvas)
        canvas.restore()
    }
}
