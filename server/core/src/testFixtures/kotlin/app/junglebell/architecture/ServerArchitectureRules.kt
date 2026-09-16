package app.junglebell.architecture

import com.tngtech.archunit.base.DescribedPredicate
import com.tngtech.archunit.core.domain.JavaClass
import com.tngtech.archunit.core.domain.JavaClasses
import com.tngtech.archunit.core.importer.ClassFileImporter
import com.tngtech.archunit.lang.ArchCondition
import com.tngtech.archunit.lang.ArchRule
import com.tngtech.archunit.lang.ConditionEvents
import com.tngtech.archunit.lang.SimpleConditionEvent
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses
import com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices
import java.io.File

/** Shared by all three module test suites; production code never depends on this fixture. */
class ServerArchitectureRules(private val root: String = "app.junglebell.server") {
    private val featureDependencies = mapOf(
        "account" to setOf("security"),
        "automation" to setOf("notification", "publicapi"),
        "notification" to setOf("security"),
        "pairing" to setOf("security"),
        "personal" to setOf("security"),
        "publicapi" to emptySet(),
        "security" to emptySet(),
        "usage" to setOf("security"),
    )

    fun productionClasses(): JavaClasses {
        val classpath = requireNotNull(System.getProperty("junglebell.architecture.classes")) {
            "Run architecture tests through Gradle so only this module's main classes are imported"
        }
        return ClassFileImporter().importPaths(*classpath.split(File.pathSeparator).toTypedArray())
    }

    fun modulePackages(module: String): ArchRule = classes()
        .should().resideInAnyPackage(*ownedPackagesFor(module))
        .because("each Gradle module must keep its own package boundary")

    fun moduleDependencies(module: String): ArchRule = classes()
        .that().resideInAnyPackage(*ownedPackagesFor(module))
        .should().onlyDependOnClassesThat(allowedDependencies(modulePackagesFor(module)))
        .because("the only server project dependencies are api -> core <- worker")

    fun commonDoesNotDependOnDomain(): ArchRule = noClasses()
        .that().resideInAPackage("$root.common..")
        .should().dependOnClassesThat().resideInAPackage("$root.domain..")

    fun knownFeatures(): ArchRule = classes()
        .that().resideInAPackage("$root.domain..")
        .should().resideInAnyPackage(*featureDependencies.keys.map { "$root.domain.$it.." }.toTypedArray())
        .because("new domain features must declare their dependency policy")

    fun featureDependencies(feature: String): ArchRule {
        val dependencies = featureDependencies.getValue(feature) + feature
        return classes().that().resideInAPackage("$root.domain.$feature..")
            .should().onlyDependOnClassesThat(allowedDependencies(
                arrayOf("$root.common..", *dependencies.map { "$root.domain.$it.." }.toTypedArray()),
            ))
            .because("domain features may only use their declared dependencies")
    }

    fun noFeatureCycles(): ArchRule = slices()
        .matching("$root.domain.(*)..")
        .should().beFreeOfCycles()

    fun storeImplementationsArePrivate(): ArchRule = classes().should(
        object : ArchCondition<JavaClass>("depend on Store ports instead of Jdbc*Store implementations") {
            override fun check(item: JavaClass, events: ConditionEvents) {
                item.directDependenciesFromSelf.forEach { dependency ->
                    val target = dependency.targetClass
                    val targetOwner = target.name.substringBefore('$')
                    val targetName = targetOwner.substringAfterLast('.')
                    if (target.packageName.startsWith("$root.domain.") &&
                        targetName.startsWith("Jdbc") && targetName.endsWith("Store") &&
                        item.name.substringBefore('$') != targetOwner
                    ) {
                        events.add(SimpleConditionEvent.violated(item, dependency.description))
                    }
                }
            }
        },
    )

    fun coreRules(): List<ArchRule> = listOf(
        modulePackages("core"),
        moduleDependencies("core"),
        commonDoesNotDependOnDomain(),
        knownFeatures(),
        noFeatureCycles(),
        storeImplementationsArePrivate(),
    ) + featureDependencies.keys.map(::featureDependencies)

    fun executionModuleRules(module: String): List<ArchRule> = listOf(
        modulePackages(module),
        moduleDependencies(module),
        storeImplementationsArePrivate(),
    )

    private fun modulePackagesFor(module: String): Array<String> {
        require(module in setOf("core", "api", "worker")) { "Unknown server module: $module" }
        return if (module == "core") {
            arrayOf("$root.common..", "$root.domain..")
        } else {
            arrayOf("$root.common..", "$root.domain..", "$root.$module..")
        }
    }

    private fun ownedPackagesFor(module: String): Array<String> = if (module == "core") {
        modulePackagesFor(module)
    } else {
        require(module in setOf("api", "worker")) { "Unknown server module: $module" }
        arrayOf("$root.$module..")
    }

    private fun allowedDependencies(packages: Array<String>): DescribedPredicate<JavaClass> =
        JavaClass.Predicates.resideOutsideOfPackage("$root..")
            .or(JavaClass.Predicates.resideInAnyPackage(*packages))
}
