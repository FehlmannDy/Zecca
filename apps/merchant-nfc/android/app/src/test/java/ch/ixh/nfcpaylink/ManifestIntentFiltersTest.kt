package ch.ixh.nfcpaylink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** Checks that MainActivity can be opened from Chrome (intent: link) and by the zecca-nfc:// deep link. */
class ManifestIntentFiltersTest {

    private val ns = "http://schemas.android.com/apk/res/android"

    private data class Filter(val actions: Set<String>, val categories: Set<String>, val data: List<Pair<String, String>>)

    private fun mainActivityFilters(): List<Filter> {
        val f = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val doc = f.newDocumentBuilder().parse(File("src/main/AndroidManifest.xml"))
        val activities = doc.getElementsByTagName("activity")
        val main = (0 until activities.length).map { activities.item(it) as Element }
            .single { it.getAttributeNS(ns, "name") == ".MainActivity" }
        val filters = main.getElementsByTagName("intent-filter")
        return (0 until filters.length).map { i ->
            val el = filters.item(i) as Element
            fun names(tag: String): List<Element> {
                val l = el.getElementsByTagName(tag)
                return (0 until l.length).map { l.item(it) as Element }
            }
            Filter(
                names("action").map { it.getAttributeNS(ns, "name") }.toSet(),
                names("category").map { it.getAttributeNS(ns, "name") }.toSet(),
                names("data").map { it.getAttributeNS(ns, "scheme") to it.getAttributeNS(ns, "host") },
            )
        }
    }

    private val view = "android.intent.action.VIEW"
    private val browsable = setOf("android.intent.category.DEFAULT", "android.intent.category.BROWSABLE")

    @Test fun `chrome intent link without data reaches MainActivity`() {
        // Chrome adds CATEGORY_BROWSABLE to intent: links; the link carries no data, only S.url.
        val f = mainActivityFilters().filter { it.actions == setOf(view) && it.data.isEmpty() }
        assertEquals(1, f.size)
        assertTrue(f[0].categories.containsAll(browsable))
    }

    @Test fun `zecca-nfc emit deep link reaches MainActivity`() {
        val f = mainActivityFilters().filter { it.actions == setOf(view) && it.data.isNotEmpty() }
        assertEquals(1, f.size)
        assertEquals(listOf("zecca-nfc" to "emit"), f[0].data)
        assertTrue(f[0].categories.containsAll(browsable))
    }

    @Test fun `launcher entry is kept`() {
        assertTrue(mainActivityFilters().any {
            it.actions == setOf("android.intent.action.MAIN") && "android.intent.category.LAUNCHER" in it.categories
        })
    }
}
