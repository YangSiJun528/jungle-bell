package app.junglebell.server.security

import app.junglebell.server.config.JungleBellProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpMethod
import org.springframework.security.config.Customizer.withDefaults
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.core.userdetails.UserDetailsService
import org.springframework.security.core.userdetails.UsernameNotFoundException
import org.springframework.security.web.SecurityFilterChain
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.CorsConfigurationSource
import org.springframework.web.cors.UrlBasedCorsConfigurationSource

@Configuration
class SecurityConfig {
    @Bean
    fun userDetailsService(): UserDetailsService = UserDetailsService {
        throw UsernameNotFoundException("Password authentication is disabled")
    }

    @Bean
    fun securityFilterChain(http: HttpSecurity, authenticationFilter: ApiAuthenticationFilter): SecurityFilterChain =
        http
            .csrf { it.disable() }
            .cors(withDefaults())
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .authorizeHttpRequests { it.anyRequest().permitAll() }
            .addFilterBefore(authenticationFilter, AnonymousAuthenticationFilter::class.java)
            .build()

    @Bean
    fun corsConfigurationSource(properties: JungleBellProperties): CorsConfigurationSource {
        val source = UrlBasedCorsConfigurationSource()
        val configuration = CorsConfiguration().apply {
            allowedOrigins = properties.allowedDesktopOrigins.toList()
            allowedMethods = listOf("GET", "POST", "PUT", "DELETE", "OPTIONS")
            allowedHeaders = listOf("Authorization", "Content-Type", "Accept", "Cache-Control")
            exposedHeaders = listOf("Cache-Control", "Location")
            allowCredentials = false
            maxAge = 600
        }
        source.registerCorsConfiguration("/api/desktop-ui/**", configuration)
        return source
    }
}
