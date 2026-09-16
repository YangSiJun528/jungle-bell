package app.junglebell.server.api

import app.junglebell.architecture.ServerArchitectureRules
import kotlin.test.Test

class ApiArchitectureTest {
    @Test
    fun `API respects module dependencies and store ports`() {
        val rules = ServerArchitectureRules()
        val classes = rules.productionClasses()
        rules.executionModuleRules("api").forEach { it.check(classes) }
    }
}
