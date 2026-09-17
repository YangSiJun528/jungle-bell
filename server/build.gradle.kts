import io.spring.gradle.dependencymanagement.dsl.DependencyManagementExtension
import org.gradle.api.plugins.JavaPluginExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension
import org.springframework.boot.gradle.plugin.SpringBootPlugin

plugins {
    kotlin("jvm") version "2.3.21" apply false
    kotlin("plugin.spring") version "2.3.21" apply false
    id("org.springframework.boot") version "4.1.0" apply false
    id("io.spring.dependency-management") version "1.1.7" apply false
}

allprojects {
    group = "app.junglebell"
    version = "0.6.1"

    repositories {
        mavenCentral()
    }
}

subprojects {
    apply(plugin = "org.jetbrains.kotlin.jvm")
    apply(plugin = "org.jetbrains.kotlin.plugin.spring")
    apply(plugin = "io.spring.dependency-management")

    extensions.configure<DependencyManagementExtension> {
        imports {
            mavenBom(SpringBootPlugin.BOM_COORDINATES)
        }
    }

    extensions.configure<JavaPluginExtension> {
        toolchain {
            languageVersion = JavaLanguageVersion.of(21)
        }
    }

    extensions.configure<KotlinJvmProjectExtension> {
        compilerOptions {
            freeCompilerArgs.addAll("-Xjsr305=strict", "-Xannotation-default-target=param-property")
        }
    }

    val sourceSets = extensions.getByType<SourceSetContainer>()
    val main = sourceSets["main"]
    val integrationTestSourceSet = sourceSets.create("integrationTest") {
        compileClasspath += main.output
        runtimeClasspath += main.output
    }
    configurations[integrationTestSourceSet.implementationConfigurationName]
        .extendsFrom(configurations["testImplementation"])
    configurations[integrationTestSourceSet.runtimeOnlyConfigurationName]
        .extendsFrom(configurations["testRuntimeOnly"])

    val mainClasses = main.output.classesDirs
    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        systemProperty("junglebell.architecture.classes", mainClasses.asPath)
    }
    tasks.named<Test>("test") {
        description = "Runs unit and architecture tests without Docker."
    }

    val integrationTest = tasks.register<Test>("integrationTest") {
        description = "Runs integration tests against PostgreSQL in Docker."
        group = "verification"
        testClassesDirs = integrationTestSourceSet.output.classesDirs
        classpath = integrationTestSourceSet.runtimeClasspath
        shouldRunAfter(tasks.named("test"))
        outputs.upToDateWhen { false }
        outputs.doNotCacheIf("Integration tests must verify the current Docker environment") { true }
    }
    tasks.named("check") {
        dependsOn(integrationTest)
    }
}

project(":core") {
    apply(plugin = "java-library")
    apply(plugin = "java-test-fixtures")

    dependencies {
        add("api", "org.springframework.boot:spring-boot-starter-data-jdbc")
        add("api", "org.springframework.boot:spring-boot-starter-validation")
        add("api", "org.springframework:spring-web")
        add("api", "org.jetbrains.kotlin:kotlin-reflect")
        add("api", "tools.jackson.module:jackson-module-kotlin")

        add("runtimeOnly", "org.postgresql:postgresql")

        add("testImplementation", "org.springframework.boot:spring-boot-starter-data-jdbc-test")
        add("testImplementation", "org.jetbrains.kotlin:kotlin-test-junit5")
        add("integrationTestImplementation", "org.testcontainers:testcontainers-junit-jupiter")
        add("integrationTestImplementation", "org.testcontainers:testcontainers-postgresql")
        add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher")
        add("testFixturesApi", "com.tngtech.archunit:archunit:1.5.0")
    }
}

project(":api") {
    apply(plugin = "org.springframework.boot")

    // Both HTTP unit tests and the full security-chain tests use the same static fixtures.
    extensions.getByType<SourceSetContainer>()["integrationTest"].resources.srcDir("src/test/resources")

    dependencies {
        add("implementation", project(":core"))
        add("implementation", "org.springframework.boot:spring-boot-starter-actuator")
        add("implementation", "org.springframework.boot:spring-boot-starter-data-jdbc")
        add("implementation", "org.springframework.boot:spring-boot-starter-oauth2-resource-server")
        add("implementation", "org.springframework.boot:spring-boot-starter-validation")
        add("implementation", "org.springframework.boot:spring-boot-starter-webmvc")
        add("implementation", "org.jetbrains.kotlin:kotlin-reflect")
        add("implementation", "tools.jackson.module:jackson-module-kotlin")

        add("runtimeOnly", "org.postgresql:postgresql")

        add("testImplementation", "org.springframework.boot:spring-boot-starter-actuator-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-data-jdbc-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-security-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-validation-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-webmvc-test")
        add("integrationTestImplementation", "org.springframework.boot:spring-boot-testcontainers")
        add("testImplementation", testFixtures(project(":core")))
        add("testImplementation", "org.jetbrains.kotlin:kotlin-test-junit5")
        add("integrationTestImplementation", "org.testcontainers:testcontainers-junit-jupiter")
        add("integrationTestImplementation", "org.testcontainers:testcontainers-postgresql")
        add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher")
    }
}

project(":worker") {
    apply(plugin = "org.springframework.boot")

    dependencies {
        add("implementation", project(":core"))
        add("implementation", "org.springframework.boot:spring-boot-starter-actuator")
        add("implementation", "org.springframework.boot:spring-boot-starter-data-jdbc")
        add("implementation", "org.springframework.boot:spring-boot-starter-json")
        add("implementation", "org.springframework.boot:spring-boot-starter-validation")
        add("implementation", "org.springframework:spring-web")
        add("implementation", "org.jetbrains.kotlin:kotlin-reflect")
        add("implementation", "tools.jackson.module:jackson-module-kotlin")
        add("implementation", "nl.martijndwars:web-push:5.1.2")
        add("implementation", "org.bouncycastle:bcprov-jdk18on:1.85.2")
        add("implementation", "org.apache.httpcomponents:httpasyncclient:4.1.5")

        add("runtimeOnly", "org.postgresql:postgresql")

        add("testImplementation", "org.springframework.boot:spring-boot-starter-actuator-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-data-jdbc-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-validation-test")
        add("testImplementation", testFixtures(project(":core")))
        add("testImplementation", "org.jetbrains.kotlin:kotlin-test-junit5")
        add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher")
    }
}

tasks.register("check") {
    description = "Runs unit, architecture, and Docker integration tests."
    group = "verification"
    dependsOn(subprojects.map { "${it.path}:check" })
}
