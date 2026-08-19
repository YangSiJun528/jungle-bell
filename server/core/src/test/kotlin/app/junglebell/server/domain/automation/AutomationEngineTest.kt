package app.junglebell.server.domain.automation

import app.junglebell.server.domain.publicapi.LaundryAppliance
import app.junglebell.server.domain.publicapi.NormalizedEnum
import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AutomationEngineTest {
    @Test
    fun `attendance notification uses learning start and end terminology`() {
        assertEquals(
            AttendanceNotificationCopy(
                title = "학습 시작 체크가 필요합니다",
                body = "학습 시작 여부를 LMS에서 확인해 주세요.",
            ),
            attendanceNotificationCopy("morning", deadline = false, fallbackReason = null),
        )
        assertEquals(
            AttendanceNotificationCopy(
                title = "학습 종료 체크 마감",
                body = "학습 종료 여부를 LMS에서 확인해 주세요.",
            ),
            attendanceNotificationCopy("evening", deadline = true, fallbackReason = null),
        )
    }

    @Test
    fun `laundry before completion mode only notifies inside configured window`() {
        val now = Instant.parse("2026-08-19T10:00:00Z").toEpochMilli()

        val decision = laundryNotificationDecision(
            watch(mode = "before-completion", notifyBeforeMinutes = 10),
            appliance(remainingMinutes = 8, estimatedFinishAt = "2026-08-19T10:08:00Z"),
            now,
        )

        assertEquals("laundry-finishing", decision?.notification?.kind)
        assertEquals("세탁 종료 10분 전", decision?.notification?.title)
        assertEquals(true, decision?.completeWatch)
        assertNull(
            laundryNotificationDecision(
                watch(mode = "before-completion", notifyBeforeMinutes = 5),
                appliance(remainingMinutes = 8, estimatedFinishAt = "2026-08-19T10:08:00Z"),
                now,
            ),
        )
    }

    @Test
    fun `laundry estimated completion mode notifies when estimated finish is reached`() {
        val now = Instant.parse("2026-08-19T10:00:00Z").toEpochMilli()

        val decision = laundryNotificationDecision(
            watch(mode = "estimated-completion"),
            appliance(remainingMinutes = 0, estimatedFinishAt = "2026-08-19T10:00:00Z"),
            now,
        )

        assertEquals("laundry-completion-expected", decision?.notification?.kind)
        assertEquals("세탁 완료 예상", decision?.notification?.title)
        assertEquals(true, decision?.completeWatch)
        assertNull(
            laundryNotificationDecision(
                watch(mode = "confirmed-completion"),
                appliance(remainingMinutes = 0, estimatedFinishAt = "2026-08-19T10:00:00Z"),
                now,
            ),
        )
    }

    @Test
    fun `laundry confirmed completion mode waits for observed terminal state`() {
        val now = Instant.parse("2026-08-19T10:00:00Z").toEpochMilli()

        val decision = laundryNotificationDecision(
            watch(mode = "confirmed-completion"),
            appliance(
                operationalStatus = "COMPLETED",
                remainingMinutes = 0,
                estimatedFinishAt = null,
            ),
            now,
        )

        assertEquals("laundry-completed", decision?.notification?.kind)
        assertEquals("세탁 완료 확정", decision?.notification?.title)
        assertEquals(true, decision?.completeWatch)
        assertNull(
            laundryNotificationDecision(
                watch(mode = "estimated-completion"),
                appliance(remainingMinutes = 4, estimatedFinishAt = "2026-08-19T10:04:00Z"),
                now,
            ),
        )
        assertNull(
            laundryNotificationDecision(
                watch(mode = "confirmed-completion"),
                appliance(
                    operationalStatus = "ERROR",
                    remainingMinutes = 4,
                    estimatedFinishAt = "2026-08-19T10:04:00Z",
                ),
                now,
            ),
        )
    }

    private fun watch(mode: String, notifyBeforeMinutes: Int = 0) = ActiveLaundryWatch(
        id = "watch-1",
        userId = UUID.fromString("00000000-0000-0000-0000-000000000001"),
        machineId = "워시타워_1",
        appliance = "washer",
        sessionId = "session-1",
        notificationMode = mode,
        notifyBeforeMinutes = notifyBeforeMinutes,
    )

    private fun appliance(
        operationalStatus: String = "RUNNING",
        remainingMinutes: Int,
        estimatedFinishAt: String?,
    ) = LaundryAppliance(
        machineId = "워시타워_1",
        appliance = "washer",
        observedAt = "2026-08-19T09:52:00Z",
        state = NormalizedEnum("WASHING", null, true),
        operationalStatus = operationalStatus,
        remainingMinutes = remainingMinutes,
        totalMinutes = 60,
        startedAt = "2026-08-19T09:00:00Z",
        estimatedFinishAt = estimatedFinishAt,
        remoteControlEnabled = null,
        cycleCount = null,
        sessionId = "session-1",
        errorCode = null,
    )
}
