package app.junglebell.server.domain.publicapi

import tools.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import java.sql.Timestamp
import java.time.Instant
import java.util.UUID

@Repository
class JdbcPublicDataStore(
    private val jdbc: JdbcClient,
    private val objectMapper: ObjectMapper,
) : PublicDataStore {
    override fun sourceStates(): List<SourceState> = jdbc.sql(
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

    override fun sourceState(source: String): SourceState? = jdbc.sql(
        "SELECT * FROM source_state WHERE source = :source",
    ).param("source", source).query(::sourceStateRow).optional().orElse(null)

    @Transactional
    override fun recordLaundrySuccess(
        version: LaundryVersion,
        firstSeenAt: Instant,
        observation: MinuteObservation,
    ) {
        saveLaundryVersion(version, firstSeenAt)
        saveLaundryCurrent(version, firstSeenAt, observation.changed)
        saveLaundryEvents(version.events)
        saveObservation(observation)
        recordSourceSuccess("laundry", version.sourceVersionSha, Instant.parse(version.observedAt))
    }

    @Transactional
    override fun recordLaundryFailure(observedAt: Instant, observation: MinuteObservation, error: String) {
        recordSourceFailure("laundry", observedAt, error)
        saveObservation(observation)
    }

    @Transactional
    override fun recordMealCollection(
        source: String,
        sha: String,
        observedAt: Instant,
        posts: List<StoredMealPublication>,
    ) {
        posts.forEach { normalized ->
            upsertMealPost(normalized.post, observedAt)
            replaceMealImages(normalized.post.id, normalized.images)
            normalized.weekKey?.let { weekKey ->
                upsertWeeklyMenu(
                    weekKey,
                    normalized.post.contentSha,
                    normalized.post.id,
                    normalized.post.updatedAt?.let(Instant::parse),
                    observedAt,
                )
            }
        }
        recordSourceSuccess(source, sha, observedAt)
    }

    override fun recordMealFailure(source: String, observedAt: Instant, error: String) {
        recordSourceFailure(source, observedAt, error)
    }

    private fun recordSourceSuccess(source: String, sha: String, observedAt: Instant) {
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

    private fun recordSourceFailure(source: String, observedAt: Instant, error: String) {
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

    private fun saveLaundryVersion(version: LaundryVersion, firstSeenAt: Instant) {
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

    private fun saveLaundryCurrent(version: LaundryVersion, firstSeenAt: Instant, changed: Boolean) {
        val json = objectMapper.writeValueAsString(version)
        jdbc.sql(
            """
            INSERT INTO laundry_current(source, sha, normalized, first_seen_at, last_seen_at)
            SELECT 'laundry', immutable.sha,
                   CASE WHEN :changed THEN CAST(:normalized AS jsonb) ELSE immutable.normalized END,
                   CASE WHEN :changed THEN :firstSeenAt ELSE immutable.first_seen_at END,
                   :lastSeenAt
            FROM laundry_version immutable
            WHERE immutable.sha = :sha
            ON CONFLICT (source) DO UPDATE SET
                sha = CASE WHEN :changed THEN EXCLUDED.sha ELSE laundry_current.sha END,
                normalized = CASE
                    WHEN :changed THEN EXCLUDED.normalized
                    ELSE laundry_current.normalized
                END,
                first_seen_at = CASE
                    WHEN :changed THEN EXCLUDED.first_seen_at
                    ELSE laundry_current.first_seen_at
                END,
                last_seen_at = EXCLUDED.last_seen_at
            """.trimIndent(),
        ).param("sha", version.sourceVersionSha).param("normalized", json)
            .param("firstSeenAt", Timestamp.from(firstSeenAt))
            .param("lastSeenAt", Timestamp.from(Instant.parse(version.observedAt)))
            .param("changed", changed).update()
    }

    override fun latestLaundryVersion(): LaundryVersion? = jdbc.sql(
        """
        WITH candidates AS (
            SELECT normalized, 0 AS priority, last_seen_at
            FROM laundry_current
            WHERE source = 'laundry' AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(normalized -> 'machines') AS machine
                WHERE jsonb_typeof(machine -> 'washer') = 'object'
                   OR jsonb_typeof(machine -> 'dryer') = 'object'
            )
            UNION ALL
            SELECT normalized, 1 AS priority, last_seen_at
            FROM laundry_version
            WHERE EXISTS (
                SELECT 1
                FROM jsonb_array_elements(normalized -> 'machines') AS machine
                WHERE jsonb_typeof(machine -> 'washer') = 'object'
                   OR jsonb_typeof(machine -> 'dryer') = 'object'
            )
        )
        SELECT normalized::text
        FROM candidates
        ORDER BY priority, last_seen_at DESC
        LIMIT 1
        """.trimIndent(),
    ).query(String::class.java).optional().map { objectMapper.readValue(it, LaundryVersion::class.java) }.orElse(null)

    override fun laundryVersion(sha: String): LaundryVersion? = jdbc.sql(
        "SELECT normalized::text FROM laundry_version WHERE sha = :sha",
    ).param("sha", sha).query(String::class.java).optional()
        .map { objectMapper.readValue(it, LaundryVersion::class.java) }.orElse(null)

    private fun saveObservation(observation: MinuteObservation) {
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

    override fun observation(minuteEpoch: Long): MinuteObservation? = jdbc.sql(
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

    private fun saveLaundryEvents(events: List<LaundryEvent>) {
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

    override fun laundryEvents(since: Instant?, limit: Int): List<LaundryEvent> {
        val where = if (since == null) "" else "WHERE observed_at > :since"
        var spec = jdbc.sql(
            """
            SELECT id, machine_id, appliance, session_id, type, previous_observed_at,
                   observed_at, eta_delta_minutes, previous_state, current_state, detail::text
            FROM laundry_event
            $where
            ORDER BY observed_at ASC, id ASC LIMIT :limit
            """.trimIndent(),
        ).param("limit", limit)
        if (since != null) spec = spec.param("since", Timestamp.from(since))
        return spec.query { row, _ ->
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
    }

    override fun laundryRisks(from: Instant, through: Instant): Map<LaundryRiskKey, LaundryRisk> = jdbc.sql(
        """
        WITH operation_sessions AS (
            SELECT machine_id, appliance, session_id,
                   BOOL_OR(type = 'ERROR_ENTERED') AS errored
            FROM laundry_event
            WHERE observed_at >= :from AND observed_at <= :through
              AND session_id IS NOT NULL
            GROUP BY machine_id, appliance, session_id
            HAVING BOOL_OR(type = 'STARTED')
        )
        SELECT machine_id, appliance, COUNT(*) AS attempts,
               COUNT(*) FILTER (WHERE errored) AS errors
        FROM operation_sessions
        GROUP BY machine_id, appliance
        """.trimIndent(),
    ).param("from", Timestamp.from(from)).param("through", Timestamp.from(through))
        .query { row, _ ->
            val key = LaundryRiskKey(row.getString("machine_id"), row.getString("appliance"))
            val risk = LaundryRisk.calculate(row.getInt("attempts"), row.getInt("errors"))
            key to risk
        }.list().toMap()

    private fun upsertMealPost(post: MealPost, observedAt: Instant) {
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

    private fun replaceMealImages(postId: String, images: List<StoredMealImage>) {
        jdbc.sql("DELETE FROM meal_image WHERE post_id = :postId").param("postId", postId).update()
        images.forEachIndexed { index, image ->
            jdbc.sql(
                """
                INSERT INTO meal_asset(sha, content_type, extension, byte_length, content)
                VALUES (:sha, :contentType, :extension, :byteLength, :content)
                ON CONFLICT (sha) DO NOTHING
                """.trimIndent(),
            ).param("sha", image.sha).param("contentType", image.contentType).param("extension", image.extension)
                .param("byteLength", image.content.size.toLong()).param("content", image.content).update()
            jdbc.sql(
                """
                INSERT INTO meal_image(
                    post_id, media_id, position, source_url, declared_content_type,
                    filename, width, height, asset_sha
                ) VALUES (:postId, :mediaId, :position, :sourceUrl, :declaredContentType,
                    :filename, :width, :height, :sha)
                """.trimIndent(),
            ).param("postId", postId).param("mediaId", image.mediaId).param("position", index)
                .param("sourceUrl", image.sourceUrl).param("declaredContentType", image.declaredContentType)
                .param("filename", image.filename).param("width", image.width).param("height", image.height)
                .param("sha", image.sha).update()
        }
    }

    override fun mealImage(postId: String, mediaId: String): StoredMealImage? = jdbc.sql(
        """
        SELECT image.media_id, image.source_url, image.declared_content_type,
               image.filename, image.width, image.height, asset.sha,
               asset.content_type, asset.extension, asset.content
        FROM meal_image image
        JOIN meal_asset asset ON asset.sha = image.asset_sha
        WHERE image.post_id = :postId AND image.media_id = :mediaId
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

    private fun upsertWeeklyMenu(weekKey: String, contentSha: String, postId: String, updatedAt: Instant?, observedAt: Instant) {
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

    override fun mealPosts(limit: Int): List<MealPost> = mealPostsWhere("TRUE", emptyMap(), limit)

    override fun mealPostsForMonth(from: Instant, to: Instant): List<MealPost> = mealPostsWhere(
        "post.published_at >= :from AND post.published_at < :to",
        mapOf("from" to Timestamp.from(from), "to" to Timestamp.from(to)),
        500,
    )

    override fun weeklyMenus(limit: Int): List<WeeklyMealMenu> {
        val menus = jdbc.sql(
            "SELECT week_key::text, content_sha, post_id FROM meal_weekly_menu ORDER BY week_key DESC LIMIT :limit",
        ).param("limit", limit).query { row, _ ->
            Triple(row.getString(1), row.getString(2), row.getString(3))
        }.list()
        val posts = mealPostsByIds(menus.map { it.third }).associateBy { it.id }
        return menus.mapNotNull { (weekKey, sha, postId) ->
            matchingWeeklyMenu(weekKey, sha, posts[postId])
        }
    }

    override fun asset(sha: String): StoredAsset? = jdbc.sql(
        "SELECT content, content_type, extension FROM meal_asset WHERE sha = :sha",
    ).param("sha", sha).query { row, _ ->
        StoredAsset(row.getBytes("content"), row.getString("content_type"), row.getString("extension"))
    }.optional().orElse(null)

    private fun mealPostsWhere(where: String, params: Map<String, Any>, limit: Int): List<MealPost> {
        var spec = jdbc.sql(
            """
            SELECT post.*
            FROM meal_post post
            WHERE $where
            ORDER BY post.published_at DESC NULLS LAST, post.id
            LIMIT :postLimit
            """.trimIndent(),
        ).param("postLimit", limit)
        params.forEach { (name, value) -> spec = spec.param(name, value) }
        return attachMealImages(spec.query(::mealPostRow).list())
    }

    private fun mealPostsByIds(postIds: Collection<String>): List<MealPost> {
        if (postIds.isEmpty()) return emptyList()
        val rows = jdbc.sql(
            """
            SELECT post.* FROM meal_post post
            WHERE post.id IN (:postIds)
            ORDER BY post.published_at DESC NULLS LAST, post.id
            """.trimIndent(),
        ).param("postIds", postIds).query(::mealPostRow).list()
        return attachMealImages(rows)
    }

    private fun attachMealImages(posts: List<MealPostRow>): List<MealPost> {
        if (posts.isEmpty()) return emptyList()
        val images = jdbc.sql(
            """
            SELECT image.post_id, image.media_id, image.source_url,
                   image.declared_content_type, image.filename, image.width, image.height,
                   asset.sha, asset.content_type, asset.extension, asset.byte_length
            FROM meal_image image
            JOIN meal_asset asset ON asset.sha = image.asset_sha
            WHERE image.post_id IN (:postIds)
            ORDER BY image.post_id, image.position
            """.trimIndent(),
        ).param("postIds", posts.map { it.id }).query { row, _ ->
            MealImageRow(
                postId = row.getString("post_id"),
                mediaId = row.getString("media_id"),
                sourceUrl = row.getString("source_url"),
                declaredContentType = row.getString("declared_content_type"),
                filename = row.getString("filename"),
                width = row.getObject("width", Int::class.javaObjectType),
                height = row.getObject("height", Int::class.javaObjectType),
                sha = row.getString("sha"),
                contentType = row.getString("content_type"),
                extension = row.getString("extension"),
                byteLength = row.getLong("byte_length"),
            )
        }.list().groupBy { it.postId }
        return posts.map { post -> post.toPost(images[post.id].orEmpty()) }
    }

    private fun mealPostRow(row: java.sql.ResultSet, index: Int) = MealPostRow(
        id = row.getString("id"),
        kind = row.getString("kind"),
        contentSha = row.getString("content_sha"),
        title = row.getString("title"),
        body = row.getString("body"),
        pinned = row.getBoolean("pinned"),
        publishedAt = row.getTimestamp("published_at")?.toInstant()?.toString(),
        updatedAt = row.getTimestamp("updated_at")?.toInstant()?.toString(),
        permalink = row.getString("permalink"),
        status = row.getString("status"),
        firstSeenAt = row.getTimestamp("first_seen_at").toInstant().toString(),
        lastSeenAt = row.getTimestamp("last_seen_at").toInstant().toString(),
    )
    private fun sourceStateRow(row: java.sql.ResultSet, index: Int) = SourceState(
        row.getString("source"),
        row.getTimestamp("last_attempt_at").toInstant().toString(),
        row.getTimestamp("last_success_at")?.toInstant()?.toString(),
        row.getString("last_response_sha"),
        row.getTimestamp("version_first_seen_at")?.toInstant()?.toString(),
        row.getInt("consecutive_failures"),
        row.getString("last_error"),
    )
}

internal fun matchingWeeklyMenu(weekKey: String, contentSha: String, post: MealPost?): WeeklyMealMenu? =
    post?.takeIf { it.contentSha == contentSha }?.let { WeeklyMealMenu(weekKey, contentSha, it) }

private data class MealPostRow(
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
)

private data class MealImageRow(
    val postId: String,
    val mediaId: String,
    val sourceUrl: String,
    val declaredContentType: String?,
    val filename: String?,
    val width: Int?,
    val height: Int?,
    val sha: String,
    val contentType: String,
    val extension: String,
    val byteLength: Long,
)

private fun MealPostRow.toPost(images: List<MealImageRow>): MealPost =
    MealPost(
        id, kind, contentSha, title, body, pinned, publishedAt, updatedAt, permalink, status,
        images.map { image ->
            MealImage(
                id,
                image.mediaId,
                image.sourceUrl,
                image.declaredContentType,
                image.filename,
                image.width,
                image.height,
                image.sha,
                "/api/public/assets/${image.sha}.${image.extension}",
                image.contentType,
                image.extension,
                image.byteLength,
            )
        },
        firstSeenAt,
        lastSeenAt,
    )
