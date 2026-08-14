package app.junglebell.server.domain.notification

import java.util.UUID

interface NotificationStore {
    /** 알림 저장과 현재 전달 대상 fan-out을 하나의 PostgreSQL 문장으로 처리합니다. */
    fun create(record: NotificationRecord): Boolean
    fun createFromLaundryWatch(record: NotificationRecord, watchId: String, completeWatch: Boolean, now: Long): Boolean
    fun desktopInbox(userId: UUID, installationId: String, now: Long, limit: Int): List<PublicNotification>
    fun history(userId: UUID, limit: Int): List<PublicNotification>
    fun acknowledge(userId: UUID, installationId: String, notificationId: UUID, outcome: String, occurredAt: Long): Boolean
    fun activePushCount(userId: UUID, now: Long): Int
    fun savePush(id: String, userId: UUID, sessionId: UUID, endpoint: String, p256dh: String, auth: String, now: Long)
    fun revokePush(userId: UUID, id: String, now: Long): Boolean
}

data class NotificationRecord(
    val id: UUID,
    val userId: UUID,
    val sourceEventId: String,
    val kind: String,
    val title: String,
    val body: String,
    val path: String,
    val payload: Map<String, Any?>,
    val createdAtEpochMs: Long,
    val dueAtEpochMs: Long,
    val expiresAtEpochMs: Long,
)
