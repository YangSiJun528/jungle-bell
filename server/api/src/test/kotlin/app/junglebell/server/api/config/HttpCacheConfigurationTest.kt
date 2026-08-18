package app.junglebell.server.api.config

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import org.hamcrest.Matchers.containsString
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpHeaders
import org.springframework.mock.web.MockServletContext
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext
import org.springframework.web.servlet.config.annotation.EnableWebMvc

class HttpCacheConfigurationTest {
    private lateinit var context: AnnotationConfigWebApplicationContext
    private lateinit var mockMvc: MockMvc

    @BeforeTest
    fun setUp() {
        context = AnnotationConfigWebApplicationContext().apply {
            servletContext = MockServletContext()
            register(
                TestWebConfiguration::class.java,
                HttpCacheConfiguration::class.java,
                WebManifestController::class.java,
            )
            refresh()
        }
        mockMvc = MockMvcBuilders.webAppContextSetup(context).build()
    }

    @AfterTest
    fun tearDown() {
        context.close()
    }

    @Test
    fun `versioned assets and images are cached for one day`() {
        val asset = mockMvc.perform(get("/assets/test.js"))
            .andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("max-age=86400")))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("public")))
            .andExpect(header().exists(HttpHeaders.LAST_MODIFIED))
            .andReturn()
        val lastModified = requireNotNull(asset.response.getHeader(HttpHeaders.LAST_MODIFIED))

        mockMvc.perform(get("/icons/test.svg"))
            .andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("max-age=86400")))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("public")))

        mockMvc.perform(
            get("/assets/test.js")
                .header(HttpHeaders.IF_MODIFIED_SINCE, lastModified),
        ).andExpect(status().isNotModified)
    }

    @Test
    fun `entry document and service worker are not stored`() {
        mockMvc.perform(get("/index.html"))
            .andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))

        mockMvc.perform(get("/sw.js"))
            .andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
    }

    @Test
    fun `web manifest is cached for one hour`() {
        mockMvc.perform(get("/manifest.webmanifest"))
            .andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CONTENT_TYPE, containsString("application/manifest+json")))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("max-age=3600")))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("public")))
    }

    @Configuration
    @EnableWebMvc
    class TestWebConfiguration
}
