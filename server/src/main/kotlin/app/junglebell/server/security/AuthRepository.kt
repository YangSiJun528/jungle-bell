package app.junglebell.server.security

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
class AuthRepository(private val jdbc: JdbcClient) {
    fun findAppSession(tokenHash: String, now: Long): SessionPrincipal? = jdbc.sql(
        """
        SELECT session.id, session.user_id, session.installation_id, session.kind
        FROM app_session session
        LEFT JOIN desktop_device desktop ON desktop.installation_id = session.installation_id
        WHERE session.token_sha256 = :tokenHash
          AND session.revoked_at_epoch_ms IS NULL
          AND session.expires_at_epoch_ms > :now
          AND (session.kind <> 'desktop' OR desktop.user_id = session.user_id)
        """.trimIndent(),
    ).param("tokenHash", tokenHash).param("now", now).query { row, _ ->
        SessionPrincipal(
            row.getObject("id", UUID::class.java),
            row.getObject("user_id", UUID::class.java),
            row.getString("installation_id"),
            if (row.getString("kind") == "desktop") SessionKind.DESKTOP else SessionKind.MOBILE,
        )
    }.optional().orElse(null)

    fun findDesktopUiSession(tokenHash: String, origin: String, now: Long): SessionPrincipal? = jdbc.sql(
        """
        SELECT ui.parent_session_id AS id, ui.user_id, ui.installation_id
        FROM desktop_ui_session ui
        JOIN app_session parent ON parent.id = ui.parent_session_id
        JOIN desktop_device desktop ON desktop.installation_id = ui.installation_id
        WHERE ui.token_sha256 = :tokenHash
          AND ui.origin = :origin
          AND ui.scope = 'desktop-ui-v1'
          AND ui.expires_at_epoch_ms > :now
          AND parent.revoked_at_epoch_ms IS NULL
          AND parent.expires_at_epoch_ms > :now
          AND parent.kind = 'desktop'
          AND parent.user_id = ui.user_id
          AND desktop.user_id = ui.user_id
        """.trimIndent(),
    ).param("tokenHash", tokenHash).param("origin", origin).param("now", now).query { row, _ ->
        SessionPrincipal(
            row.getObject("id", UUID::class.java),
            row.getObject("user_id", UUID::class.java),
            row.getString("installation_id"),
            SessionKind.DESKTOP,
        )
    }.optional().orElse(null)

    fun touch(sessionId: UUID, now: Long) {
        jdbc.sql("UPDATE app_session SET last_seen_at_epoch_ms = :now WHERE id = :id")
            .param("now", now).param("id", sessionId).update()
    }
}
