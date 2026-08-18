package app.junglebell.server.domain.security

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
class JdbcAuthStore(private val jdbc: JdbcClient) : AuthStore {
    override fun authenticateAppSession(tokenHash: String, now: Long): SessionPrincipal? {
        val stored = jdbc.sql(
            """
            SELECT session.id, session.user_id, session.installation_id,
                   session.kind, session.last_seen_at_epoch_ms
            FROM app_session session
            WHERE session.token_sha256 = :tokenHash
              AND session.revoked_at_epoch_ms IS NULL
              AND session.expires_at_epoch_ms > :now
              AND (session.kind <> 'desktop' OR EXISTS (
                  SELECT 1 FROM desktop_device desktop
                  WHERE desktop.installation_id = session.installation_id
                    AND desktop.user_id = session.user_id
              ))
            """.trimIndent(),
        ).param("tokenHash", tokenHash).param("now", now).query { row, _ ->
            StoredAppSession(
                principal = SessionPrincipal(
                    row.getObject("id", UUID::class.java),
                    row.getObject("user_id", UUID::class.java),
                    row.getString("installation_id"),
                    if (row.getString("kind") == "desktop") SessionKind.DESKTOP else SessionKind.MOBILE,
                ),
                lastSeenAtEpochMs = row.getLong("last_seen_at_epoch_ms"),
            )
        }.optional().orElse(null) ?: return null
        if (stored.lastSeenAtEpochMs <= now - SESSION_TOUCH_INTERVAL_MS) {
            jdbc.sql(
                """
                UPDATE app_session SET last_seen_at_epoch_ms = :now
                WHERE id = :id AND revoked_at_epoch_ms IS NULL
                  AND expires_at_epoch_ms > :now
                  AND last_seen_at_epoch_ms <= :staleBefore
                """.trimIndent(),
            ).param("now", now).param("id", stored.principal.sessionId)
                .param("staleBefore", now - SESSION_TOUCH_INTERVAL_MS).update()
        }
        return stored.principal
    }

    private data class StoredAppSession(
        val principal: SessionPrincipal,
        val lastSeenAtEpochMs: Long,
    )

    private companion object {
        const val SESSION_TOUCH_INTERVAL_MS = 60_000L
    }

    override fun findDesktopUiSession(tokenHash: String, now: Long): StoredDesktopUiSession? = jdbc.sql(
        """
        SELECT ui.parent_session_id AS id, ui.user_id, ui.installation_id, ui.origin
        FROM desktop_ui_session ui
        JOIN app_session parent ON parent.id = ui.parent_session_id
        JOIN desktop_device desktop ON desktop.installation_id = ui.installation_id
        WHERE ui.token_sha256 = :tokenHash
          AND ui.scope = 'desktop-ui-v1'
          AND ui.expires_at_epoch_ms > :now
          AND parent.revoked_at_epoch_ms IS NULL
          AND parent.expires_at_epoch_ms > :now
          AND parent.kind = 'desktop'
          AND parent.user_id = ui.user_id
          AND parent.installation_id = ui.installation_id
          AND desktop.user_id = ui.user_id
        """.trimIndent(),
    ).param("tokenHash", tokenHash).param("now", now).query { row, _ ->
        StoredDesktopUiSession(
            SessionPrincipal(
                row.getObject("id", UUID::class.java),
                row.getObject("user_id", UUID::class.java),
                row.getString("installation_id"),
                SessionKind.DESKTOP,
            ),
            row.getString("origin"),
        )
    }.optional().orElse(null)
}
