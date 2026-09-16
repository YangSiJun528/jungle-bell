package app.junglebell.server

import app.junglebell.architecture.ServerArchitectureRules
import kotlin.test.Test

class CoreArchitectureTest {
    @Test
    fun `core respects module and feature dependencies`() {
        val rules = ServerArchitectureRules()
        val classes = rules.productionClasses()
        rules.coreRules().forEach { it.check(classes) }
    }
}
