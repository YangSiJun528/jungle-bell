package app.junglebell.server.publicapi

import tools.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.sql.Timestamp
import java.time.Instant
import java.util.UUID

@Repository
class PublicDataRepository(
    private val jdbc: JdbcClient,
    private val objectMapper: ObjectMapper,
) {
    fun sourceStates(): List<SourceState> = jdbc.sql(
        "SELECT * FROM source_state ORDER BY source",
    ).query { row, _ ->
        SourceState(
            row.getString("source"),
            row.getTimestamp("last_attempt_at").toInstant().toString(),
            row.getTimestamp("last_success_at")?.toInstant()?.toString(),
            row.getString("last_response_sha"),
            row.getTimestamp("version_first_seen_at")?.toInstant()?.toString(),
            row.getInt("consecutive_failures"),
            row.getString("last_error"),
        )
    }.list()

    fun sourceState(source: String): SourceState? = sourceStates().firstOrNull { it.source == source }

    fun recordSourceSuccess(source: String, sha: String, observedAt: Instant, changed: Boolean) {
        jdbc.sql(
            """
            INSERT INTO source_state(
                source, last_attempt_at, last_success_at, last_response_sha,
                version_first_seen_at, consecutive_failures, last_error
            ) VALUES (:source, :observedAt, :observedAt, :sha, :observedAt, 0, NULL)
            ON CONFLICT (source) DO UPDATE SET
                last_attempt_at = EXCLUDED.last_attempt_at,
                last_success_at = EXCLUDED.last_success_at,
                last_response_sha = EXCLUDED.last_response_sha,
                version_first_seen_at = CASE
                    WHEN source_state.last_response_sha = EXCLUDED.last_response_sha
                    THEN source_state.version_first_seen_at
                    ELSE EXCLUDED.version_first_seen_at
                END,
                consecutive_failures = 0,
                last_error = NULL
            """.trimIndent(),
        ).param("source", source).param("observedAt", Timestamp.from(observedAt))
            .param("sha", sha).update()
    }

    fun recordSourceFailure(source: String, observedAt: Instant, error: String) {
        jdbc.sql(
            """
            INSERT INTO source_state(
                source, last_attempt_at, last_success_at, last_response_sha,
                version_first_seen_at, consecutive_failures, last_error
            ) VALUES (:source, :observedAt, NULL, NULL, NULL, 1, :error)
            ON CONFLICT (source) DO UPDATE SET
                last_attempt_at = EXCLUDED.last_attempt_at,
                consecutive_failures = source_state.consecutive_failures + 1,
                last_error = EXCLUDED.last_error
            """.trimIndent(),
        ).param("source", source).param("observedAt", Timestamp.from(observedAt))
            .param("error", error.take(2_000)).update()
    }

    fun saveLaundryVersion(version: LaundryVersion, firstSeenAt: Instant) {
        val json = objectMapper.writeValueAsString(version)
        jdbc.sql(
            """
            INSERT INTO laundry_version(sha, normalized, first_seen_at, last_seen_at)
            VALUES (:sha, CAST(:normalized AS jsonb), :firstSeenAt, :lastSeenAt)
            ON CONFLICT (sha) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
            """.trimIndent(),
        ).param("sha", version.sourceVersionSha).param("normalized", json)
            .param("firstSeenAt", Timestamp.from(firstSeenAt))
            .param("lastSeenAt", Timestamp.from(Instant.parse(version.observedAt))).update()
    }

    fun latestLaundryVersion(): LaundryVersion? = jdbc.sql(
        "SELECT normalized::text FROM laundry_version ORDER BY last_seen_at DESC LIMIT 1",
    ).query(String::class.java).optional().map { objectMapper.readValue(it, LaundryVersion::class.java) }.orElse(null)

    fun laundryVersion(sha: String): LaundryVersion? = jdbc.sql(
        "SELECT normalized::text FROM laundry_version WHERE sha = :sha",
    ).param("sha", sha).query(String::class.java).optional()
        .map { objectMapper.readValue(it, LaundryVersion::class.java) }.orElse(null)

    fun saveObservation(observation: MinuteObservation) {
        jdbc.sql(
            """
            INSERT INTO minute_observation(
                source, minute_epoch, scheduled_at, collected_at, status, version_sha,
                version_first_seen_at, changed, duration_ms, http_status, error
            ) VALUES (:source, :minuteEpoch, :scheduledAt, :collectedAt, :status,
                :versionSha, :versionFirstSeenAt, :changed, :durationMs, :httpStatus, :error)
            ON CONFLICT (source, minute_epoch) DO UPDATE SET
                scheduled_at = EXCLUDED.scheduled_at, collected_at = EXCLUDED.collected_at,
                status = EXCLUDED.status, version_sha = EXCLUDED.version_sha,
                version_first_seen_at = EXCLUDED.version_first_seen_at,
                changed = EXCLUDED.changed, duration_ms = EXCLUDED.duration_ms,
                http_status = EXCLUDED.http_status, error = EXCLUDED.error
            """.trimIndent(),
        ).param("source", observation.source).param("minuteEpoch", observation.minuteEpoch)
            .param("scheduledAt", Timestamp.from(Instant.parse(observation.scheduledAt)))
            .param("collectedAt", Timestamp.from(Instant.parse(observation.collectedAt)))
            .param("status", observation.status).param("versionSha", observation.versionSha)
            .param("versionFirstSeenAt", observation.versionFirstSeenAt?.let { Timestamp.from(Instant.parse(it)) })
            .param("changed", observation.changed).param("durationMs", observation.durationMs)
            .param("httpStatus", observation.httpStatus).param("error", observation.error).update()
    }

    fun observation(minuteEpoch: Long): MinuteObservation? = jdbc.sql(
        "SELECT * FROM minute_observation WHERE source = 'laundry' AND minute_epoch = :minuteEpoch",
    ).param("minuteEpoch", minuteEpoch).query { row, _ ->
        MinuteObservation(
            row.getString("source"),
            row.getLong("minute_epoch"),
            row.getTimestamp("scheduled_at").toInstant().toString(),
            row.getTimestamp("collected_at").toInstant().toString(),
            row.getString("status"),
            row.getString("version_sha"),
            row.getTimestamp("version_first_seen_at")?.toInstant()?.toString(),
            row.getBoolean("changed"),
            row.getLong("duration_ms"),
            row.getObject("http_status", Int::class.javaObjectType),
            row.getString("error"),
        )
    }.optional().orElse(null)

    fun saveLaundryEvents(events: List<LaundryEvent>) {
        events.forEach { event ->
            jdbc.sql(
                """
                INSERT INTO laundry_event(
                    id, machine_id, appliance, session_id, type, previous_observed_at,
                    observed_at, eta_delta_minutes, previous_state, current_state, detail
                ) VALUES (:id, :machineId, :appliance, :sessionId, :type, :previousObservedAt,
                    :observedAt, :etaDelta, :previousState, :currentState, CAST(:detail AS jsonb))
                ON CONFLICT (id) DO NOTHING
                """.trimIndent(),
            ).param("id", UUID.nameUUIDFromBytes(event.id.toByteArray()))
                .param("machineId", event.machineId).param("appliance", event.appliance)
                .param("sessionId", event.sessionId).param("type", event.type)
                .param("previousObservedAt", event.previousObservedAt?.let { Timestamp.from(Instant.parse(it)) })
                .param("observedAt", Timestamp.from(Instant.parse(event.observedAt)))
                .param("etaDelta", event.etaDeltaMinutes).param("previousState", event.previousState)
                .param("currentState", event.currentState)
                .param("detail", objectMapper.writeValueAsString(event.detail)).update()
        }
    }

    fun laundryEvents(since: Instant?, limit: Int): List<LaundryEvent> = jdbc.sql(
        """
        SELECT id, machine_id, appliance, session_id, type, previous_observed_at,
               observed_at, eta_delta_minutes, previous_state, current_state, detail::text
        FROM laundry_event
        WHERE (:since IS NULL OR observed_at > :since)
        ORDER BY observed_at ASC, id ASC LIMIT :limit
        """.trimIndent(),
    ).param("since", since?.let(Timestamp::from)).param("limit", limit).query { row, _ ->
        @Suppress("UNCHECKED_CAST")
        LaundryEvent(
            row.getObject("id", UUID::class.java).toString(),
            row.getString("machine_id"),
            row.getString("appliance"),
            row.getString("session_id"),
            row.getString("type"),
            row.getTimestamp("previous_observed_at")?.toInstant()?.toString(),
            row.getTimestamp("observed_at").toInstant().toString(),
            row.getObject("eta_delta_minutes", Double::class.javaObjectType),
            row.getString("previous_state"),
            row.getString("current_state"),
            objectMapper.readValue(row.getString("detail"), Map::class.java) as Map<String, Any?>,
        )
    }.list()

    fun upsertMealPost(post: MealPost, observedAt: Instant) {
        jdbc.sql(
            """
            INSERT INTO meal_post(
                id, kind, content_sha, title, body, pinned, published_at, updated_at,
                permalink, status, first_seen_at, content_first_seen_at, last_seen_at
            ) VALUES (:id, :kind, :contentSha, :title, :body, :pinned, :publishedAt,
                :updatedAt, :permalink, :status, :observedAt, :observedAt, :observedAt)
            ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind,
                content_first_seen_at = CASE
                    WHEN meal_post.content_sha <> EXCLUDED.content_sha THEN EXCLUDED.content_first_seen_at
                    ELSE meal_post.content_first_seen_at
                END,
                content_sha = EXCLUDED.content_sha, title = EXCLUDED.title,
                body = EXCLUDED.body, pinned = EXCLUDED.pinned,
                published_at = EXCLUDED.published_at, updated_at = EXCLUDED.updated_at,
                permalink = EXCLUDED.permalink, status = EXCLUDED.status,
                last_seen_at = EXCLUDED.last_seen_at
            """.trimIndent(),
        ).param("id", post.id).param("kind", post.kind).param("contentSha", post.contentSha)
            .param("title", post.title).param("body", post.text).param("pinned", post.pinned)
            .param("publishedAt", post.publishedAt?.let { Timestamp.from(Instant.parse(it)) })
            .param("updatedAt", post.updatedAt?.let { Timestamp.from(Instant.parse(it)) })
            .param("permalink", post.permalink).param("status", post.status)
            .param("observedAt", Timestamp.from(observedAt)).update()
    }

    fun replaceMealImages(postId: String, images: List<StoredMealImage>) {
        jdbc.sql("DELETE FROM meal_image WHERE post_id = :postId").param("postId", postId).update()
        images.forEachIndexed { index, image ->
            jdbc.sql(
                """
                INSERT INTO meal_image(
                    post_id, media_id, position, source_url, declared_content_type,
                    filename, width, height, sha, content_type, extension, byte_length, content
                ) VALUES (:postId, :mediaId, :position, :sourceUrl, :declaredContentType,
                    :filename, :width, :height, :sha, :contentType, :extension, :byteLength, :content)
                """.trimIndent(),
            ).param("postId", postId).param("mediaId", image.mediaId).param("position", index)
                .param("sourceUrl", image.sourceUrl).param("declaredContentType", image.declaredContentType)
                .param("filename", image.filename).param("width", image.width).param("height", image.height)
                .param("sha", image.sha).param("contentType", image.contentType).param("extension", image.extension)
                .param("byteLength", image.content.size.toLong()).param("content", image.content).update()
        }
    }

    fun mealImage(postId: String, mediaId: String): StoredMealImage? = jdbc.sql(
        """
        SELECT media_id, source_url, declared_content_type, filename, width, height,
               sha, content_type, extension, content
        FROM meal_image WHERE post_id = :postId AND media_id = :mediaId
        """.trimIndent(),
    ).param("postId", postId).param("mediaId", mediaId).query { row, _ ->
        StoredMealImage(
            row.getString("media_id"), row.getString("source_url"),
            row.getString("declared_content_type"), row.getString("filename"),
            row.getObject("width", Int::class.javaObjectType),
            row.getObject("height", Int::class.javaObjectType), row.getString("sha"),
            row.getString("content_type"), row.getString("extension"), row.getBytes("content"),
        )
    }.optional().orElse(null)

    fun upsertWeeklyMenu(weekKey: String, contentSha: String, postId: String, updatedAt: Instant?, observedAt: Instant) {
        jdbc.sql(
            """
            INSERT INTO meal_weekly_menu(week_key, content_sha, post_id, updated_at, observed_at)
            VALUES (CAST(:weekKey AS date), :contentSha, :postId, :updatedAt, :observedAt)
            ON CONFLICT (week_key) DO UPDATE SET content_sha = EXCLUDED.content_sha,
                post_id = EXCLUDED.post_id, updated_at = EXCLUDED.updated_at,
                observed_at = EXCLUDED.observed_at
            """.trimIndent(),
        ).param("weekKey", weekKey).param("contentSha", contentSha).param("postId", postId)
            .param("updatedAt", updatedAt?.let(Timestamp::from)).param("observedAt", Timestamp.from(observedAt)).update()
    }

    fun mealPosts(limit: Int = 100): List<MealPost> = mealPostsWhere("TRUE", emptyMap(), limit)

    fun mealPostsForMonth(from: Instant, to: Instant): List<MealPost> = mealPostsWhere(
        "post.published_at >= :from AND post.published_at < :to",
        mapOf("from" to Timestamp.from(from), "to" to Timestamp.from(to)),
        500,
    )

    fun weeklyMenus(limit: Int = 100): List<WeeklyMealMenu> {
        val menus = jdbc.sql(
            "SELECT week_key::text, content_sha, post_id FROM meal_weekly_menu ORDER BY week_key DESC LIMIT :limit",
        ).param("limit", limit).query { row, _ ->
            Triple(row.getString(1), row.getString(2), row.getString(3))
        }.list()
        val posts = mealPosts(limit = 500).associateBy { it.id }
        return menus.mapNotNull { (weekKey, sha, postId) -> posts[postId]?.let { WeeklyMealMenu(weekKey, sha, it) } }
    }

    fun asset(sha: String): StoredAsset? = jdbc.sql(
        "SELECT content, content_type, extension FROM meal_image WHERE sha = :sha LIMIT 1",
    ).param("sha", sha).query { row, _ ->
        StoredAsset(row.getBytes("content"), row.getString("content_type"), row.getString("extension"))
    }.optional().orElse(null)

    private fun mealPostsWhere(where: String, params: Map<String, Any>, limit: Int): List<MealPost> {
        var spec = jdbc.sql(
            """
            SELECT post.*, image.media_id, image.source_url, image.declared_content_type,
                   image.filename, image.width, image.height, image.sha, image.content_type,
                   image.extension, image.byte_length
            FROM meal_post post
            LEFT JOIN meal_image image ON image.post_id = post.id
            WHERE $where
            ORDER BY post.published_at DESC NULLS LAST, post.id, image.position
            LIMIT :rowLimit
            """.trimIndent(),
        ).param("rowLimit", limit * 10)
        params.forEach { (name, value) -> spec = spec.param(name, value) }
        val rows = spec.query { row, _ ->
            MealRow(
                row.getString("id"), row.getString("kind"), row.getString("content_sha"),
                row.getString("title"), row.getString("body"), row.getBoolean("pinned"),
                row.getTimestamp("published_at")?.toInstant()?.toString(),
                row.getTimestamp("updated_at")?.toInstant()?.toString(), row.getString("permalink"),
                row.getString("status"), row.getTimestamp("first_seen_at").toInstant().toString(),
                row.getTimestamp("last_seen_at").toInstant().toString(), row.getString("media_id"),
                row.getString("source_url"), row.getString("declared_content_type"), row.getString("filename"),
                row.getObject("width", Int::class.javaObjectType),
                row.getObject("height", Int::class.javaObjectType), row.getString("sha"),
                row.getString("content_type"), row.getString("extension"),
                row.getObject("byte_length", Long::class.javaObjectType),
            )
        }.list()
        return rows.groupBy { it.id }.values.take(limit).map { group -> group.first().toPost(group) }
    }
}

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

private data class MealRow(
    val id: String,
    val kind: String,
    val contentSha: String,
    val title: String?,
    val body: String,
    val pinned: Boolean,
    val publishedAt: String?,
    val updatedAt: String?,
    val permalink: String?,
    val status: String?,
    val firstSeenAt: String,
    val lastSeenAt: String,
    val mediaId: String?,
    val sourceUrl: String?,
    val declaredContentType: String?,
    val filename: String?,
    val width: Int?,
    val height: Int?,
    val sha: String?,
    val contentType: String?,
    val extension: String?,
    val byteLength: Long?,
) {
    fun toPost(rows: List<MealRow>): MealPost = MealPost(
        id, kind, contentSha, title, body, pinned, publishedAt, updatedAt, permalink, status,
        rows.filter { it.mediaId != null }.map { row ->
            MealImage(
                id,
                row.mediaId!!,
                row.sourceUrl!!,
                row.declaredContentType,
                row.filename,
                row.width,
                row.height,
                row.sha!!,
                "/api/public/assets/${row.sha}.${row.extension}",
                row.contentType!!,
                row.extension!!,
                row.byteLength!!,
            )
        },
        firstSeenAt,
        lastSeenAt,
    )
}
