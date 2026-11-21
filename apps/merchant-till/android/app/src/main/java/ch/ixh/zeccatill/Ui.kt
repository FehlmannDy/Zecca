package ch.ixh.zeccatill

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.style.MetricAffectingSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File

/**
 * Zecca's look in plain Android views (docs/UI.md, apps/web/components/zecca): tokens from res/values(-night)/colors.xml,
 * Manrope for text with tabular figures, Montserrat for the wordmark and uppercase labels, radius 20 on cards and
 * 14 on inputs and buttons, 1 px hairlines in --line. Sizes are the web's CSS px, as dp (sp for text).
 */
class Ui(val ctx: Context) {

    private fun color(id: Int) = ctx.getColor(id)
    val paper = color(R.color.paper)
    val surface = color(R.color.surface)
    val ink = color(R.color.ink)
    val muted = color(R.color.muted)
    val line = color(R.color.line)
    val brass = color(R.color.brass)
    val green = color(R.color.`in`)
    val alert = color(R.color.alert)

    val regular = font(R.font.manrope_regular, "manrope_regular")
    val medium = font(R.font.manrope_medium, "manrope_medium")
    val semibold = font(R.font.manrope_semibold, "manrope_semibold")
    val bold = font(R.font.manrope_bold, "manrope_bold")
    val extrabold = font(R.font.manrope_extrabold, "manrope_extrabold")
    val display = font(R.font.montserrat_medium, "montserrat_medium")

    fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()
    fun dp(v: Int): Int = dp(v.toFloat())
    fun sp(v: Float): Float = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v, ctx.resources.displayMetrics)

    /** res/font on API 26+; below, the same file read as a raw resource. */
    private fun font(id: Int, name: String): Typeface = try {
        if (Build.VERSION.SDK_INT >= 26) ctx.resources.getFont(id)
        else {
            val f = File(ctx.cacheDir, "$name.ttf")
            if (!f.exists()) ctx.resources.openRawResource(id).use { i -> f.outputStream().use { i.copyTo(it) } }
            Typeface.createFromFile(f)
        }
    } catch (e: Exception) {
        Typeface.DEFAULT
    }

    fun text(s: CharSequence = "", size: Float = 15f, face: Typeface = regular, color: Int = ink, tracking: Float = 0f): TextView =
        style(TextView(ctx), s, size, face, color, tracking)

    /** Body text: Manrope, tabular figures, the web's 1.5 line height (Manrope's own is about 1.37). */
    fun <T : TextView> style(tv: T, s: CharSequence, size: Float, face: Typeface, color: Int, tracking: Float = 0f): T =
        tv.apply {
            text = s
            setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
            typeface = face
            setTextColor(color)
            letterSpacing = tracking
            fontFeatureSettings = "tnum"
            includeFontPadding = false
            setLineSpacing(0f, 1.1f)
        }

    /** Section labels: Montserrat 500, uppercase, 0.12em, 11 px. */
    fun labelCaps(s: String, color: Int = muted): TextView =
        text(s.uppercase(), 11f, display, color, 0.12f).apply { setLineSpacing(0f, 1.2f) }

    fun rounded(fill: Int, radius: Float, stroke: Int? = null, strokeWidth: Float = 1f): GradientDrawable =
        GradientDrawable().apply {
            setColor(fill)
            cornerRadius = dp(radius).toFloat()
            if (stroke != null) setStroke(dp(strokeWidth).coerceAtLeast(1), stroke)
        }

    /** A press ripple in the ink colour over [content], clipped to the rounded shape. */
    fun pressable(content: Drawable?, radius: Float, pressAlpha: Float = 0.10f, rippleColor: Int = ink): Drawable {
        val ripple = RippleDrawable(ColorStateList.valueOf(withAlpha(rippleColor, pressAlpha)), content, rounded(Color.BLACK, radius))
        // The 2 px brass focus ring (UI.md §6), for keyboards and switch access.
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), android.graphics.drawable.LayerDrawable(arrayOf(ripple, rounded(Color.TRANSPARENT, radius, brass, 2f))))
            addState(intArrayOf(), ripple)
        }
    }

    enum class Kind { PRIMARY, SECONDARY, GHOST, ON_GREEN }

    /** Buttons: 48 dp tall, radius 14, 15 px Manrope bold (apps/web/components/zecca/bits.tsx). */
    fun button(label: String, kind: Kind = Kind.PRIMARY, icon: Int? = null): TextView = style(if (icon != null) IconButtonText(ctx) else TextView(ctx), label, 15f, bold, ink).apply {
        gravity = if (icon != null) Gravity.START or Gravity.CENTER_VERTICAL else Gravity.CENTER
        minHeight = dp(48)
        minimumHeight = dp(48)
        setPadding(dp(20), 0, dp(20), 0)
        isClickable = true
        isFocusable = true
        val (bg, fg) = when (kind) {
            Kind.PRIMARY -> rounded(ink, 14f) to paper
            Kind.SECONDARY -> rounded(surface, 14f, line) to ink
            Kind.GHOST -> null to muted
            // On the --in "Paid" screen: --paper button, --ink text, in both themes (till.tsx).
            Kind.ON_GREEN -> rounded(paper, 14f) to ink
        }
        setTextColor(fg)
        background = pressable(bg, 14f, if (kind == Kind.PRIMARY) 0.18f else 0.08f, if (kind == Kind.PRIMARY) paper else ink)
        if (icon != null) {
            val d = ctx.getDrawable(icon)!!.mutate()
            d.setTint(fg)
            d.setBounds(0, 0, dp(20), dp(20))
            setCompoundDrawablesRelative(d, null, null, null)
            compoundDrawablePadding = dp(8)
        }
    }

    fun isNight(): Boolean =
        (ctx.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

    fun setEnabledLook(v: View, enabled: Boolean) {
        v.isEnabled = enabled
        v.alpha = if (enabled) 1f else 0.4f
    }

    /** Inputs: 48 dp, radius 14, hairline border, --surface fill, 16 px text; a 2 px brass ring while focused. */
    fun input(hint: String, type: Int = InputType.TYPE_CLASS_TEXT): EditText = EditText(ctx).apply {
        this.hint = hint
        inputType = type
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        typeface = regular
        setTextColor(ink)
        setHintTextColor(withAlpha(muted, 0.8f))
        isSingleLine = true
        minHeight = dp(48)
        minimumHeight = dp(48)
        setPadding(dp(16), dp(10), dp(16), dp(10))
        background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), rounded(surface, 14f, brass, 2f))
            addState(intArrayOf(), rounded(surface, 14f, line))
        }
        if (Build.VERSION.SDK_INT >= 29) textCursorDrawable = GradientDrawable().apply { setColor(ink); setSize(dp(2), dp(20)) }
    }

    fun icon(id: Int, color: Int, size: Int = 20): ImageView = ImageView(ctx).apply {
        setImageDrawable(ctx.getDrawable(id)!!.mutate().also { it.setTint(color) })
        layoutParams = LinearLayout.LayoutParams(dp(size), dp(size))
    }

    fun column(gravity: Int = Gravity.CENTER_HORIZONTAL): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        this.gravity = gravity
    }

    fun row(gravity: Int = Gravity.CENTER_VERTICAL): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        this.gravity = gravity
    }

    /** Layout params for a child of a vertical LinearLayout. */
    fun lp(width: Int = ViewGroup.LayoutParams.MATCH_PARENT, height: Int = ViewGroup.LayoutParams.WRAP_CONTENT, top: Int = 0, gravity: Int = Gravity.CENTER_HORIZONTAL) =
        LinearLayout.LayoutParams(width, height).apply {
            topMargin = dp(top)
            this.gravity = gravity
        }

    val wrap = ViewGroup.LayoutParams.WRAP_CONTENT
    val match = ViewGroup.LayoutParams.MATCH_PARENT

    // ---------- amounts ----------

    /**
     * Money on screen (apps/web/components/zecca/amount.tsx, size "hero"): dollars 56 px bold, cents 28 px, lighter
     * (60%) on ink only, tabular figures.
     */
    fun amount(minor: Long, color: Int = ink, dimCents: Boolean = true, dollarsSize: Float = 56f): CharSequence {
        val p = Money.split(minor)
        val b = SpannableStringBuilder()
        b.append("$" + p.dollars, Face(bold, sp(dollarsSize), -0.045f), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        b.append("." + p.cents, Face(semibold, sp(dollarsSize / 2), -0.02f, alpha = if (dimCents) 0.6f else 1f), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        return b
    }

    /**
     * The amount being typed on the keypad (apps/web/components/zecca/amount-keypad.tsx): a small raised "$" at 50%,
     * the dollars large, and what is typed after the point smaller and lighter, like the cents everywhere else.
     */
    fun typedAmount(text: String): CharSequence {
        val shown = Keypad.shown(text)
        val size = typedSize(text)
        val dot = shown.indexOf('.')
        val dollars = if (dot >= 0) shown.substring(0, dot) else shown
        val b = SpannableStringBuilder()
        b.append("$", Face(semibold, size * 0.6f, 0f, alpha = 0.5f, shift = -size * 0.6f * 0.25f), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        b.append(groupDigits(dollars), Face(bold, size, -0.045f), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (dot >= 0) b.append(shown.substring(dot), Face(semibold, size * 0.5f, -0.02f, alpha = 0.6f), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        return b
    }

    /** 64 px, smaller as the amount gets longer (amount-keypad.tsx). */
    fun typedSize(text: String): Float = Keypad.shown(text).length.let { sp(if (it > 8) 44f else if (it > 5) 54f else 64f) }

    /** Large type on one line, leading-none (see [TightText]). */
    fun tight(s: CharSequence, size: Float, face: Typeface = bold, color: Int = ink, tracking: Float = 0f): TightText =
        TightText(ctx, color, face).apply {
            this.size = sp(size)
            this.tracking = tracking
            text = s
            contentDescription = s
        }

    private fun groupDigits(d: String) = d.reversed().chunked(3).joinToString(",").reversed()

    /** Typeface, size, tracking, opacity and baseline shift for a run of text, on every API level. */
    class Face(private val face: Typeface, private val size: Float, private val tracking: Float, private val alpha: Float = 1f, private val shift: Float = 0f) : MetricAffectingSpan() {
        override fun updateMeasureState(tp: TextPaint) = apply(tp)
        override fun updateDrawState(tp: TextPaint) {
            apply(tp)
            if (alpha < 1f) tp.color = withAlpha(tp.color, alpha * (Color.alpha(tp.color) / 255f))
        }
        private fun apply(tp: TextPaint) {
            tp.typeface = face
            tp.textSize = size
            tp.letterSpacing = tracking
            tp.fontFeatureSettings = "tnum"
            tp.baselineShift += shift.toInt()
        }
    }

    companion object {
        fun withAlpha(color: Int, a: Float): Int = Color.argb((a * 255).toInt().coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))
    }
}
