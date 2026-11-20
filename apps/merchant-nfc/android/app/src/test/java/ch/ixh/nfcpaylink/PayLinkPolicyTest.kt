package ch.ixh.nfcpaylink

import ch.ixh.nfcpaylink.PayLinkPolicy.Incoming
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLEncoder

class PayLinkPolicyTest {

    private val hosts = PayLinkPolicy.parseHosts("*.trycloudflare.com,localhost,app.zecca.example")

    private fun ok(url: String) = assertNull("should accept $url", PayLinkPolicy.check(url, hosts))
    private fun refused(url: String?) = assertNotNull("should refuse $url", PayLinkPolicy.check(url, hosts))
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    // ---- accepted links ----

    @Test fun `accepts https pay links on the allowed hosts`() {
        ok("https://abc-def-ghi.trycloudflare.com/pay/demo")
        ok("https://localhost/pay/pr_coffee")
        ok("https://app.zecca.example/pay/pr_1")
        ok("https://app.zecca.example/pay/pr_1?ref=table-4")
        ok("https://localhost:8443/pay/pr_1")
        ok("https://APP.Zecca.Example/pay/pr_1") // host names are case-insensitive
    }

    // ---- scheme ----

    @Test fun `refuses http`() {
        refused("http://app.zecca.example/pay/pr_1")
        refused("http://abc.trycloudflare.com/pay/demo")
        refused("http://localhost:3100/pay/pr_coffee")
    }

    @Test fun `refuses other schemes and uppercase schemes`() {
        refused("HTTP://app.zecca.example/pay/pr_1")
        refused("HTTPS://app.zecca.example/pay/pr_1")
        refused("Https://app.zecca.example/pay/pr_1")
        refused("ftp://app.zecca.example/pay/pr_1")
        refused("javascript:alert(1)//app.zecca.example/pay/x")
        refused("intent://app.zecca.example/pay/x#Intent;end")
        refused("//app.zecca.example/pay/pr_1")
        refused("app.zecca.example/pay/pr_1")
    }

    // ---- host ----

    @Test fun `refuses hosts not on the allowlist`() {
        refused("https://evil.com/pay/pr_1")
        refused("https://trycloudflare.com/pay/pr_1") // wildcard needs a subdomain
        refused("https://eviltrycloudflare.com/pay/pr_1")
        refused("https://app.zecca.example.evil.com/pay/pr_1")
        refused("https://evilapp.zecca.example/pay/pr_1")
        refused("https://app.zecca.example./pay/pr_1") // trailing dot
        refused("https://127.0.0.1/pay/pr_1")
        refused("https://[::1]/pay/pr_1")
        refused("https:///pay/pr_1")
    }

    @Test fun `refuses tricks that hide the real host`() {
        refused("https://evil.com@app.zecca.example/pay/pr_1")
        refused("https://app.zecca.example@evil.com/pay/pr_1")
        refused("https://user:pass@app.zecca.example/pay/pr_1")
        refused("https://app.zecca.example%40evil.com/pay/pr_1")
        refused("https://evil.com%2F@app.zecca.example/pay/pr_1")
        refused("https://evil.com\\@app.zecca.example/pay/pr_1")
        refused("https://evil.com\\app.zecca.example/pay/pr_1")
        refused("https://evil.com#@app.zecca.example/pay/pr_1")
        refused("https://evil.com?@app.zecca.example/pay/pr_1")
        refused("https://evil.com/app.zecca.example/pay/pr_1")
        refused("https://xn--pp-8cd.zecca.example/pay/pr_1")
        refused("https://аpp.zecca.example/pay/pr_1") // Cyrillic a
    }

    // ---- path ----

    @Test fun `refuses links that are not a pay page`() {
        refused("https://app.zecca.example")
        refused("https://app.zecca.example/")
        refused("https://app.zecca.example/admin")
        refused("https://app.zecca.example/pay")
        refused("https://app.zecca.example/pay/")
        refused("https://app.zecca.example/payx/pr_1")
        refused("https://app.zecca.example/PAY/pr_1")
        refused("https://app.zecca.example/x/pay/pr_1")
        refused("https://app.zecca.example/pay/pr_1/extra")
        refused("https://app.zecca.example/pay/../login")
        refused("https://app.zecca.example/pay/%2e%2e/login")
        refused("https://app.zecca.example/pay/%2E%2E%2Flogin")
        refused("https://app.zecca.example/pay//evil.com")
        refused("https://app.zecca.example/pay/pr%5F1")
    }

    // ---- characters and size ----

    @Test fun `refuses empty, spaces, control and non-ascii characters`() {
        refused(null)
        refused("")
        refused("   ")
        refused(" https://app.zecca.example/pay/pr_1")
        refused("https://app.zecca.example/pay/pr_1 ")
        refused("https://app.zecca.example/pay/pr_1\n")
        refused("https://app.zecca.example/pay/pr_1\u0000")
        refused("https://app.zecca.example/pay/pr_1?ref=café")
        refused("https://app.zecca.example/pay/pr_1‮")
    }

    @Test fun `refuses very long links`() {
        val base = "https://app.zecca.example/pay/pr_1?ref="
        ok(base + "z".repeat(PayLinkPolicy.MAX_URL_BYTES - base.length))
        refused(base + "z".repeat(PayLinkPolicy.MAX_URL_BYTES - base.length + 1))
        refused(base + "z".repeat(100_000))
        ok("https://app.zecca.example/pay/" + "a".repeat(80))
        refused("https://app.zecca.example/pay/" + "a".repeat(81))
    }

    @Test fun `accepted links are also valid for the NFC tag`() {
        val url = "https://app.zecca.example/pay/pr_1?ref=" + "z".repeat(300)
        ok(url)
        assertNull(NdefUri.checkUrl(url))
    }

    // ---- host allowlist configuration ----

    @Test fun `host list is trimmed, lowercased and drops unsafe wildcards`() {
        assertEquals(
            listOf("*.trycloudflare.com", "localhost", "pay.zecca.ch"),
            PayLinkPolicy.parseHosts(" *.TryCloudflare.com , LOCALHOST ,, pay.zecca.ch "),
        )
        assertEquals(emptyList<String>(), PayLinkPolicy.parseHosts("*, *., *.com, a.*.com, ev*il.com, .x.com, *.*.x.com"))
        assertEquals(emptyList<String>(), PayLinkPolicy.parseHosts(""))
    }

    @Test fun `an empty allowlist refuses everything`() {
        assertNotNull(PayLinkPolicy.check("https://app.zecca.example/pay/pr_1", emptyList()))
        assertNotNull(PayLinkPolicy.check("https://app.zecca.example/pay/pr_1", PayLinkPolicy.parseHosts("*")))
    }

    @Test fun `production host only refuses tunnel hosts`() {
        val prod = PayLinkPolicy.parseHosts("pay.zecca.ch")
        assertNull(PayLinkPolicy.check("https://pay.zecca.ch/pay/pr_1", prod))
        assertNotNull(PayLinkPolicy.check("https://abc.trycloudflare.com/pay/pr_1", prod))
    }

    @Test fun `built-in allowlist is usable`() {
        val built = PayLinkPolicy.configuredHosts
        assertTrue(built.isNotEmpty())
        assertFalse(built.any { it == "*" || it.startsWith("*.") && it.count { c -> c == '.' } < 2 })
    }

    @Test fun `no entry of the built-in allowlist is dropped`() {
        // parseHosts drops a bad entry at runtime; a bad -PzeccaNfcHosts must fail the build instead.
        val entries = BuildConfig.PAYLINK_HOSTS.split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        assertEquals(
            "zeccaNfcHosts entries the app would ignore: ${entries - built().toSet()} (host names only: no scheme, port, path or trailing dot)",
            entries,
            built(),
        )
    }

    private fun built() = PayLinkPolicy.configuredHosts

    // ---- incoming intents (Chrome intent: link with the url extra, or the deep link) ----

    @Test fun `launcher start without a link does nothing`() {
        assertEquals(Incoming.None, PayLinkPolicy.incoming(null, null, hosts))
    }

    @Test fun `url extra is accepted only when the policy passes`() {
        val good = "https://abc.trycloudflare.com/pay/pr_1"
        assertEquals(Incoming.Accepted(good), PayLinkPolicy.incoming(null, good, hosts))
        assertTrue(PayLinkPolicy.incoming(null, "http://abc.trycloudflare.com/pay/pr_1", hosts) is Incoming.Refused)
        assertTrue(PayLinkPolicy.incoming(null, "https://evil.com/pay/pr_1", hosts) is Incoming.Refused)
        assertTrue(PayLinkPolicy.incoming(null, "", hosts) is Incoming.Refused)
    }

    @Test fun `deep link is decoded and checked`() {
        val good = "https://abc.trycloudflare.com/pay/pr_1?ref=a%20b"
        assertEquals(
            Incoming.Accepted(good),
            PayLinkPolicy.incoming("zecca-nfc://emit?url=" + enc(good), null, hosts),
        )
        assertTrue(PayLinkPolicy.incoming("zecca-nfc://emit?url=" + enc("http://abc.trycloudflare.com/pay/pr_1"), null, hosts) is Incoming.Refused)
        assertTrue(PayLinkPolicy.incoming("zecca-nfc://emit?url=" + enc("https://evil.com/pay/pr_1"), null, hosts) is Incoming.Refused)
    }

    @Test fun `malformed deep links are refused`() {
        val good = enc("https://abc.trycloudflare.com/pay/pr_1")
        for (link in listOf(
            "zecca-nfc://emit",
            "zecca-nfc://emit?",
            "zecca-nfc://emit?url=",
            "zecca-nfc://emit?link=$good",
            "zecca-nfc://other?url=$good",
            "zecca-nfc://emit.evil.com?url=$good",
            "zecca-nfc://emit/x?url=$good",
            "ZECCA-NFC://emit?url=$good",
            "zecca-nfc://emit?url=$good&url=" + enc("https://evil.com/pay/pr_1"),
            "zecca-nfc://emit?url=" + enc(enc("https://abc.trycloudflare.com/pay/pr_1")), // double-encoded
            "zecca-nfc://emit?url=https://abc.trycloudflare.com/pay/pr_1+x",
            "zecca-nfc://emit?url=%E0%A4%A",
            "https://abc.trycloudflare.com/pay/pr_1",
            "content://ch.ixh.nfcpaylink/x",
        )) {
            assertTrue("should refuse $link", PayLinkPolicy.incoming(link, null, hosts) is Incoming.Refused)
        }
    }

    @Test fun `deep link wins over the url extra`() {
        val good = "https://abc.trycloudflare.com/pay/pr_1"
        assertEquals(
            Incoming.Accepted(good),
            PayLinkPolicy.incoming("zecca-nfc://emit?url=" + enc(good), "https://evil.com/pay/x", hosts),
        )
        assertTrue(PayLinkPolicy.incoming("zecca-nfc://emit", good, hosts) is Incoming.Refused)
    }

    @Test fun `refusal messages are plain English`() {
        val r = PayLinkPolicy.incoming(null, "http://abc.trycloudflare.com/pay/pr_1", hosts) as Incoming.Refused
        assertTrue(r.reason, r.reason.contains("https://"))
        val h = PayLinkPolicy.check("https://evil.com/pay/pr_1", hosts)!!
        assertTrue(h, h.contains("evil.com"))
    }
}
