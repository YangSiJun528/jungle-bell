package app.junglebell.server.api.security

import app.junglebell.server.api.common.ApiErrorResponse
import app.junglebell.server.api.logging.AuthenticatedUserMdcFilter
import app.junglebell.server.api.logging.REQUEST_ID_HEADER
import app.junglebell.server.common.config.JungleBellProperties
import jakarta.servlet.http.HttpServletResponse
import java.nio.charset.StandardCharsets
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.MediaType
import org.springframework.http.HttpMethod
import org.slf4j.LoggerFactory
import org.springframework.security.config.Customizer.withDefaults
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.core.OAuth2AuthenticatedPrincipal
import org.springframework.security.oauth2.server.resource.introspection.OpaqueTokenIntrospector
import org.springframework.security.oauth2.server.resource.web.BearerTokenResolver
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter
import org.springframework.security.web.AuthenticationEntryPoint
import org.springframework.security.web.SecurityFilterChain
import org.springframework.security.web.access.AccessDeniedHandler
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.CorsConfigurationSource
import org.springframework.web.cors.UrlBasedCorsConfigurationSource
import tools.jackson.databind.ObjectMapper

@Configuration
class SecurityConfig {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Bean
    fun personalApiAuthorization(properties: JungleBellProperties) =
        PersonalApiAuthorizationManager(properties, allowMobile = true)

    @Bean
    fun desktopUiAuthorization(properties: JungleBellProperties) =
        PersonalApiAuthorizationManager(properties, allowMobile = false)

    @Bean
    fun securityFilterChain(
        http: HttpSecurity,
        bearerTokenResolver: BearerTokenResolver,
        opaqueTokenIntrospector: OpaqueTokenIntrospector,
        @Qualifier("personalApiAuthorization")
        personalApiAuthorization: PersonalApiAuthorizationManager,
        @Qualifier("desktopUiAuthorization")
        desktopUiAuthorization: PersonalApiAuthorizationManager,
        authenticationEntryPoint: AuthenticationEntryPoint,
        accessDeniedHandler: AccessDeniedHandler,
    ): SecurityFilterChain =
        http
            .csrf { it.disable() }
            .cors(withDefaults())
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .authorizeHttpRequests {
                it.requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                    .requestMatchers(HttpMethod.POST, "/api/desktop/installations").permitAll()
                    .requestMatchers("/api/desktop/**").hasRole("DESKTOP")
                    .requestMatchers(
                        "/api/me/mobile-sessions",
                        "/api/me/mobile-sessions/**",
                        "/api/me/pairings",
                        "/api/me/pairings/**",
                    ).access(desktopUiAuthorization)
                    .requestMatchers("/api/me/**").access(personalApiAuthorization)
                    .anyRequest().permitAll()
            }
            .oauth2ResourceServer {
                it.bearerTokenResolver(bearerTokenResolver)
                    .authenticationEntryPoint(authenticationEntryPoint)
                    .accessDeniedHandler(accessDeniedHandler)
                    .opaqueToken { opaque ->
                        opaque.introspector(opaqueTokenIntrospector)
                    }
            }
            .addFilterAfter(AuthenticatedUserMdcFilter(), BearerTokenAuthenticationFilter::class.java)
            .build()

    @Bean
    fun authenticationEntryPoint(objectMapper: ObjectMapper): AuthenticationEntryPoint =
        AuthenticationEntryPoint { request, response, _ ->
            logger.warn(
                "HTTP request authentication rejected. method={} status=401 errorCode=AUTHENTICATION_REQUIRED",
                request.method,
            )
            writeError(response, objectMapper, 401, "AUTHENTICATION_REQUIRED")
        }

    @Bean
    fun accessDeniedHandler(
        objectMapper: ObjectMapper,
        properties: JungleBellProperties,
    ): AccessDeniedHandler = AccessDeniedHandler { request, response, _ ->
        val authentication = SecurityContextHolder.getContext().authentication
        val desktopUiOrigin =
            (authentication?.principal as? OAuth2AuthenticatedPrincipal)?.getAttribute<String>("origin")
        val code = when {
            desktopUiOrigin != null && request.requestURI.startsWith("/api/me/") &&
                (request.getHeader("Origin") != desktopUiOrigin ||
                    request.getHeader("Origin") !in properties.allowedDesktopOrigins) -> "ORIGIN_NOT_ALLOWED"
            authentication?.authorities?.any { it.authority == MOBILE_AUTHORITY } == true &&
                requiresDesktopUi(request.requestURI) -> "DESKTOP_CAPABILITY_REQUIRED"
            else -> "SESSION_KIND_DENIED"
        }
        logger.warn(
            "HTTP request authorization rejected. method={} status=403 errorCode={}",
            request.method,
            code,
        )
        writeError(response, objectMapper, 403, code)
    }

    @Bean
    fun corsConfigurationSource(properties: JungleBellProperties): CorsConfigurationSource {
        val source = UrlBasedCorsConfigurationSource()
        val personalApi = CorsConfiguration().apply {
            allowedOrigins = properties.allowedDesktopOrigins.toList()
            allowedMethods = listOf("GET", "POST", "PUT", "DELETE", "OPTIONS")
            allowedHeaders = listOf("Authorization", "Content-Type", "Accept", "Cache-Control", REQUEST_ID_HEADER)
            exposedHeaders = listOf("Cache-Control", "Location", REQUEST_ID_HEADER)
            allowCredentials = false
            maxAge = 600
        }
        val publicApi = CorsConfiguration().apply {
            allowedOrigins = properties.allowedDesktopOrigins.toList()
            allowedMethods = listOf("GET", "HEAD", "OPTIONS")
            allowedHeaders = listOf("Accept", "Cache-Control", REQUEST_ID_HEADER)
            exposedHeaders = listOf("Cache-Control", REQUEST_ID_HEADER)
            allowCredentials = false
            maxAge = 600
        }
        source.registerCorsConfiguration("/api/me/**", personalApi)
        source.registerCorsConfiguration("/api/public/**", publicApi)
        return source
    }

    private fun requiresDesktopUi(path: String): Boolean =
        path == "/api/me/mobile-sessions" || path.startsWith("/api/me/mobile-sessions/") ||
            path == "/api/me/pairings" || path.startsWith("/api/me/pairings/")

    private fun writeError(
        response: HttpServletResponse,
        objectMapper: ObjectMapper,
        status: Int,
        code: String,
    ) {
        response.status = status
        response.characterEncoding = StandardCharsets.UTF_8.name()
        response.contentType = MediaType.APPLICATION_JSON_VALUE
        objectMapper.writeValue(response.outputStream, ApiErrorResponse(code))
    }
}
