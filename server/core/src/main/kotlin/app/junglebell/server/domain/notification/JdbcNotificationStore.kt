package app.junglebell.server.domain.notification

import tools.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

@Repository
class JdbcNotificationStore(
    private val jdbc: JdbcClient,
    private val objectMapper: ObjectMapper,
) : NotificationStore {
    override fun create(record: NotificationRecord): Boolean = jdbc.sql(
        """
        WITH created AS (
            INSERT INTO notification(
                id, user_id, source_event_id, kind, title, body, path, payload,
                created_at_epoch_ms, due_at_epoch_ms, expires_at_epoch_ms
            ) VALUES (:id, :userId, :sourceEventId, :kind, :title, :body, :path,
                CAST(:payload AS jsonb), :createdAt, :dueAt, :expiresAt)
            ON CONFLICT (user_id, source_event_id) DO NOTHING
            RETURNING id, user_id, due_at_epoch_ms, created_at_epoch_ms
        ), targets AS (
            SELECT created.id AS notification_id, 'desktop'::text AS target_kind,
                device.installation_id AS target_id, created.due_at_epoch_ms AS next_attempt_at
            FROM created
            JOIN desktop_device device ON device.user_id = created.user_id
            JOIN app_session session ON session.installation_id = device.installation_id
                AND session.user_id = device.user_id AND session.kind = 'desktop'
                AND session.revoked_at_epoch_ms IS NULL
                AND session.expires_at_epoch_ms > created.created_at_epoch_ms
            UNION ALL
            SELECT created.id, 'push'::text, push.id, created.due_at_epoch_ms
            FROM created
            JOIN push_subscription push ON push.user_id = created.user_id
                AND push.revoked_at_epoch_ms IS NULL
            JOIN app_session session ON session.id = push.session_id
                AND session.revoked_at_epoch_ms IS NULL
                AND session.expires_at_epoch_ms > created.created_at_epoch_ms
        ), deliveries AS (
            INSERT INTO notification_delivery(
                notification_id, target_kind, target_id, status, attempts,
                next_attempt_at_epoch_ms, last_error, delivered_at_epoch_ms,
                lease_token, lease_expires_at_epoch_ms
            )
            SELECT notification_id, target_kind, target_id, 'pending', 0,
                next_attempt_at, NULL, NULL, NULL, NULL
            FROM targets
            ON CONFLICT DO NOTHING
            RETURNING notification_id
        )
        SELECT id FROM created
        """.trimIndent(),
    ).param("id", record.id).param("userId", record.userId)
        .param("sourceEventId", record.sourceEventId).param("kind", record.kind)
        .param("title", record.title).param("body", record.body).param("path", record.path)
        .param("payload", objectMapper.writeValueAsString(record.deliveryPayload()))
        .param("createdAt", record.createdAtEpochMs).param("dueAt", record.dueAtEpochMs)
        .param("expiresAt", record.expiresAtEpochMs)
        .query(UUID::class.java).optional().isPresent

    @Transactional
    override fun createFromLaundryWatch(
        record: NotificationRecord,
        watchId: String,
        completeWatch: Boolean,
        now: Long,
    ): Boolean {
        val active = jdbc.sql(
            """
            SELECT id FROM laundry_watch
            WHERE id = :watchId AND user_id = :userId AND status = 'active'
            FOR UPDATE
            """.trimIndent(),
        ).param("watchId", watchId).param("userId", record.userId)
            .query(String::class.java).optional().isPresent
        if (!active) return false

        val created = create(record)
        if (record.kind == "laundry-attention") {
            jdbc.sql(
                """
                UPDATE laundry_watch
                SET attention_unresolved = true, attention_unresolved_at_epoch_ms = :now,
                    updated_at_epoch_ms = :now
                WHERE id = :watchId AND status = 'active' AND NOT attention_unresolved
                """.trimIndent(),
            ).param("now", now).param("watchId", watchId).update()
        } else if (completeWatch) {
            jdbc.sql(
                """
                UPDATE laundry_watch
                SET status = 'completed', attention_unresolved = false,
                    attention_unresolved_at_epoch_ms = NULL, updated_at_epoch_ms = :now
                WHERE id = :watchId AND status = 'active'
                RETURNING id
                """.trimIndent(),
            ).param("now", now).param("watchId", watchId).query(String::class.java).optional()
        }
        return created
    }

    override fun desktopInbox(userId: UUID, installationId: String, now: Long, limit: Int): List<PublicNotification> = jdbc.sql(
        """
        SELECT notification.*, delivery.attempts
        FROM notification_delivery delivery
        JOIN notification ON notification.id = delivery.notification_id
        WHERE notification.user_id = :userId AND delivery.target_kind = 'desktop'
          AND delivery.target_id = :installationId
          AND delivery.status IN ('pending', 'retry')
          AND notification.due_at_epoch_ms <= :now
          AND notification.expires_at_epoch_ms > :now
        ORDER BY notification.created_at_epoch_ms ASC LIMIT :limit
        """.trimIndent(),
    ).param("userId", userId).param("installationId", installationId).param("now", now)
        .param("limit", limit).query(::notificationRow).list()

    override fun history(userId: UUID, limit: Int): List<PublicNotification> = jdbc.sql(
        """
        SELECT notification.*, 0 AS attempts FROM notification
        WHERE user_id = :userId ORDER BY created_at_epoch_ms DESC LIMIT :limit
        """.trimIndent(),
    ).param("userId", userId).param("limit", limit).query(::notificationRow).list()

    override fun acknowledge(
        userId: UUID,
        installationId: String,
        notificationId: UUID,
        outcome: String,
        occurredAt: Long,
    ): Boolean = jdbc.sql(
        """
        UPDATE notification_delivery delivery
        SET status = CASE WHEN :outcome = 'displayed' THEN 'delivered' ELSE 'failed' END,
            attempts = attempts + 1,
            delivered_at_epoch_ms = CASE WHEN :outcome = 'displayed' THEN :occurredAt ELSE NULL END,
            last_error = CASE WHEN :outcome = 'failed' THEN 'desktop-display-failed' ELSE NULL END
        FROM notification
        WHERE delivery.notification_id = notification.id
          AND notification.id = :notificationId AND notification.user_id = :userId
          AND delivery.target_kind = 'desktop' AND delivery.target_id = :installationId
          AND delivery.status IN ('pending', 'retry')
        RETURNING delivery.notification_id
        """.trimIndent(),
    ).param("outcome", outcome).param("occurredAt", occurredAt).param("notificationId", notificationId)
        .param("userId", userId).param("installationId", installationId)
        .query(UUID::class.java).optional().isPresent

    override fun activePushCount(userId: UUID, now: Long): Int = jdbc.sql(
        """
        SELECT count(*) FROM push_subscription push
        JOIN app_session session ON session.id = push.session_id
        WHERE push.user_id = :userId AND push.revoked_at_epoch_ms IS NULL
          AND session.revoked_at_epoch_ms IS NULL AND session.expires_at_epoch_ms > :now
        """.trimIndent(),
    ).param("userId", userId).param("now", now).query(Int::class.java).single()

    override fun savePush(
        id: String,
        userId: UUID,
        sessionId: UUID,
        endpoint: String,
        p256dh: String,
        auth: String,
        now: Long,
    ) {
        jdbc.sql(
            """
            INSERT INTO push_subscription(
                id, user_id, session_id, endpoint, p256dh, auth,
                created_at_epoch_ms, revoked_at_epoch_ms
            ) VALUES (:id, :userId, :sessionId, :endpoint, :p256dh, :auth, :now, NULL)
            ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id,
                session_id = EXCLUDED.session_id, endpoint = EXCLUDED.endpoint,
                p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                created_at_epoch_ms = EXCLUDED.created_at_epoch_ms,
                revoked_at_epoch_ms = NULL
            """.trimIndent(),
        ).param("id", id).param("userId", userId).param("sessionId", sessionId)
            .param("endpoint", endpoint).param("p256dh", p256dh).param("auth", auth)
            .param("now", now).update()
    }

    override fun revokePush(userId: UUID, id: String, now: Long): Boolean = jdbc.sql(
        """
        UPDATE push_subscription SET revoked_at_epoch_ms = :now
        WHERE id = :id AND user_id = :userId AND revoked_at_epoch_ms IS NULL
        RETURNING id
        """.trimIndent(),
    ).param("now", now).param("id", id).param("userId", userId)
        .query(String::class.java).optional().isPresent

    private fun notificationRow(row: java.sql.ResultSet, index: Int) = PublicNotification(
        row.getObject("id", UUID::class.java).toString(),
        canonicalNotificationKind(row.getString("kind")),
        row.getString("title"), row.getString("body"), row.getString("path"),
        row.getLong("created_at_epoch_ms"), row.getLong("expires_at_epoch_ms"), row.getLong("attempts"),
    )
}
