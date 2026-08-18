package app.junglebell.server.domain.publicapi

import kotlin.test.Test
import kotlin.test.assertEquals

class LaundryRiskTest {
    @Test
    fun `risk thresholds include ten percent in safe and forty percent in slight`() {
        assertEquals(LaundryRisk(10, 1, 10.0, "safe"), LaundryRisk.calculate(10, 1))
        assertEquals(LaundryRisk(5, 2, 40.0, "slight"), LaundryRisk.calculate(5, 2))
        assertEquals(LaundryRisk(5, 3, 60.0, "caution"), LaundryRisk.calculate(5, 3))
        assertEquals("caution", LaundryRisk.calculate(4_999, 2_000).riskLevel)
    }

    @Test
    fun `rate preserves the formula and no attempts is safe`() {
        assertEquals(LaundryRisk(6, 1, 100.0 / 6, "slight"), LaundryRisk.calculate(6, 1))
        assertEquals(LaundryRisk(0, 0, 0.0, "safe"), LaundryRisk.calculate(0, 0))
    }
}
