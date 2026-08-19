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
    version = "0.5.3"

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

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
    }
}

project(":core") {
    apply(plugin = "java-library")

    dependencies {
        add("api", "org.springframework.boot:spring-boot-starter-data-jdbc")
        add("api", "org.springframework.boot:spring-boot-starter-validation")
        add("api", "org.springframework:spring-web")
        add("api", "org.jetbrains.kotlin:kotlin-reflect")
        add("api", "tools.jackson.module:jackson-module-kotlin")

        add("runtimeOnly", "org.postgresql:postgresql")

        add("testImplementation", "org.springframework.boot:spring-boot-starter-data-jdbc-test")
        add("testImplementation", "org.jetbrains.kotlin:kotlin-test-junit5")
        add("testImplementation", "org.testcontainers:testcontainers-junit-jupiter")
        add("testImplementation", "org.testcontainers:testcontainers-postgresql")
        add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher")
    }
}

project(":api") {
    apply(plugin = "org.springframework.boot")

    dependencies {
        add("implementation", project(":core"))
        add("implementation", "org.springframework.boot:spring-boot-starter-actuator")
        add("implementation", "org.springframework.boot:spring-boot-starter-data-jdbc")
        add("implementation", "org.springframework.boot:spring-boot-starter-oauth2-resource-server")
        add("implementation", "org.springframework.boot:spring-boot-starter-validation")
        add("implementation", "org.springframework.boot:spring-boot-starter-webmvc")
        add("implementation", "org.jetbrains.kotlin:kotlin-reflect")
        add("implementation", "tools.jackson.module:jackson-module-kotlin")

        add("runtimeOnly", "io.micrometer:micrometer-registry-prometheus")
        add("runtimeOnly", "org.postgresql:postgresql")

        add("testImplementation", "org.springframework.boot:spring-boot-starter-actuator-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-data-jdbc-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-security-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-validation-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-webmvc-test")
        add("testImplementation", "org.springframework.boot:spring-boot-testcontainers")
        add("testImplementation", "org.jetbrains.kotlin:kotlin-test-junit5")
        add("testImplementation", "org.testcontainers:testcontainers-junit-jupiter")
        add("testImplementation", "org.testcontainers:testcontainers-postgresql")
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

        add("runtimeOnly", "io.micrometer:micrometer-registry-prometheus")
        add("runtimeOnly", "org.postgresql:postgresql")

        add("testImplementation", "org.springframework.boot:spring-boot-starter-actuator-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-data-jdbc-test")
        add("testImplementation", "org.springframework.boot:spring-boot-starter-validation-test")
        add("testImplementation", "org.springframework.boot:spring-boot-testcontainers")
        add("testImplementation", "org.jetbrains.kotlin:kotlin-test-junit5")
        add("testImplementation", "org.testcontainers:testcontainers-junit-jupiter")
        add("testImplementation", "org.testcontainers:testcontainers-postgresql")
        add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher")
    }
}

tasks.register("check") {
    group = "verification"
    dependsOn(subprojects.map { "${it.path}:check" })
}
