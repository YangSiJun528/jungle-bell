package app.junglebell.server.domain.publicapi

import java.net.URI
import kotlin.test.Test
import kotlin.test.assertEquals

class MealAssetUrlsTest {
    @Test
    fun `stored paths are exposed as canonical public asset urls`() {
        val post = MealPost(
            id = "meal-1",
            kind = "DAILY_MENU",
            contentSha = "a".repeat(64),
            title = "중식",
            text = "밥",
            pinned = false,
            publishedAt = null,
            updatedAt = null,
            permalink = null,
            status = "published",
            images = listOf(
                MealImage(
                    postId = "meal-1",
                    mediaId = "media-1",
                    sourceUrl = "https://source.example/image.jpg",
                    declaredContentType = "image/jpeg",
                    filename = "image.jpg",
                    width = 1_600,
                    height = 1_200,
                    sha = "b".repeat(64),
                    url = "/untrusted/stored/path.jpg",
                    contentType = "image/jpeg",
                    extension = "jpg",
                    byteLength = 120_000,
                ),
            ),
        )

        val resolved = post.withPublicAssetUrls(URI("https://api.example.com/base/"))

        assertEquals(
            "https://api.example.com/api/public/assets/${"b".repeat(64)}.jpg",
            resolved.images.single().url,
        )
    }
}
