package ch.ixh.zeccatill

import android.Manifest
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** What survives the activity being recreated (a theme switch, a rotation on a tablet). */
private object Session {
    var typed = ""
    var reference = ""
    var charge: Charge? = null
    var notice: String? = null
}

/**
 * Zecca Till: pair with a code, then the till (UI.md §5.8, apps/web/components/merchant/till.tsx): keypad, large
 * amount, optional reference, "Charge"; a full screen with the amount, the QR code and the pay link served over NFC
 * from this app; the status from GET /v1/till/charges/:id every 2 s; full-screen "Paid" in --in; "New charge".
 */
class MainActivity : Activity() {

    private lateinit var ui: Ui
    private lateinit var store: TillStore
    /** The window: its background runs under the status and navigation bars. */
    private lateinit var root: FrameLayout
    /** The screen, inside the system bars (and above the keyboard). */
    private lateinit var content: FrameLayout
    private val main = Handler(Looper.getMainLooper())
    private var api: TillApi? = null
    private var nfc: NfcAdapter? = null

    private enum class Screen { PAIR, TILL, CHARGING, ENDED, PAID }
    private var screen: Screen? = null

    // Pair screen
    private var codeField: TextView? = null
    private var apiField: TextView? = null
    private var serverLine: TextView? = null
    private var pairError: TextView? = null
    private var pairButton: TextView? = null
    private var pairing = false
    private var scanner: QrScanner? = null
    private var scanOverlay: View? = null

    // Till screen
    private var amountText: TightText? = null
    private var tillMessage: TextView? = null
    private var chargeButton: TextView? = null
    private var creating = false

    // Charging screen
    private var statusDot: View? = null
    private var statusText: TextView? = null
    private var expiresText: TextView? = null
    private var cancelError: TextView? = null
    private var nfcLine: TextView? = null
    private var nfcButton: TextView? = null
    private var pulse: ObjectAnimator? = null
    private var pollFailed = false
    private var polling = false

    private var backCallback: Any? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui = Ui(this)
        store = TillStore(this)
        nfc = NfcAdapter.getDefaultAdapter(this)
        root = FrameLayout(this)
        content = FrameLayout(this)
        root.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        edgeToEdge()
        store.pairing()?.let { api = TillApi(it.api) { store.pairing()?.token } }
        render()
        handleLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLink(intent)
    }

    override fun onResume() {
        super.onResume()
        preferThisApp(true)
        if (screen == Screen.CHARGING) {
            refreshNfcLine()
            startPolling()
        }
    }

    override fun onPause() {
        preferThisApp(false)
        stopPolling()
        stopScan()
        super.onPause()
    }

    override fun onDestroy() {
        stopPolling()
        pulse?.cancel()
        super.onDestroy()
    }

    // ---------- screens ----------

    private fun render() {
        val c = Session.charge
        val next = when {
            store.pairing() == null -> Screen.PAIR
            c == null -> Screen.TILL
            c.status == ChargeStatus.PAID -> Screen.PAID
            c.status.open || c.status == ChargeStatus.UNKNOWN -> Screen.CHARGING
            else -> Screen.ENDED
        }
        ServedLink.url = c?.takeIf { it.status.open && next == Screen.CHARGING && servable(it.url) }?.url
        if (next == Screen.CHARGING) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (next == screen) {
            if (next == Screen.CHARGING) updateCharging()
            return
        }
        val previous = screen
        screen = next
        stopPolling()
        pulse?.cancel()
        content.removeAllViews()
        when (next) {
            Screen.PAIR -> buildPair()
            Screen.TILL -> buildTill()
            Screen.CHARGING -> buildCharging()
            Screen.ENDED -> buildEnded()
            Screen.PAID -> buildPaid(previous == Screen.CHARGING)
        }
        // Dark icons on a light background: --paper in the light theme, the light green "Paid" in the dark one.
        systemBarIcons(dark = (next != Screen.PAID) xor ui.isNight())
        updateBack()
        if (next == Screen.CHARGING) startPolling()
    }

    /** A scrolling page in --paper (or [bg]), padded for the status and navigation bars and the keyboard. */
    private fun page(bg: Int = ui.paper, center: Boolean = false, backdrop: Boolean = false, build: LinearLayout.() -> Unit): LinearLayout {
        root.background = if (backdrop) BackdropDrawable(ui.paper, ui.line, ui.brass, getColor(R.color.sealed), ui.ink) else android.graphics.drawable.ColorDrawable(bg)
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
        }
        val outer = FrameLayout(this)
        // A 16 dp gutter, and at most 420 dp of content, centred (the web's max-w-[420px] till).
        val side = maxOf(ui.dp(16), (resources.displayMetrics.widthPixels - ui.dp(420)) / 2)
        val col = ui.column(if (center) Gravity.CENTER else Gravity.CENTER_HORIZONTAL).apply {
            setPadding(side, 0, side, ui.dp(24))
            build()
        }
        outer.addView(col, FrameLayout.LayoutParams(ui.match, if (center) ui.match else ui.wrap))
        scroll.addView(outer, ViewGroup.LayoutParams(ui.match, ui.wrap))
        content.addView(scroll, FrameLayout.LayoutParams(ui.match, ui.match))
        return col
    }

    /** The header: the mint and the wordmark, as in the merchant space (h-14). */
    private fun header(parent: LinearLayout, action: View? = null) {
        val bar = ui.row().apply { minimumHeight = ui.dp(56) }
        val logo = ui.row().apply {
            addView(LogoMarkView(context, ui.ink), LinearLayout.LayoutParams(ui.wrap, ui.dp(28)))
            addView(ui.text("ZECCA", 16f, ui.display, ui.ink, 0.22f).apply { contentDescription = "Zecca" }, LinearLayout.LayoutParams(ui.wrap, ui.wrap).apply { leftMargin = ui.dp(10) })
        }
        bar.addView(logo, LinearLayout.LayoutParams(0, ui.wrap, 1f))
        if (action != null) bar.addView(action)
        parent.addView(bar, ui.lp(height = ui.dp(56)))
    }

    private fun title(parent: LinearLayout, label: String, heading: String) {
        parent.addView(ui.labelCaps(label), ui.lp(top = 16, gravity = Gravity.START))
        parent.addView(ui.text(heading, 28f, ui.extrabold, ui.ink, -0.035f).apply { setLineSpacing(0f, 1.15f) }, ui.lp(top = 8, gravity = Gravity.START))
    }

    // ---------- (1) pair ----------

    private fun buildPair() {
        page(backdrop = true) {
            header(this)
            title(this, "Zecca Till", "Pair this till")
            addView(ui.text("Scan the code shown in your Zecca merchant space.", 16f, ui.semibold), ui.lp(top = 12, gravity = Gravity.START))
            addView(ui.text("On a computer or another phone, open your business account, then Tills.", 15f, ui.regular, ui.muted), ui.lp(top = 6, gravity = Gravity.START))

            if (packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
                addView(ui.button("Scan the code", Ui.Kind.PRIMARY, R.drawable.ic_scan).apply { setOnClickListener { startScan() } }, ui.lp(top = 24))
                addView(divider("or type it"), ui.lp(top = 24))
            }

            val code = ui.input("ABCD 2345", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD).apply {
                gravity = Gravity.CENTER
                setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 26f)
                typeface = ui.extrabold
                letterSpacing = 0.14f
                minHeight = ui.dp(60)
                filters = arrayOf(InputFilter.AllCaps(), InputFilter.LengthFilter(11))
                imeOptions = EditorInfo.IME_ACTION_GO
                contentDescription = "Pairing code"
                setOnEditorActionListener { _, _, _ -> pairTyped(); true }
                addTextChangedListener(watch { pairError?.text = "" })
            }
            codeField = code
            addView(code, ui.lp(top = if (packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) 12 else 24))

            val server = ui.input(PairingPayload.PROD_API, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI).apply {
                setText(store.lastApi() ?: PairingPayload.PROD_API)
                setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
                contentDescription = "Server"
                visibility = View.GONE
            }
            apiField = server
            serverLine = ui.text(serverLabel(server.text.toString()), 13.5f, ui.regular, ui.muted).apply {
                gravity = Gravity.CENTER
                minHeight = ui.dp(44)
                setOnClickListener {
                    server.visibility = View.VISIBLE
                    visibility = View.GONE
                    server.requestFocus()
                }
            }
            addView(serverLine, ui.lp(top = 4))
            addView(server, ui.lp(top = 8))

            pairError = ui.text("", 14f, ui.regular, ui.alert).apply { gravity = Gravity.CENTER; minHeight = ui.dp(20) }
            addView(pairError, ui.lp(top = 8))
            Session.notice?.let { pairError?.text = it; Session.notice = null }

            pairButton = ui.button("Pair").apply { setOnClickListener { pairTyped() } }
            addView(pairButton, ui.lp(top = 8))

            addView(ui.text("A code works once, for 10 minutes. This till can only take charges: it never sees your balance or your sales.", 13.5f, ui.regular, ui.muted).apply { gravity = Gravity.CENTER }, ui.lp(top = 24))
        }
    }

    private fun serverLabel(api: String) = "Server: ${api.removePrefix("https://")} · Change"

    private fun divider(label: String): View = ui.row().apply {
        val l1 = View(context).apply { setBackgroundColor(ui.line) }
        val l2 = View(context).apply { setBackgroundColor(ui.line) }
        addView(l1, LinearLayout.LayoutParams(0, maxOf(1, ui.dp(1)), 1f))
        addView(ui.text(label, 13f, ui.regular, ui.muted), LinearLayout.LayoutParams(ui.wrap, ui.wrap).apply { leftMargin = ui.dp(12); rightMargin = ui.dp(12) })
        addView(l2, LinearLayout.LayoutParams(0, maxOf(1, ui.dp(1)), 1f))
    }

    private fun pairTyped() {
        val code = PairingPayload.normalizeCode(codeField?.text?.toString().orEmpty())
            ?: return showPairError(PairingPayload.BAD_CODE)
        val apiText = apiField?.text?.toString()?.ifBlank { PairingPayload.PROD_API } ?: PairingPayload.PROD_API
        PairingPayload.checkApi(apiText, BuildConfig.DEBUG)?.let { return showPairError(it) }
        pair(Pairing(PairingPayload.normalizeApi(apiText), code))
    }

    private fun showPairError(message: String) {
        pairError?.text = message
        pairError?.announceForAccessibility(message)
    }

    private fun pair(p: Pairing) {
        if (pairing) return
        pairing = true
        pairButton?.text = "Pairing…"
        pairButton?.let { ui.setEnabledLook(it, false) }
        pairError?.text = ""
        val name = (Build.MODEL ?: "").trim().take(40).ifEmpty { "Till" }
        TillApi(p.api) { null }.pair(p.code, name) { r ->
            pairing = false
            pairButton?.text = "Pair"
            pairButton?.let { ui.setEnabledLook(it, true) }
            r.onSuccess { paired ->
                store.save(p.api, paired)
                api = TillApi(p.api) { store.pairing()?.token }
                Session.charge = null
                Session.typed = ""
                Session.reference = ""
                render()
                amountText?.announceForAccessibility("Paired with ${paired.merchantName}")
            }.onFailure { showPairError(it.message ?: TillJson.UNKNOWN_ERROR) }
        }
    }

    /** zecca-till://pair?... from the phone's camera app or a link: fills the form, the merchant taps "Pair". */
    private fun handleLink(intent: Intent?) {
        val data = intent?.dataString ?: return
        if (!data.startsWith("zecca-till:", ignoreCase = true)) return
        intent.data = null
        if (store.pairing() != null) {
            ask("Already paired", "This till takes charges for ${store.pairing()?.merchantName}. Unpair it first to pair it with another business.", null, "OK") {}
            return
        }
        when (val r = PairingPayload.parse(data, BuildConfig.DEBUG)) {
            is PairingPayload.Result.Ok -> {
                codeField?.setText(r.pairing.code.chunked(4).joinToString(" "))
                apiField?.text = r.pairing.api
                showServer(r.pairing.api)
                pairError?.text = ""
            }
            is PairingPayload.Result.Refused -> showPairError(r.reason)
        }
    }

    private fun showServer(api: String) {
        if (api == PairingPayload.PROD_API) return
        apiField?.visibility = View.VISIBLE
        serverLine?.visibility = View.GONE
    }

    // ---------- camera scan ----------

    private fun startScan() {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
            return
        }
        if (scanOverlay != null) return
        val overlay = FrameLayout(this).apply { setBackgroundColor(Color.BLACK); isClickable = true }
        val preview = TextureView(this)
        overlay.addView(preview, FrameLayout.LayoutParams(ui.match, ui.match))
        val bottom = ui.column().apply {
            setPadding(ui.dp(24), ui.dp(16), ui.dp(24), ui.dp(32))
            setBackgroundColor(Ui.withAlpha(Color.BLACK, 0.55f))
            addView(ui.text("Point the camera at the code in your Zecca merchant space.", 16f, ui.semibold, Color.WHITE).apply { gravity = Gravity.CENTER }, ui.lp())
            addView(ui.button("Cancel", Ui.Kind.GHOST).apply { setTextColor(Color.WHITE); setOnClickListener { stopScan() } }, ui.lp(width = ui.wrap, top = 12))
        }
        overlay.addView(ScanFrame(this, ui.dp(260).toFloat(), ui.dp(20).toFloat(), ui.dp(3).toFloat()), FrameLayout.LayoutParams(ui.match, ui.match))
        overlay.addView(bottom, FrameLayout.LayoutParams(ui.match, ui.wrap, Gravity.BOTTOM))
        bottom.setOnApplyWindowInsetsListener { v, insets ->
            @Suppress("DEPRECATION") val nav = if (Build.VERSION.SDK_INT >= 30) insets.getInsets(WindowInsets.Type.navigationBars()).bottom else insets.systemWindowInsetBottom
            v.setPadding(ui.dp(24), ui.dp(16), ui.dp(24), ui.dp(24) + nav)
            insets
        }
        root.addView(overlay, FrameLayout.LayoutParams(ui.match, ui.match))
        scanOverlay = overlay
        systemBarIcons(dark = false)
        updateBack()
        scanner = QrScanner(preview, onText = { text ->
            stopScan()
            when (val r = PairingPayload.parse(text, BuildConfig.DEBUG)) {
                is PairingPayload.Result.Ok -> {
                    codeField?.setText(r.pairing.code.chunked(4).joinToString(" "))
                    apiField?.text = r.pairing.api
                    showServer(r.pairing.api)
                    pair(r.pairing)
                }
                is PairingPayload.Result.Refused -> showPairError(r.reason)
            }
        }, onError = { message ->
            stopScan()
            showPairError(message)
        }).also { it.start() }
    }

    private fun stopScan() {
        scanner?.stop()
        scanner = null
        scanOverlay?.let { root.removeView(it) }
        if (scanOverlay != null) {
            scanOverlay = null
            systemBarIcons(dark = !ui.isNight())
            updateBack()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startScan()
        else showPairError("Without the camera, type the code shown in your Zecca merchant space.")
    }

    // ---------- (2) till ----------

    private fun buildTill() {
        val pairingInfo = store.pairing()!!
        page(backdrop = true) {
            header(this, ui.button("Unpair", Ui.Kind.GHOST).apply {
                setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13.5f)
                typeface = ui.semibold
                minHeight = ui.dp(44)
                setPadding(ui.dp(12), 0, ui.dp(12), 0)
                background = ui.pressable(null, 999f, 0.06f)
                setOnClickListener { confirmUnpair() }
            })
            title(this, "Till", pairingInfo.merchantName.ifEmpty { "Your business" })

            val till = ui.column().apply { setPadding(0, ui.dp(28), 0, 0) }
            till.addView(ui.labelCaps("Charge"), ui.lp(width = ui.wrap))
            amountText = ui.tight(ui.typedAmount(Session.typed), 64f)
            till.addView(amountText, ui.lp(top = 12))
            tillMessage = ui.text("", 14f, ui.regular, ui.alert).apply { gravity = Gravity.CENTER; minHeight = ui.dp(20) }
            till.addView(tillMessage, ui.lp(top = 12))
            till.addView(keypad(), ui.lp(width = ui.dp(320), top = 16))

            val ref = ui.input("Reference (optional)").apply {
                setText(Session.reference)
                filters = arrayOf(InputFilter.LengthFilter(60))
                imeOptions = EditorInfo.IME_ACTION_GO
                contentDescription = "Reference (optional)"
                addTextChangedListener(watch { Session.reference = it })
                setOnEditorActionListener { _, _, _ -> charge(); true }
                // Above the keyboard, show the field and "Charge" under it.
                setOnFocusChangeListener { _, has ->
                    if (has) postDelayed({ chargeButton?.let { b -> b.requestRectangleOnScreen(android.graphics.Rect(0, 0, b.width, b.height + ui.dp(16))) } }, 350)
                }
            }
            till.addView(ref, ui.lp(width = ui.dp(320), top = 16))
            chargeButton = ui.button("Charge").apply { setOnClickListener { charge() } }
            till.addView(chargeButton, ui.lp(width = ui.dp(320), top = 16))
            addView(till, ui.lp())
        }
        updateTill()
    }

    /** 1-9, ".", 0, delete; 56 dp keys, 8 dp apart, radius 14 (apps/web/components/zecca/amount-keypad.tsx). */
    private fun keypad(): View {
        val short = resources.configuration.screenHeightDp < 760
        val grid = ui.column()
        val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", Keypad.BACK)
        for (r in 0 until 4) {
            val row = ui.row()
            for (c in 0 until 3) {
                val k = keys[r * 3 + c]
                val key: View = if (k == Keypad.BACK) {
                    FrameLayout(this).apply {
                        addView(ui.icon(R.drawable.ic_delete, ui.ink, 24), FrameLayout.LayoutParams(ui.dp(24), ui.dp(24), Gravity.CENTER))
                        contentDescription = "Delete"
                        setOnLongClickListener { Session.typed = ""; updateTill(); true }
                    }
                } else {
                    ui.text(k, 24f, ui.semibold).apply {
                        gravity = Gravity.CENTER
                        contentDescription = if (k == ".") "Decimal point" else k
                    }
                }
                key.isClickable = true
                key.isFocusable = true
                key.background = ui.pressable(null, 14f, 0.10f)
                key.setOnClickListener {
                    Session.typed = Keypad.press(Session.typed, k)
                    it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    updateTill()
                }
                row.addView(key, LinearLayout.LayoutParams(0, ui.dp(if (short) 48 else 56), 1f).apply {
                    if (c > 0) leftMargin = ui.dp(8)
                })
            }
            grid.addView(row, ui.lp(top = if (r == 0) 0 else 8))
        }
        return grid
    }

    private fun updateTill() {
        val minor = Money.parse(Session.typed)
        amountText?.text = ui.typedAmount(Session.typed)
        amountText?.size = ui.typedSize(Session.typed)
        amountText?.contentDescription = "Charge " + Money.spoken(minor ?: 0)
        tillMessage?.text = ""
        val can = minor != null && minor > 0 && !creating
        chargeButton?.let {
            it.text = if (creating) "Charging…" else if (minor != null && minor > 0) "Charge ${Money.format(minor)}" else "Charge"
            ui.setEnabledLook(it, can)
        }
    }

    private fun charge() {
        val minor = Money.parse(Session.typed) ?: return
        val a = api ?: return
        if (minor <= 0 || creating) return
        creating = true
        updateTill()
        a.createCharge(minor, Session.reference) { r ->
            creating = false
            r.onSuccess { c ->
                Session.charge = c
                render()
            }.onFailure { e ->
                if (!unpairedBy(e)) {
                    updateTill()
                    tillMessage?.text = e.message ?: "We couldn't create the charge. Try again."
                    tillMessage?.announceForAccessibility(tillMessage?.text)
                }
            }
        }
    }

    private fun confirmUnpair() {
        val name = store.pairing()?.merchantName.orEmpty()
        ask("Unpair this till?", "It stops taking charges for $name. Remove it from Tills in your merchant space too.", "Keep", "Unpair") { unpair(null) }
    }

    /** A small card in Zecca's look (radius 20, --surface, the web's buttons) instead of the system dialog. */
    private fun ask(title: String, message: String, cancel: String?, confirm: String, onConfirm: () -> Unit) {
        val d = android.app.Dialog(this)
        d.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        val card = ui.column(Gravity.START).apply {
            background = ui.rounded(ui.surface, 20f, ui.line)
            setPadding(ui.dp(24), ui.dp(24), ui.dp(24), ui.dp(20))
            addView(ui.text(title, 19f, ui.extrabold, ui.ink, -0.02f), ui.lp(gravity = Gravity.START))
            addView(ui.text(message, 15f, ui.regular, ui.muted), ui.lp(top = 8, gravity = Gravity.START))
            val buttons = ui.row(Gravity.END or Gravity.CENTER_VERTICAL)
            if (cancel != null) buttons.addView(ui.button(cancel, Ui.Kind.GHOST).apply { setTextColor(ui.ink); setOnClickListener { d.dismiss() } })
            buttons.addView(ui.button(confirm).apply {
                setOnClickListener {
                    d.dismiss()
                    onConfirm()
                }
            }, LinearLayout.LayoutParams(ui.wrap, ui.wrap).apply { leftMargin = ui.dp(8) })
            addView(buttons, ui.lp(top = 24))
        }
        d.setContentView(card)
        d.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        d.window?.setLayout(minOf(resources.displayMetrics.widthPixels - ui.dp(48), ui.dp(380)), ViewGroup.LayoutParams.WRAP_CONTENT)
        d.show()
    }

    private fun unpair(notice: String?) {
        store.forget()
        api = null
        Session.charge = null
        Session.typed = ""
        Session.reference = ""
        Session.notice = notice
        render()
    }

    /** A 401 means the merchant unpaired this till: back to the pairing screen with the API's message. */
    private fun unpairedBy(e: Throwable): Boolean {
        if (e !is TillApiError || e.status != 401) return false
        unpair(e.message)
        return true
    }

    // ---------- (3) charging ----------

    private fun buildCharging() {
        val c = Session.charge!!
        page {
            setPadding(paddingLeft, ui.dp(8), paddingRight, ui.dp(24))
            val cancel = ui.button("Cancel charge", Ui.Kind.GHOST, R.drawable.ic_x).apply {
                setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
                typeface = ui.semibold
                minHeight = ui.dp(44)
                setPadding(ui.dp(12), 0, ui.dp(12), 0)
                compoundDrawablePadding = ui.dp(6)
                compoundDrawablesRelative[0]?.setBounds(0, 0, ui.dp(16), ui.dp(16))
                setCompoundDrawablesRelative(compoundDrawablesRelative[0], null, null, null)
                background = ui.pressable(null, 999f, 0.05f)
                setOnClickListener { cancelCharge() }
            }
            addView(cancel, ui.lp(width = ui.wrap, gravity = Gravity.END))
            // Measured against the web till: its hero amount sits higher in a taller box (the cents keep the body line height).
            addView(ui.tight(ui.amount(c.amountMinor), 56f).apply { contentDescription = "Charge " + Money.spoken(c.amountMinor) }, ui.lp(top = 0))
            addView(View(context), ui.lp(height = ui.dp(8)))
            c.reference?.let { addView(ui.text(it, 15f, ui.regular, ui.muted).apply { gravity = Gravity.CENTER }, ui.lp(top = 8)) }

            val qr = QrView(context, getColor(R.color.qr_dark), getColor(R.color.qr_light), ui.dp(20).toFloat(), ui.dp(16).toFloat(), ui.line, maxOf(1, ui.dp(1)).toFloat())
            qr.show(c.url, "Payment code for ${Money.format(c.amountMinor)}")
            addView(qr, ui.lp(width = minOf(ui.dp(300), resources.displayMetrics.widthPixels - ui.dp(40)), top = 27))

            nfcLine = ui.text("Hold the customer's phone to the back of this one", 15f, ui.semibold).apply {
                gravity = Gravity.CENTER
                setCompoundDrawablesRelative(null, null, null, null)
            }
            addView(nfcLine, ui.lp(width = ui.dp(300), top = 20))
            nfcButton = ui.button("Turn on NFC", Ui.Kind.SECONDARY, R.drawable.ic_nfc).apply {
                setOnClickListener {
                    try { startActivity(Intent(Settings.ACTION_NFC_SETTINGS)) } catch (e: Exception) { startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS)) }
                }
            }
            addView(nfcButton, ui.lp(width = ui.dp(300), top = 12))

            val status = ui.row(Gravity.CENTER).apply {
                statusDot = View(context).apply { background = ui.rounded(ui.muted, 999f) }
                addView(statusDot, LinearLayout.LayoutParams(ui.dp(10), ui.dp(10)).apply { rightMargin = ui.dp(8) })
                statusText = ui.text("", 16f, ui.semibold)
                addView(statusText)
            }
            addView(status, ui.lp(width = ui.wrap, top = 24))
            expiresText = ui.text("", 13.5f, ui.regular, ui.muted).apply { gravity = Gravity.CENTER }
            addView(expiresText, ui.lp(top = 6))
            cancelError = ui.text("", 14f, ui.regular, ui.alert).apply { gravity = Gravity.CENTER; visibility = View.GONE }
            addView(cancelError, ui.lp(top = 12))
        }
        refreshNfcLine()
        updateCharging()
    }

    private fun refreshNfcLine() {
        val adapter = nfc
        val hce = packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION)
        when {
            adapter == null || !hce -> {
                nfcLine?.visibility = View.GONE
                nfcButton?.visibility = View.GONE
            }
            !adapter.isEnabled -> {
                nfcLine?.visibility = View.VISIBLE
                nfcLine?.text = "Turn on NFC to take taps. The QR code works without it."
                nfcLine?.setTextColor(ui.muted)
                nfcButton?.visibility = View.VISIBLE
            }
            else -> {
                nfcLine?.visibility = View.VISIBLE
                nfcLine?.text = "Hold the customer's phone to the back of this one"
                nfcLine?.setTextColor(ui.ink)
                nfcButton?.visibility = View.GONE
            }
        }
    }

    private fun updateCharging() {
        val c = Session.charge ?: return
        val paying = c.status == ChargeStatus.OPENED
        statusText?.text = c.status.line.ifEmpty { ChargeStatus.CREATED.line }
        statusDot?.background = ui.rounded(if (paying) ui.brass else ui.muted, 999f)
        if (paying && pulse == null) {
            pulse = ObjectAnimator.ofFloat(statusDot, View.ALPHA, 1f, 0.35f).apply {
                duration = 1000
                repeatMode = ValueAnimator.REVERSE
                repeatCount = ValueAnimator.INFINITE
                start()
            }
        }
        val now = System.currentTimeMillis()
        expiresText?.text = "Expires in ${ChargeStatus.expiresIn(c.expiresAtMs, now)}" + if (pollFailed) " · Reconnecting" else ""
    }

    private val tick = object : Runnable {
        override fun run() {
            updateCharging()
            main.postDelayed(this, 1000)
        }
    }

    private val poll = object : Runnable {
        override fun run() {
            val c = Session.charge
            val a = api
            if (c == null || a == null || screen != Screen.CHARGING) return
            a.charge(c.id) { r -> onChargeAnswer(c.id, r, fromPoll = true) }
            main.postDelayed(this, POLL_MS)
        }
    }

    private fun startPolling() {
        if (polling) return
        polling = true
        main.post(poll)
        main.post(tick)
    }

    private fun stopPolling() {
        polling = false
        main.removeCallbacks(poll)
        main.removeCallbacks(tick)
    }

    private fun onChargeAnswer(id: String, r: Result<Charge>, fromPoll: Boolean) {
        val current = Session.charge ?: return
        if (current.id != id) return
        r.onSuccess { incoming ->
            pollFailed = false
            Session.charge = current.merge(incoming)
            render()
        }.onFailure { e ->
            if (unpairedBy(e)) return
            if (fromPoll) {
                pollFailed = true
                updateCharging()
            }
        }
    }

    private fun cancelCharge() {
        val c = Session.charge ?: return
        val a = api ?: return
        cancelError?.visibility = View.GONE
        a.cancel(c.id) { r ->
            r.onFailure { e ->
                if (unpairedBy(e)) return@cancel
                cancelError?.text = e.message ?: "We couldn't cancel it. Try again."
                cancelError?.visibility = View.VISIBLE
                cancelError?.announceForAccessibility(cancelError?.text)
                a.charge(c.id) { p -> onChargeAnswer(c.id, p, fromPoll = false) }
            }
            r.onSuccess { onChargeAnswer(c.id, r, fromPoll = false) }
        }
    }

    // ---------- expired / cancelled ----------

    private fun buildEnded() {
        val c = Session.charge!!
        page {
            setPadding(paddingLeft, ui.dp(8), paddingRight, ui.dp(24))
            addView(View(context), ui.lp(height = ui.dp(44)))
            addView(ui.tight(ui.amount(c.amountMinor), 56f).apply { contentDescription = Money.spoken(c.amountMinor) }, ui.lp(top = 0))
            addView(View(context), ui.lp(height = ui.dp(8)))
            c.reference?.let { addView(ui.text(it, 15f, ui.regular, ui.muted).apply { gravity = Gravity.CENTER }, ui.lp(top = 8)) }
            val line = ui.text(c.status.line, 17f, ui.semibold).apply { gravity = Gravity.CENTER }
            addView(line, ui.lp(top = 40))
            if (c.status == ChargeStatus.EXPIRED) {
                addView(ui.text("The customer did not pay in time. Start a new charge.", 15f, ui.regular, ui.muted).apply { gravity = Gravity.CENTER }, ui.lp(top = 6))
            }
            addView(ui.button("New charge").apply {
                minWidth = ui.dp(220)
                setOnClickListener { newCharge() }
            }, ui.lp(width = ui.wrap, top = 32))
            line.post { line.announceForAccessibility(c.status.line) }
        }
    }

    // ---------- (4) paid ----------

    private fun buildPaid(animate: Boolean) {
        val c = Session.charge!!
        // Text in --paper on --in reads in both themes (till.tsx).
        val onGreen = ui.paper
        page(bg = ui.green, center = true) {
            val arches = ArchesView(context, Ui.withAlpha(onGreen, 0.3f), onGreen)
            addView(arches, ui.lp(width = ui.wrap, height = ui.dp(56)))
            addView(ui.tight("Paid", 56f, ui.extrabold, onGreen, -0.04f), ui.lp(top = 32))
            addView(ui.tight(ui.amount(c.amountMinor, dimCents = false), 56f, ui.bold, onGreen).apply { contentDescription = Money.spoken(c.amountMinor) }, ui.lp(top = 8))
            addView(View(context), ui.lp(height = ui.dp(8)))
            c.reference?.let { addView(ui.text(it, 16f, ui.regular, Ui.withAlpha(onGreen, 0.85f)).apply { gravity = Gravity.CENTER }, ui.lp(top = 12)) }
            val time = SimpleDateFormat("h:mm a", Locale.US).format(Date(c.paidAtMs ?: System.currentTimeMillis()))
            addView(ui.text(time, 15f, ui.regular, Ui.withAlpha(onGreen, 0.85f)).apply { gravity = Gravity.CENTER }, ui.lp(top = 8))
            addView(ui.button("New charge", Ui.Kind.ON_GREEN).apply {
                minWidth = ui.dp(220)
                setOnClickListener { newCharge() }
            }, ui.lp(width = ui.wrap, top = 40))
            // A beat after the screen turns green, the arches fill one after the other.
            if (animate) arches.postDelayed({ arches.complete() }, 180) else arches.fill = 7f
            arches.post {
                root.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.LONG_PRESS)
                root.announceForAccessibility("Paid, ${Money.spoken(c.amountMinor)}")
            }
        }
    }

    private fun newCharge() {
        Session.charge = null
        Session.typed = ""
        Session.reference = ""
        pollFailed = false
        render()
    }

    // ---------- NFC ----------

    /** Only links on the paired API's web: https, or http to the emulator's host in a debug build. */
    private fun servable(url: String): Boolean =
        NdefUri.checkUrl(url) == null && (url.startsWith("https://") || (BuildConfig.DEBUG && url.startsWith("http://")))

    /** While the till is on screen, taps go to it rather than to NFC PayLink (same AID). */
    private fun preferThisApp(on: Boolean) {
        val adapter = nfc ?: return
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION)) return
        try {
            val ce = CardEmulation.getInstance(adapter)
            if (on) ce.setPreferredService(this, ComponentName(this, TillApduService::class.java)) else ce.unsetPreferredService(this)
        } catch (e: Exception) {
            // Not every phone supports a preferred service; the tag still works when this is the only HCE app.
        }
    }

    // ---------- window ----------

    @Suppress("DEPRECATION")
    private fun edgeToEdge() {
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
        } else {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
        applyInsets(content)
    }

    @Suppress("DEPRECATION")
    private fun applyInsets(v: View) {
        v.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
                view.setPadding(i.left, i.top, i.right, i.bottom)
            } else {
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
    }

    /** Dark icons on a light background, light icons on a dark one (the green "Paid" in the light theme, the camera). */
    @Suppress("DEPRECATION")
    private fun systemBarIcons(dark: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (dark) mask else 0, mask)
        } else {
            val light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or (if (Build.VERSION.SDK_INT >= 26) View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR else 0)
            val f = window.decorView.systemUiVisibility
            window.decorView.systemUiVisibility = if (dark) f or light else f and light.inv()
        }
    }

    // ---------- back ----------

    /** Back closes the camera, and leaves a finished charge; it never drops an open one ("Cancel charge" does). */
    private fun onBack(): Boolean = when {
        scanOverlay != null -> { stopScan(); true }
        screen == Screen.CHARGING -> true
        screen == Screen.PAID || screen == Screen.ENDED -> { newCharge(); true }
        else -> false
    }

    private fun updateBack() {
        if (Build.VERSION.SDK_INT < 33) return
        val wanted = scanOverlay != null || screen == Screen.CHARGING || screen == Screen.PAID || screen == Screen.ENDED
        val d = onBackInvokedDispatcher
        if (wanted && backCallback == null) {
            val cb = OnBackInvokedCallback { onBack() }
            d.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb)
            backCallback = cb
        } else if (!wanted && backCallback != null) {
            d.unregisterOnBackInvokedCallback(backCallback as OnBackInvokedCallback)
            backCallback = null
        }
    }

    @Deprecated("Below API 33 only; OnBackInvokedCallback above.")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (!onBack()) super.onBackPressed()
    }

    private fun watch(f: (String) -> Unit) = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: Editable?) = f(s?.toString().orEmpty())
    }

    private companion object {
        const val POLL_MS = 2000L
        const val REQ_CAMERA = 7
    }
}

/** The camera overlay's frame: a rounded square of [size] in the middle, the rest dimmed. */
private class ScanFrame(context: android.content.Context, private val size: Float, private val radius: Float, private val stroke: Float) : View(context) {
    private val dim = android.graphics.Paint().apply { color = Ui.withAlpha(Color.BLACK, 0.45f) }
    private val edge = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = android.graphics.Paint.Style.STROKE; strokeWidth = stroke }
    private val hole = android.graphics.Path()
    override fun onDraw(canvas: android.graphics.Canvas) {
        val l = (width - size) / 2
        val t = (height - size) / 2.4f
        hole.reset()
        hole.fillType = android.graphics.Path.FillType.EVEN_ODD
        hole.addRect(0f, 0f, width.toFloat(), height.toFloat(), android.graphics.Path.Direction.CW)
        hole.addRoundRect(l, t, l + size, t + size, radius, radius, android.graphics.Path.Direction.CW)
        canvas.drawPath(hole, dim)
        canvas.drawRoundRect(l, t, l + size, t + size, radius, radius, edge)
    }
}
