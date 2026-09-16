package app.junglebell.server.worker

import app.junglebell.architecture.ServerArchitectureRules
import kotlin.test.Test

class WorkerArchitectureTest {
    @Test
    fun `worker respects module dependencies and store ports`() {
        val rules = ServerArchitectureRules()
        val classes = rules.productionClasses()
        rules.executionModuleRules("worker").forEach { it.check(classes) }
    }
}
