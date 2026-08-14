package app.junglebell.server.domain.publicapi

import java.time.Instant

interface PublicDataStore {
    fun sourceStates(): List<SourceState>
    fun sourceState(source: String): SourceState?
    fun latestLaundryVersion(): LaundryVersion?
    fun laundryVersion(sha: String): LaundryVersion?
    fun observation(minuteEpoch: Long): MinuteObservation?
    fun laundryEvents(since: Instant?, limit: Int): List<LaundryEvent>
    fun mealImage(postId: String, mediaId: String): StoredMealImage?
    fun mealPosts(limit: Int = 100): List<MealPost>
    fun mealPostsForMonth(from: Instant, to: Instant): List<MealPost>
    fun weeklyMenus(limit: Int = 100): List<WeeklyMealMenu>
    fun asset(sha: String): StoredAsset?
    fun recordLaundrySuccess(version: LaundryVersion, firstSeenAt: Instant, observation: MinuteObservation)
    fun recordLaundryFailure(observedAt: Instant, observation: MinuteObservation, error: String)
    fun recordMealCollection(source: String, sha: String, observedAt: Instant, posts: List<StoredMealPublication>)
    fun recordMealFailure(source: String, observedAt: Instant, error: String)
}

data class StoredMealPublication(
    val post: MealPost,
    val images: List<StoredMealImage>,
    val weekKey: String?,
)

data class StoredMealImage(
    val mediaId: String,
    val sourceUrl: String,
    val declaredContentType: String?,
    val filename: String?,
    val width: Int?,
    val height: Int?,
    val sha: String,
    val contentType: String,
    val extension: String,
    val content: ByteArray,
)
