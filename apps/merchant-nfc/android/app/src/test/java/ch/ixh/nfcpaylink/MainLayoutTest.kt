package ch.ixh.nfcpaylink

import org.junit.Assert.assertEquals
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** Checks on the merchant screen layout. */
class MainLayoutTest {

    private val ns = "http://schemas.android.com/apk/res/android"

    @Test fun `refusal line keeps its text when the screen is recreated`() {
        // A TextView saves its text across rotation only with freezesText; MainActivity shows the
        // line whenever it has text.
        val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(File("src/main/res/layout/activity_main.xml"))
        val all = doc.getElementsByTagName("*")
        val refused = (0 until all.length).map { all.item(it) as Element }
            .single { it.getAttributeNS(ns, "id") == "@+id/refused" }
        assertEquals("true", refused.getAttributeNS(ns, "freezesText"))
    }
}
