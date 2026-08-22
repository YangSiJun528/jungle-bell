package app.junglebell.server.domain.automation

import app.junglebell.server.domain.notification.NotificationRecord
import app.junglebell.server.domain.notification.NotificationStore
import app.junglebell.server.domain.publicapi.LaundryAppliance
import app.junglebell.server.domain.publicapi.NormalizedEnum
import app.junglebell.server.domain.publicapi.PublicDataStore
import org.mockito.ArgumentMatchers.anyInt
import org.mockito.ArgumentMatchers.anyLong
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.mock
import org.mockito.Mockito.mockingDetails
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import java.time.Clock
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AutomationEngineTest {
    @Test
    fun `push delivery is not gated by the minute automation lease`() {
        val automation = mock(AutomationStore::class.java)
        val pushSender = mock(PushSender::class.java)
        `when`(pushSender.configured).thenReturn(true)
        `when`(automation.claimPushDeliveries(anyLong(), anyString(), anyInt())).thenReturn(emptyList())
        val engine = AutomationEngine(
            automation,
            mock(NotificationStore::class.java),
            mock(PublicDataStore::class.java),
            pushSender,
            Clock.fixed(Instant.parse("2026-08-20T00:00:00Z"), ZoneOffset.UTC),
        )

        engine.runMinuteCycle()

        verify(automation, never()).claimPushDeliveries(anyLong(), anyString(), anyInt())

        engine.runPushCycle()

        verify(automation).claimPushDeliveries(anyLong(), anyString(), anyInt())
    }

    @Test
    fun `attendance notification copy includes the actual deadline countdown`() {
        val deadline = epoch("2026-08-20T10:00:00+09:00")
        assertEquals(
            AttendanceNotificationCopy(
                kind = "attendance-action-required",
                title = "학습 시작 체크가 필요합니다",
                body = "10:00 마감까지 1시간 30분 남았습니다.",
            ),
            attendanceNotificationCopy(
                phase = "morning",
                deadline = false,
                fallbackReason = null,
                timing = AttendanceNotificationTiming(
                    deadlineAtEpochMs = deadline,
                    countdownTargetEpochMs = deadline,
                    remainingMinutes = 90,
                ),
            ),
        )
        assertEquals(
            AttendanceNotificationCopy(
                kind = "attendance-action-required",
                title = "학습 종료 체크 마감",
                body = "04:00 마감 시각이 지났습니다. 지금 LMS에서 확인해 주세요.",
            ),
            attendanceNotificationCopy(
                phase = "evening",
                deadline = true,
                fallbackReason = null,
                timing = AttendanceNotificationTiming(
                    deadlineAtEpochMs = epoch("2026-08-21T04:00:00+09:00"),
                    countdownTargetEpochMs = null,
                    remainingMinutes = null,
                ),
            ),
        )
    }

    @Test
    fun `morning notification counts down to ten oclock and rounds partial minutes up`() {
        val ninetyMinutes = attendanceRecordAt(
            "2026-08-20T08:30:00+09:00",
            phase = "morning",
            morningStartHour = 8,
        )
        assertEquals("학습 시작 체크가 필요합니다", ninetyMinutes.title)
        assertEquals("10:00 마감까지 1시간 30분 남았습니다.", ninetyMinutes.body)
        assertEquals(90L, ninetyMinutes.payload["remainingMinutes"])
        assertEquals(epoch("2026-08-20T10:00:00+09:00"), ninetyMinutes.payload["deadlineAtEpochMs"])

        val exactHour = attendanceRecordAt("2026-08-20T09:00:00+09:00", phase = "morning")
        assertEquals("10:00 마감까지 1시간 남았습니다.", exactHour.body)
        assertEquals(60L, exactHour.payload["remainingMinutes"])

        val partialMinute = attendanceRecordAt("2026-08-20T09:59:01+09:00", phase = "morning")
        assertEquals("10:00 마감까지 1분 남았습니다.", partialMinute.body)
        assertEquals(1L, partialMinute.payload["remainingMinutes"])
    }

    @Test
    fun `evening notification counts down across midnight to the configured end hour`() {
        val defaultEnd = attendanceRecordAt("2026-08-21T00:30:00+09:00", phase = "evening")
        assertEquals("학습 종료 체크가 필요합니다", defaultEnd.title)
        assertEquals("04:00 마감까지 3시간 30분 남았습니다.", defaultEnd.body)
        assertEquals(210L, defaultEnd.payload["remainingMinutes"])
        assertEquals(epoch("2026-08-21T04:00:00+09:00"), defaultEnd.payload["deadlineAtEpochMs"])

        val customEnd = attendanceRecordAt(
            "2026-08-21T00:30:00+09:00",
            phase = "evening",
            eveningEndHour = 2,
        )
        assertEquals("02:00 마감까지 1시간 30분 남았습니다.", customEnd.body)
        assertEquals(90L, customEnd.payload["remainingMinutes"])
    }

    @Test
    fun `morning grace notification counts down to the final deadline`() {
        val record = attendanceRecordAt("2026-08-20T10:05:00+09:00", phase = "morning")

        assertEquals("학습 시작 체크 지각 임박", record.title)
        assertEquals("10:10 최종 마감까지 5분 남았습니다.", record.body)
        assertEquals(epoch("2026-08-20T10:00:00+09:00"), record.payload["deadlineAtEpochMs"])
        assertEquals(epoch("2026-08-20T10:10:00+09:00"), record.payload["countdownTargetEpochMs"])
        assertEquals(5L, record.payload["remainingMinutes"])
    }

    @Test
    fun `evening post deadline notification does not claim positive remaining time`() {
        val record = attendanceRecordAt("2026-08-21T04:05:00+09:00", phase = "evening")

        assertEquals("학습 종료 체크 마감", record.title)
        assertEquals("04:00 마감 시각이 지났습니다. 지금 LMS에서 확인해 주세요.", record.body)
        assertNull(record.payload["countdownTargetEpochMs"])
        assertNull(record.payload["remainingMinutes"])
    }

    @Test
    fun `attendance fallback guidance reports unavailable state without claiming action is required`() {
        val offline = attendanceRecordAt(
            "2026-08-20T09:30:00+09:00",
            phase = "morning",
            devices = emptyList(),
        )
        assertEquals("학습 시작 상태를 확인할 수 없습니다", offline.title)
        assertEquals(
            "10:00 마감까지 30분 남았습니다. " +
                "PC가 연결되지 않아 출석 상태를 확인할 수 없습니다. LMS에서 직접 확인해 주세요.",
            offline.body,
        )

        val loginRequired = attendanceRecordAt(
            "2026-08-21T00:30:00+09:00",
            phase = "evening",
            devices = listOf(DesktopState(epoch("2026-08-21T00:30:00+09:00"), "login-required")),
        )
        assertEquals("학습 종료 상태를 확인할 수 없습니다", loginRequired.title)
        assertEquals(
            "04:00 마감까지 3시간 30분 남았습니다. " +
                "PC의 LMS 로그인이 만료되어 출석 상태를 확인할 수 없습니다. LMS에서 직접 확인해 주세요.",
            loginRequired.body,
        )

        val morningDeadline = attendanceRecordAt(
            "2026-08-20T10:05:00+09:00",
            phase = "morning",
            devices = emptyList(),
        )
        val eveningDeadline = attendanceRecordAt(
            "2026-08-21T00:05:00+09:00",
            phase = "evening",
            eveningEndHour = 0,
            devices = emptyList(),
        )
        assertEquals("학습 시작 상태를 확인할 수 없습니다", morningDeadline.title)
        assertEquals("학습 종료 상태를 확인할 수 없습니다", eveningDeadline.title)
        assertNull(
            attendanceRecordAtOrNull(
                "2026-08-21T00:10:00+09:00",
                phase = "evening",
                eveningEndHour = 0,
                devices = emptyList(),
            ),
        )
    }

    @Test
    fun `unavailable morning attendance uses at most first followup and deadline slots`() {
        val records = listOf(
            attendanceRecordAt("2026-08-20T04:00:00+09:00", "morning", morningStartHour = 4, devices = emptyList()),
            attendanceRecordAt("2026-08-20T05:59:00+09:00", "morning", morningStartHour = 4, devices = emptyList()),
            attendanceRecordAt("2026-08-20T06:00:00+09:00", "morning", morningStartHour = 4, devices = emptyList()),
            attendanceRecordAt("2026-08-20T09:59:00+09:00", "morning", morningStartHour = 4, devices = emptyList()),
            attendanceRecordAt("2026-08-20T10:00:00+09:00", "morning", morningStartHour = 4, devices = emptyList()),
            attendanceRecordAt("2026-08-20T10:09:00+09:00", "morning", morningStartHour = 4, devices = emptyList()),
        )

        assertEquals(
            listOf(
                "attendance:2026-08-20:morning:0400",
                "attendance:2026-08-20:morning:0400",
                "attendance:2026-08-20:morning:0600",
                "attendance:2026-08-20:morning:0600",
                "attendance:2026-08-20:morning:1000",
                "attendance:2026-08-20:morning:1000",
            ),
            records.map(NotificationRecord::sourceEventId),
        )
        assertNull(
            attendanceRecordAtOrNull(
                "2026-08-20T10:10:00+09:00",
                "morning",
                morningStartHour = 4,
                devices = emptyList(),
            ),
        )
    }

    @Test
    fun `unavailable evening attendance only uses eleven and midnight slots`() {
        val offlineAtEleven = attendanceRecordAt(
            "2026-08-20T23:30:00+09:00",
            "evening",
            devices = emptyList(),
        )
        val loginRequiredAtMidnight = attendanceRecordAt(
            "2026-08-21T00:30:00+09:00",
            "evening",
            devices = listOf(DesktopState(epoch("2026-08-21T00:30:00+09:00"), "login-required")),
        )
        val loginRequiredAtEleven = attendanceRecordAt(
            "2026-08-20T23:45:00+09:00",
            "evening",
            devices = listOf(DesktopState(epoch("2026-08-20T23:45:00+09:00"), "login-required")),
        )
        val unknownAtEleven = attendanceRecordAt(
            "2026-08-20T23:50:00+09:00",
            "evening",
            devices = listOf(DesktopState(epoch("2026-08-20T23:50:00+09:00"), "unknown")),
        )

        assertEquals("attendance:2026-08-20:evening:2300", offlineAtEleven.sourceEventId)
        assertEquals(offlineAtEleven.sourceEventId, loginRequiredAtEleven.sourceEventId)
        assertEquals(offlineAtEleven.sourceEventId, unknownAtEleven.sourceEventId)
        assertEquals("attendance:2026-08-20:evening:0000", loginRequiredAtMidnight.sourceEventId)
        for (time in listOf("2026-08-21T01:00:00+09:00", "2026-08-21T03:45:00+09:00", "2026-08-21T04:05:00+09:00")) {
            assertNull(attendanceRecordAtOrNull(time, "evening", devices = emptyList()), time)
        }
        assertNull(
            attendanceRecordAtOrNull(
                "2026-08-21T03:45:00+09:00",
                "evening",
                snapshotAgeMinutes = 16,
            ),
        )
    }

    @Test
    fun `connected attendance keeps the configured interval slots`() {
        assertEquals(
            "attendance:2026-08-20:evening:0000",
            attendanceRecordAt(
                "2026-08-21T00:29:00+09:00",
                "evening",
                intervalMinutes = 30,
            ).sourceEventId,
        )
        assertEquals(
            "attendance:2026-08-20:evening:0030",
            attendanceRecordAt(
                "2026-08-21T00:30:00+09:00",
                "evening",
                intervalMinutes = 30,
            ).sourceEventId,
        )
        assertEquals(
            "attendance:2026-08-20:evening:0400",
            attendanceRecordAt("2026-08-21T04:05:00+09:00", "evening").sourceEventId,
        )
        assertEquals(
            "attendance:2026-08-20:evening:0345",
            attendanceRecordAt(
                "2026-08-21T03:45:00+09:00",
                "evening",
                devices = listOf(
                    DesktopState(epoch("2026-08-21T03:45:00+09:00"), "connected"),
                    DesktopState(epoch("2026-08-21T03:45:00+09:00"), "login-required"),
                ),
            ).sourceEventId,
        )
        assertNull(attendanceRecordAtOrNull("2026-08-21T04:10:00+09:00", "evening"))
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

    private fun attendanceRecordAt(
        localTime: String,
        phase: String,
        morningStartHour: Int = 9,
        eveningEndHour: Int = 4,
        devices: List<DesktopState>? = null,
        snapshotAgeMinutes: Long = 0,
        intervalMinutes: Int = 15,
    ): NotificationRecord = checkNotNull(
        attendanceRecordAtOrNull(
            localTime,
            phase,
            morningStartHour,
            eveningEndHour,
            devices,
            snapshotAgeMinutes,
            intervalMinutes,
        ),
    ) { "Expected an attendance notification at $localTime for $phase." }

    private fun attendanceRecordAtOrNull(
        localTime: String,
        phase: String,
        morningStartHour: Int = 9,
        eveningEndHour: Int = 4,
        devices: List<DesktopState>? = null,
        snapshotAgeMinutes: Long = 0,
        intervalMinutes: Int = 15,
    ): NotificationRecord? {
        val now = epoch(localTime)
        val local = Instant.ofEpochMilli(now).atZone(ZoneId.of("Asia/Seoul"))
        val attendanceDate = if (phase == "evening" && local.hour < 23) {
            local.toLocalDate().minusDays(1)
        } else {
            local.toLocalDate()
        }
        val userId = UUID.fromString("00000000-0000-0000-0000-000000000001")
        val candidate = AttendanceCandidate(
            userId = userId,
            morning = phase == "morning",
            evening = phase == "evening",
            morningStartHour = morningStartHour,
            eveningEndHour = eveningEndHour,
            morningIntervalMinutes = intervalMinutes,
            eveningIntervalMinutes = intervalMinutes,
            skipSunday = false,
            skipAttendanceDate = null,
            attendanceDate = attendanceDate.toString(),
            cohortStatus = "active",
            morningChecked = phase == "evening",
            eveningChecked = false,
            collectedAtEpochMs = now - snapshotAgeMinutes * 60_000,
        )
        val automation = mock(AutomationStore::class.java)
        `when`(automation.attendancePreferences()).thenReturn(listOf(candidate))
        `when`(automation.desktopStatesByUser()).thenReturn(
            mapOf(userId to (devices ?: listOf(DesktopState(now, "connected")))),
        )
        val notifications = mock(NotificationStore::class.java)
        val engine = AutomationEngine(
            automation,
            notifications,
            mock(PublicDataStore::class.java),
            mock(PushSender::class.java),
            Clock.fixed(Instant.ofEpochMilli(now), ZoneOffset.UTC),
        )

        engine.planAttendance(now)

        val creation = mockingDetails(notifications).invocations.singleOrNull { it.method.name == "create" }
        return creation?.arguments?.single() as NotificationRecord?
    }

    private fun epoch(value: String): Long = OffsetDateTime.parse(value).toInstant().toEpochMilli()
}
