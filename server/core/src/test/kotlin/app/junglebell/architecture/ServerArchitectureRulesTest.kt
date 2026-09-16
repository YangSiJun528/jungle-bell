package app.junglebell.architecture

import app.junglebell.architecture.fixtures.api.ApiUsingAccount
import app.junglebell.architecture.fixtures.api.ApiUsingWorker
import app.junglebell.architecture.fixtures.common.CommonUsingAccount
import app.junglebell.architecture.fixtures.common.CommonValue
import app.junglebell.architecture.fixtures.domain.account.AccountFeature
import app.junglebell.architecture.fixtures.domain.account.AccountUsingApi
import app.junglebell.architecture.fixtures.domain.account.AccountUsingJdbcStore
import app.junglebell.architecture.fixtures.domain.account.AccountUsingPublicData
import app.junglebell.architecture.fixtures.domain.account.JdbcAccountStore
import app.junglebell.architecture.fixtures.domain.account.StorePortConsumer
import app.junglebell.architecture.fixtures.domain.automation.AutomationFeature
import app.junglebell.architecture.fixtures.domain.notification.NotificationFeature
import app.junglebell.architecture.fixtures.domain.unregistered.NewFeature
import app.junglebell.architecture.fixtures.worker.WorkerUsingApi
import com.tngtech.archunit.core.importer.ClassFileImporter
import com.tngtech.archunit.lang.ArchRule
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertFailsWith

class ServerArchitectureRulesTest {
    private val rules = ServerArchitectureRules("app.junglebell.architecture.fixtures")

    @Test
    fun `declared dependencies and store ports are accepted`() {
        rules.moduleDependencies("core").check(importFixtures(AccountFeature::class.java))
        rules.featureDependencies("account").check(importFixtures(AccountFeature::class.java))
        rules.commonDoesNotDependOnDomain().check(importFixtures(CommonValue::class.java))
        rules.moduleDependencies("api").check(importFixtures(ApiUsingAccount::class.java))
        rules.storeImplementationsArePrivate().check(importFixtures(
            StorePortConsumer::class.java,
            JdbcAccountStore::class.java,
            JdbcAccountStore.Helper::class.java,
        ))
    }

    @Test
    fun `core cannot depend on an execution module`() {
        assertRejected(rules.moduleDependencies("core"), AccountUsingApi::class.java)
    }

    @Test
    fun `API cannot depend on worker`() {
        assertRejected(rules.moduleDependencies("api"), ApiUsingWorker::class.java)
    }

    @Test
    fun `worker cannot depend on API`() {
        assertRejected(rules.moduleDependencies("worker"), WorkerUsingApi::class.java)
    }

    @Test
    fun `foreign module packages are rejected even without a dependency`() {
        assertRejected(rules.modulePackages("core"), ApiUsingAccount::class.java)
        assertRejected(rules.modulePackages("api"), AccountFeature::class.java)
    }

    @Test
    fun `common cannot depend on a domain feature`() {
        assertRejected(rules.commonDoesNotDependOnDomain(), CommonUsingAccount::class.java)
    }

    @Test
    fun `undeclared cross feature dependencies are rejected`() {
        assertRejected(rules.featureDependencies("account"), AccountUsingPublicData::class.java)
    }

    @Test
    fun `new features require a dependency policy`() {
        assertRejected(rules.knownFeatures(), NewFeature::class.java)
    }

    @Test
    fun `feature cycles are rejected`() {
        assertRejected(rules.noFeatureCycles(), AutomationFeature::class.java, NotificationFeature::class.java)
    }

    @Test
    fun `services cannot depend on JDBC store implementations`() {
        assertRejected(rules.storeImplementationsArePrivate(), AccountUsingJdbcStore::class.java)
    }

    private fun assertRejected(rule: ArchRule, vararg classes: Class<*>) {
        val error = assertFailsWith<AssertionError> { rule.check(importFixtures(*classes)) }
        // A missing import or an empty rule must not count as detecting the intended violation.
        assertContains(error.message.orEmpty(), classes.first().simpleName)
    }

    private fun importFixtures(vararg classes: Class<*>) = ClassFileImporter().importClasses(*classes)
}
