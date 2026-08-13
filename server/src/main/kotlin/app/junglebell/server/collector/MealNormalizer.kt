package app.junglebell.server.collector

import app.junglebell.server.publicapi.MealImage
import app.junglebell.server.publicapi.MealPost
import app.junglebell.server.publicapi.PublicDataRepository
import app.junglebell.server.publicapi.StoredMealImage
import tools.jackson.databind.JsonNode
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import java.net.URI
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.math.abs

@Component
class MealNormalizer(
    private val restClient: RestClient,
    private val repository: PublicDataRepository,
) {
    private val weekPattern = Regex("(?:(\\d{4})년\\s*)?(\\d{1,2})월\\s*(\\d{1,2})주차")
    private val safeTypes = mapOf(
        "image/avif" to "avif",
        "image/gif" to "gif",
        "image/jpeg" to "jpg",
        "image/png" to "png",
        "image/webp" to "webp",
    )

    fun normalize(root: JsonNode, observedAt: Instant): List<NormalizedMealPost> {
        val items = root.path("items")
        require(items.isArray) { "Meal response items must be an array" }
        return items.toList().map { raw -> normalizePost(raw, observedAt) }
    }

    private fun normalizePost(raw: JsonNode, observedAt: Instant): NormalizedMealPost {
        val id = raw.path("id").asString()
        require(id.isNotBlank())
        val pinned = raw.path("pinned").asBoolean(false)
        val title = raw.get("title")?.takeUnless(JsonNode::isNull)?.asString()
        val text = raw.path("contents").takeIf(JsonNode::isArray)?.mapNotNull { content ->
            content.takeIf { it.path("t").asString() == "text" }?.path("v")?.asString()
        }?.joinToString("\n").orEmpty()
        val images = raw.path("media").takeIf(JsonNode::isArray)?.mapIndexedNotNull { index, media ->
            normalizeImage(id, index, media)
        }.orEmpty()
        val publishedAt = epochMillis(raw.get("published_at"))
        val updatedAt = epochMillis(raw.get("updated_at"))
        val kind = when {
            pinned -> "PINNED_MENU"
            title?.contains(Regex("(중식|석식)\\s*메[뉴누]")) == true -> "DAILY_MENU"
            else -> "OTHER"
        }
        val contentSha = sha256(buildString {
            append(title.orEmpty()).append('\u0000').append(text)
            images.forEach { append('\u0000').append(it.sha) }
        })
        val publicImages = images.map { image ->
            MealImage(
                id, image.mediaId, image.sourceUrl, image.declaredContentType, image.filename,
                image.width, image.height, image.sha,
                "/api/public/assets/${image.sha}.${image.extension}",
                image.contentType, image.extension, image.content.size.toLong(),
            )
        }
        val post = MealPost(
            id, kind, contentSha, title, text, pinned, publishedAt?.toString(), updatedAt?.toString(),
            raw.get("permalink")?.takeUnless(JsonNode::isNull)?.asString(),
            raw.get("status")?.takeUnless(JsonNode::isNull)?.asString(), publicImages,
        )
        return NormalizedMealPost(post, images, sourceWeekKey(title, updatedAt ?: observedAt))
    }

    private fun normalizeImage(postId: String, position: Int, media: JsonNode): StoredMealImage? {
        if (media.get("type")?.asString()?.let { it != "image" } == true) return null
        val mediaId = media.path("id").asString()
        val sourceUrl = (media.get("xlarge_url") ?: media.get("url"))?.asString()?.replace("http://", "https://")
            ?: return null
        repository.mealImage(postId, mediaId)?.takeIf { it.sourceUrl == sourceUrl }?.let { return it }
        val response = restClient.get().uri(URI.create(sourceUrl)).retrieve().toEntity(ByteArray::class.java)
        val bytes = response.body ?: error("Empty meal image")
        require(bytes.size <= MAX_IMAGE_BYTES) { "Meal image is too large" }
        val contentType = response.headers.contentType?.toString()?.substringBefore(';')
            ?: media.get("mimetype")?.asString()
            ?: error("Meal image content type missing")
        val extension = safeTypes[contentType.lowercase()]
            ?: error("Unsupported meal image content type: $contentType")
        return StoredMealImage(
            mediaId,
            sourceUrl,
            media.get("mimetype")?.asString(),
            media.get("filename")?.asString(),
            media.get("width")?.asInt(),
            media.get("height")?.asInt(),
            sha256(bytes),
            contentType,
            extension,
            bytes,
        )
    }

    fun sourceWeekKey(title: String?, reference: Instant): String? {
        val match = title?.let(weekPattern::find) ?: return null
        val explicitYear = match.groupValues[1].takeIf(String::isNotEmpty)?.toInt()
        val month = match.groupValues[2].toInt()
        val week = match.groupValues[3].toInt()
        if (month !in 1..12 || week !in 1..6) return null
        val referenceYear = reference.atZone(ZoneId.of("Asia/Seoul")).year
        val years = explicitYear?.let(::listOf) ?: listOf(referenceYear, referenceYear - 1, referenceYear + 1)
        return years.map { sourceWeekStart(it, month, week) }
            .minBy { abs(it.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() - reference.toEpochMilli()) }
            .toString()
    }

    private fun sourceWeekStart(year: Int, month: Int, week: Int): LocalDate {
        val first = YearMonth.of(year, month).atDay(1)
        val daysUntilMonday = (DayOfWeek.MONDAY.value - first.dayOfWeek.value + 7) % 7
        return first.plusDays((daysUntilMonday + (week - 1) * 7).toLong())
    }

    private fun epochMillis(node: JsonNode?): Instant? = node?.takeUnless(JsonNode::isNull)
        ?.asLong()?.takeIf { it > 0 }?.let(Instant::ofEpochMilli)

    companion object {
        private const val MAX_IMAGE_BYTES = 10 * 1024 * 1024
    }
}

data class NormalizedMealPost(
    val post: MealPost,
    val images: List<StoredMealImage>,
    val weekKey: String?,
)
