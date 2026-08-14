package app.junglebell.server.api

import kotlin.test.Test
import kotlin.test.assertFailsWith

class ApiModuleBoundaryTest {
    @Test
    fun `API runtime does not contain worker invocation classes`() {
        assertFailsWith<ClassNotFoundException> {
            Class.forName("app.junglebell.server.worker.collector.CollectorScheduler")
        }
    }
}
