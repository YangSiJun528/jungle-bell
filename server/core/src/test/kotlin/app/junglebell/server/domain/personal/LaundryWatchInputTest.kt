package app.junglebell.server.domain.personal

import kotlin.test.Test
import kotlin.test.assertFailsWith

class LaundryWatchInputTest {
    @Test
    fun `notification modes enforce their minute invariant`() {
        LaundryWatchInput(
            "워시타워_1", "washer", "session-1", "before-completion", 10,
        ).validate()
        LaundryWatchInput(
            "워시타워_1", "washer", "session-1", "estimated-completion", 0,
        ).validate()
        LaundryWatchInput(
            "워시타워_1", "dryer", "session-1", "confirmed-completion", 0,
        ).validate()

        assertFailsWith<IllegalArgumentException> {
            LaundryWatchInput(
                "워시타워_1", "washer", "session-1", "before-completion", 0,
            ).validate()
        }
        assertFailsWith<IllegalArgumentException> {
            LaundryWatchInput(
                "워시타워_1", "washer", "session-1", "estimated-completion", 10,
            ).validate()
        }
        assertFailsWith<IllegalArgumentException> {
            LaundryWatchInput(
                "워시타워_1", "washer", "session-1", "unknown", 0,
            ).validate()
        }
    }
}
