package app.junglebell.server.domain.publicapi

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WeeklyMealMenuMappingTest {
    private val post = MealPost(
        id = "pinned-menu",
        kind = "PINNED_MENU",
        contentSha = "b".repeat(64),
        title = "이번 주 식단",
        text = "",
        pinned = true,
        publishedAt = null,
        updatedAt = null,
        permalink = null,
        status = "published",
        images = emptyList(),
    )

    @Test
    fun `현재 post와 SHA가 같은 주간 식단만 응답한다`() {
        assertEquals(
            WeeklyMealMenu("2026-08-17", post.contentSha, post),
            matchingWeeklyMenu("2026-08-17", post.contentSha, post),
        )
        assertNull(matchingWeeklyMenu("2026-08-10", "a".repeat(64), post))
        assertNull(matchingWeeklyMenu("2026-08-10", post.contentSha, null))
    }
}
