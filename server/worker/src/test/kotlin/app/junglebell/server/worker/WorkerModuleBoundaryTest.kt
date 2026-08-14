package app.junglebell.server.worker

import kotlin.test.Test
import kotlin.test.assertFailsWith

class WorkerModuleBoundaryTest {
    @Test
    fun `Worker runtime does not contain API controllers`() {
        assertFailsWith<ClassNotFoundException> {
            Class.forName("app.junglebell.server.api.account.AccountController")
        }
    }
}
