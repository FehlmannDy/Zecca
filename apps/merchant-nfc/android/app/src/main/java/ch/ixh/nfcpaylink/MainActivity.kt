package ch.ixh.nfcpaylink

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView

/**
 * Merchant screen. The URL comes from the text field or from an intent extra:
 *   adb shell am start -n ch.ixh.nfcpaylink/.MainActivity --es url https://example.com/pay/demo
 */
class MainActivity : Activity() {

    private lateinit var urlField: EditText
    private lateinit var status: TextView
    private lateinit var lastTap: TextView
    private var nfc: NfcAdapter? = null
    private val service by lazy { ComponentName(this, PayLinkApduService::class.java) }
    private var discoveryNote = ""

    private val prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        runOnUiThread { refresh() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        // HCE only works while the merchant screen is on.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        nfc = NfcAdapter.getDefaultAdapter(this)
        urlField = findViewById(R.id.url)
        status = findViewById(R.id.status)
        lastTap = findViewById(R.id.last_tap)
        urlField.setText(PayLinkStore.url(this) ?: "")
        findViewById<Button>(R.id.serve).setOnClickListener { applyUrl(urlField.text.toString().trim()) }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val url = intent?.getStringExtra(EXTRA_URL) ?: return
        urlField.setText(url)
        applyUrl(url.trim())
    }

    private fun applyUrl(url: String) {
        val error = NdefUri.checkUrl(url)
        if (error != null) {
            urlField.error = error
            return
        }
        PayLinkStore.setUrl(this, url)
        refresh()
    }

    override fun onResume() {
        super.onResume()
        PayLinkStore.prefs(this).registerOnSharedPreferenceChangeListener(prefsListener)
        val adapter = nfc
        if (adapter != null) {
            // Win AID conflicts with other tag-emulator apps while we are in the foreground.
            runCatching { CardEmulation.getInstance(adapter).setPreferredService(this, service) }
                .onFailure { Log.w(PayLinkApduService.TAG, "setPreferredService failed", it) }
            // Android 15+: stop this phone from polling (reading) while in the foreground, so it
            // only listens as a tag and does not try to read the customer's phone.
            if (Build.VERSION.SDK_INT >= 35) {
                discoveryNote = runCatching {
                    adapter.setDiscoveryTechnology(this, NfcAdapter.FLAG_READER_DISABLE, NfcAdapter.FLAG_LISTEN_KEEP)
                    "Reader polling: disabled while this screen is open"
                }.getOrElse { "Reader polling: could not disable (${it.javaClass.simpleName})" }
            } else {
                discoveryNote = "Reader polling: still on (needs Android 15+ to disable)"
            }
        }
        refresh()
    }

    override fun onPause() {
        super.onPause()
        PayLinkStore.prefs(this).unregisterOnSharedPreferenceChangeListener(prefsListener)
        val adapter = nfc ?: return
        runCatching { CardEmulation.getInstance(adapter).unsetPreferredService(this) }
        if (Build.VERSION.SDK_INT >= 35) runCatching { adapter.resetDiscoveryTechnology(this) }
    }

    private fun refresh() {
        val adapter = nfc
        val lines = mutableListOf<String>()
        when {
            adapter == null -> lines += "NFC: not available on this phone"
            !adapter.isEnabled -> lines += "NFC: OFF, enable it in Settings"
            !packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION) ->
                lines += "NFC: on, but this phone has no host card emulation"
            else -> {
                lines += "NFC: on, HCE supported"
                val routed = runCatching {
                    CardEmulation.getInstance(adapter).isDefaultServiceForAid(service, "D2760000850101")
                }.getOrDefault(false)
                lines += "NDEF AID routed to this app: " + if (routed) "yes" else "NO (another app may own it)"
                lines += discoveryNote
            }
        }
        lines += "Serving: " + (PayLinkStore.url(this) ?: "(nothing yet)")
        status.text = lines.joinToString("\n")
        lastTap.text = "Last tap: " + (PayLinkStore.lastTap(this) ?: "none yet")
    }

    companion object {
        const val EXTRA_URL = "url"
    }
}
