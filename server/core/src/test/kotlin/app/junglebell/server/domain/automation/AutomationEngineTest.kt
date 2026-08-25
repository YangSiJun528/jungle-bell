package app.junglebell.server.domain.automation

import app.junglebell.server.domain.notification.NotificationRecord
import app.junglebell.server.domain.notification.NotificationStore
import app.junglebell.server.domain.publicapi.LaundryAppliance
import app.junglebell.server.domain.publicapi.LaundryMachine
import app.junglebell.server.domain.publicapi.LaundryVersion
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
        assertEquals(false, decision?.completeWatch)
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
        assertEquals(false, decision?.completeWatch)
        assertNull(
            laundryNotificationDecision(
                watch(mode = "confirmed-completion"),
                appliance(remainingMinutes = 0, estimatedFinishAt = "2026-08-19T10:00:00Z"),
                now,
            ),
        )
    }

    @Test
    fun `laundry estimated completion mode completes the watch at a terminal state`() {
        val decision = laundryNotificationDecision(
            watch(mode = "estimated-completion"),
            appliance(operationalStatus = "IDLE", remainingMinutes = 0, estimatedFinishAt = null),
            Instant.parse("2026-08-19T10:00:00Z").toEpochMilli(),
        )

        assertEquals("laundry-completion-expected", decision?.notification?.kind)
        assertEquals(true, decision?.completeWatch)
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

    @Test
    fun `dryer errors and pauses share one attention notification identity`() {
        val now = Instant.parse("2026-08-19T10:00:00Z").toEpochMilli()
        val dryerWatch = watch(
            mode = "confirmed-completion",
            appliance = "dryer",
            pendingAttentionIncidentId = "incident-1",
        )
        val error = laundryNotificationDecision(
            dryerWatch,
            appliance(
                appliance = "dryer",
                operationalStatus = "ERROR",
                remainingMinutes = 49,
                estimatedFinishAt = null,
                errorCode = "EMPTY_WATER_ALERT_ERROR",
            ),
            now,
        )
        val paused = laundryNotificationDecision(
            dryerWatch,
            appliance(
                appliance = "dryer",
                operationalStatus = "PAUSED",
                remainingMinutes = 49,
                estimatedFinishAt = null,
            ),
            now,
        )
        val repeatedError = laundryNotificationDecision(
            dryerWatch,
            appliance(
                appliance = "dryer",
                operationalStatus = "ERROR",
                remainingMinutes = 44,
                estimatedFinishAt = null,
                errorCode = "EMPTY_WATER_ALERT_ERROR",
                observedAt = "2026-08-19T10:02:00Z",
            ),
            now,
        )
        val doorOpen = laundryNotificationDecision(
            dryerWatch,
            appliance(
                appliance = "dryer",
                operationalStatus = "ERROR",
                remainingMinutes = 44,
                estimatedFinishAt = null,
                errorCode = "DOOR_OPEN_ERROR",
            ),
            now,
        )
        val genericError = laundryNotificationDecision(
            dryerWatch,
            appliance(
                appliance = "dryer",
                operationalStatus = "ERROR",
                remainingMinutes = 44,
                estimatedFinishAt = null,
                errorCode = "UNKNOWN_ERROR",
            ),
            now,
        )
        val nextIncident = laundryNotificationDecision(
            dryerWatch.copy(pendingAttentionIncidentId = "incident-2"),
            appliance(
                appliance = "dryer",
                operationalStatus = "ERROR",
                remainingMinutes = 40,
                estimatedFinishAt = null,
                observedAt = "2026-08-19T10:10:00Z",
            ),
            now,
        )

        assertEquals("laundry-attention", error?.notification?.kind)
        assertEquals("건조기가 멈췄습니다", error?.notification?.title)
        assertEquals("1번 건조기 물통을 비우고 건조 상태를 확인해 주세요.", error?.notification?.body)
        assertEquals("ERROR", error?.notification?.payload?.get("attentionStatus"))
        assertEquals("EMPTY_WATER_ALERT_ERROR", error?.notification?.payload?.get("errorCode"))
        assertEquals(false, error?.completeWatch)
        assertEquals("laundry-attention", paused?.notification?.kind)
        assertEquals("건조기가 일시 정지됐습니다", paused?.notification?.title)
        assertEquals(error?.notification?.sourceEventId, paused?.notification?.sourceEventId)
        assertEquals(error?.notification?.sourceEventId, repeatedError?.notification?.sourceEventId)
        assertEquals(false, error?.notification?.sourceEventId == nextIncident?.notification?.sourceEventId)
        assertEquals("1번 건조기 문을 닫고 건조 상태를 확인해 주세요.", doorOpen?.notification?.body)
        assertEquals(
            "1번 건조기에 오류가 발생했습니다. 건조 상태를 확인해 주세요.",
            genericError?.notification?.body,
        )
        assertEquals(false, paused?.completeWatch)

        for (mode in listOf("before-completion", "estimated-completion", "confirmed-completion")) {
            for (status in listOf("ERROR", "PAUSED")) {
                val decision = laundryNotificationDecision(
                    watch(
                        mode = mode,
                        notifyBeforeMinutes = if (mode == "before-completion") 10 else 0,
                        appliance = "dryer",
                    ),
                    appliance(
                        appliance = "dryer",
                        operationalStatus = status,
                        remainingMinutes = 0,
                        estimatedFinishAt = "2026-08-19T10:00:00Z",
                    ),
                    now,
                )
                assertEquals("laundry-attention", decision?.notification?.kind, "$mode/$status")
                assertEquals(false, decision?.completeWatch, "$mode/$status")
            }
        }
    }

    @Test
    fun `laundry attention only applies to the selected dryer session`() {
        val now = Instant.parse("2026-08-19T10:00:00Z").toEpochMilli()
        assertNull(
            laundryNotificationDecision(
                watch(mode = "confirmed-completion"),
                appliance(operationalStatus = "ERROR", remainingMinutes = 30, estimatedFinishAt = null),
                now,
            ),
        )
        val differentSession = appliance(
            appliance = "dryer",
            operationalStatus = "ERROR",
            remainingMinutes = 30,
            estimatedFinishAt = null,
            sessionId = "session-2",
        )
        assertEquals(
            true,
            laundryWatchShouldCompleteSilently(
                watch(mode = "confirmed-completion", appliance = "dryer"),
                differentSession,
            ),
        )
        for (state in listOf("COOLING", "WRINKLE_CARE")) {
            assertNull(
                laundryNotificationDecision(
                    watch(mode = "confirmed-completion", appliance = "dryer"),
                    appliance(
                        appliance = "dryer",
                        remainingMinutes = 0,
                        estimatedFinishAt = null,
                        stateCode = state,
                    ),
                    now,
                ),
                state,
            )
        }
        assertNull(
            laundryNotificationDecision(
                watch(mode = "confirmed-completion", appliance = "dryer"),
                appliance(
                    appliance = "dryer",
                    operationalStatus = "ERROR",
                    remainingMinutes = 30,
                    estimatedFinishAt = null,
                    sessionId = "session-2",
                ),
                now,
            ),
        )
    }

    @Test
    fun `unresolved dryer attention suppresses idle completion and completes silently`() {
        val watch = watch(
            mode = "confirmed-completion",
            appliance = "dryer",
            attentionUnresolved = true,
        )
        val idle = appliance(
            appliance = "dryer",
            operationalStatus = "IDLE",
            remainingMinutes = 0,
            estimatedFinishAt = null,
        )

        assertNull(
            laundryNotificationDecision(
                watch,
                idle,
                Instant.parse("2026-08-19T10:00:00Z").toEpochMilli(),
            ),
        )
        assertEquals(true, laundryWatchShouldCompleteSilently(watch, idle))
        for (status in listOf("ERROR", "PAUSED")) {
            assertNull(
                laundryNotificationDecision(
                    watch,
                    appliance(
                        appliance = "dryer",
                        operationalStatus = status,
                        remainingMinutes = 30,
                        estimatedFinishAt = null,
                    ),
                    Instant.parse("2026-08-19T10:00:00Z").toEpochMilli(),
                ),
                status,
            )
        }

        val completed = appliance(
            appliance = "dryer",
            operationalStatus = "COMPLETED",
            remainingMinutes = 0,
            estimatedFinishAt = null,
        )
        assertEquals(
            "laundry-completed",
            laundryNotificationDecision(
                watch,
                completed,
                Instant.parse("2026-08-19T10:00:00Z").toEpochMilli(),
            )?.notification?.kind,
        )
    }

    @Test
    fun `unresolved idle attention completes without another notification`() {
        val now = Instant.parse("2026-08-19T10:00:00Z").toEpochMilli()
        val automation = mock(AutomationStore::class.java)
        val notifications = mock(NotificationStore::class.java)
        val publicData = mock(PublicDataStore::class.java)
        val idle = appliance(
            appliance = "dryer",
            operationalStatus = "IDLE",
            remainingMinutes = 0,
            estimatedFinishAt = null,
        )
        `when`(automation.activeLaundryWatches()).thenReturn(
            listOf(
                watch(
                    mode = "confirmed-completion",
                    appliance = "dryer",
                    attentionUnresolved = true,
                ),
            ),
        )
        `when`(publicData.latestLaundryVersion()).thenReturn(
            LaundryVersion(
                sourceVersionSha = "sha",
                observedAt = idle.observedAt,
                machines = listOf(LaundryMachine("워시타워_1", null, idle)),
                events = emptyList(),
                unknownEnums = emptyList(),
            ),
        )
        val engine = AutomationEngine(
            automation,
            notifications,
            publicData,
            mock(PushSender::class.java),
            Clock.fixed(Instant.ofEpochMilli(now), ZoneOffset.UTC),
        )

        assertEquals(0, engine.applyLaundryWatches(now))
        verify(automation).completeLaundryWatch("watch-1", now)
        assertEquals(
            emptyList(),
            mockingDetails(notifications).invocations.filter { it.method.name == "createFromLaundryWatch" },
        )
    }

    @Test
    fun `an error or pause transition immediately followed by idle still emits attention`() {
        val now = Instant.parse("2026-08-19T10:00:00Z").toEpochMilli()
        val cases = listOf("ERROR", "PAUSED")

        for (expectedStatus in cases) {
            val automation = mock(AutomationStore::class.java)
            val notifications = mock(NotificationStore::class.java)
            val publicData = mock(PublicDataStore::class.java)
            val idle = appliance(
                appliance = "dryer",
                operationalStatus = "IDLE",
                remainingMinutes = 0,
                estimatedFinishAt = null,
                sessionId = if (expectedStatus == "ERROR") "stale-session" else "session-1",
            )
            `when`(automation.activeLaundryWatches()).thenReturn(
                listOf(
                    watch(
                        mode = "confirmed-completion",
                        appliance = "dryer",
                        pendingAttentionStatus = expectedStatus,
                    ),
                ),
            )
            `when`(publicData.latestLaundryVersion()).thenReturn(
                LaundryVersion(
                    sourceVersionSha = "sha-$expectedStatus",
                    observedAt = idle.observedAt,
                    machines = listOf(LaundryMachine("워시타워_1", null, idle)),
                    events = emptyList(),
                    unknownEnums = emptyList(),
                ),
            )
            val engine = AutomationEngine(
                automation,
                notifications,
                publicData,
                mock(PushSender::class.java),
                Clock.fixed(Instant.ofEpochMilli(now), ZoneOffset.UTC),
            )

            assertEquals(0, engine.applyLaundryWatches(now))
            val notification = mockingDetails(notifications).invocations
                .single { it.method.name == "createFromLaundryWatch" }
                .arguments[0] as NotificationRecord
            assertEquals("laundry-attention", notification.kind, expectedStatus)
            assertEquals(expectedStatus, notification.payload["attentionStatus"], expectedStatus)
            assertEquals(
                emptyList(),
                mockingDetails(automation).invocations.filter { it.method.name == "completeLaundryWatch" },
            )
        }
    }

    @Test
    fun `idle transition attention rejects unrelated or normal stop events`() {
        val dryerWatch = watch(
            mode = "confirmed-completion",
            appliance = "dryer",
            pendingAttentionStatus = "ERROR",
        )
        val idle = appliance(
            appliance = "dryer",
            operationalStatus = "IDLE",
            remainingMinutes = 0,
            estimatedFinishAt = null,
        )
        assertEquals("ERROR", laundryTransitionAttentionStatus(dryerWatch, idle))
        assertEquals(
            "PAUSED",
            laundryTransitionAttentionStatus(
                dryerWatch.copy(pendingAttentionStatus = "PAUSED"),
                idle,
            ),
        )
        assertNull(
            laundryTransitionAttentionStatus(
                dryerWatch.copy(pendingAttentionStatus = null),
                idle,
            ),
        )
        assertEquals(
            "ERROR",
            laundryTransitionAttentionStatus(
                dryerWatch,
                idle.copy(sessionId = "session-2"),
            ),
        )
        assertNull(
            laundryTransitionAttentionStatus(
                dryerWatch.copy(attentionUnresolved = true),
                idle,
            ),
        )
        assertNull(
            laundryTransitionAttentionStatus(
                dryerWatch,
                appliance(
                    appliance = "dryer",
                    operationalStatus = "RUNNING",
                    remainingMinutes = 30,
                    estimatedFinishAt = "2026-08-19T10:30:00Z",
                ),
            ),
        )
        for (status in listOf("RUNNING", "COMPLETED")) {
            assertEquals(
                "ERROR",
                laundryTransitionAttentionStatus(
                    dryerWatch,
                    appliance(
                        appliance = "dryer",
                        operationalStatus = status,
                        remainingMinutes = if (status == "RUNNING") 30 else 0,
                        estimatedFinishAt = if (status == "RUNNING") "2026-08-19T10:30:00Z" else null,
                        sessionId = "replacement-session",
                    ),
                ),
                status,
            )
        }
    }

    @Test
    fun `durable attention does not use an unrelated snapshot error copy`() {
        val watch = watch(
            mode = "confirmed-completion",
            appliance = "dryer",
            pendingAttentionStatus = "PAUSED",
        )
        val staleError = appliance(
            appliance = "dryer",
            operationalStatus = "ERROR",
            remainingMinutes = 30,
            estimatedFinishAt = null,
            errorCode = "DOOR_OPEN_ERROR",
            sessionId = "different-session",
        )
        val transitionStatus = laundryTransitionAttentionStatus(watch, staleError)
        val decision = laundryNotificationDecision(
            watch,
            staleError,
            Instant.parse("2026-08-19T10:00:00Z").toEpochMilli(),
            transitionStatus,
        )

        assertEquals("건조기가 일시 정지됐습니다", decision?.notification?.title)
        assertEquals(null, decision?.notification?.payload?.get("errorCode"))
        assertEquals(null, decision?.notification?.payload?.get("remainingMinutes"))
    }

    @Test
    fun `running after attention marks the watch resumed`() {
        val now = Instant.parse("2026-08-19T10:00:00Z").toEpochMilli()
        val automation = mock(AutomationStore::class.java)
        val notifications = mock(NotificationStore::class.java)
        val publicData = mock(PublicDataStore::class.java)
        val dryer = appliance(
            appliance = "dryer",
            operationalStatus = "RUNNING",
            remainingMinutes = 30,
            estimatedFinishAt = "2026-08-19T10:30:00Z",
        )
        `when`(automation.activeLaundryWatches()).thenReturn(
            listOf(
                watch(
                    mode = "confirmed-completion",
                    appliance = "dryer",
                    attentionUnresolved = true,
                ),
            ),
        )
        `when`(publicData.latestLaundryVersion()).thenReturn(
            LaundryVersion(
                sourceVersionSha = "sha",
                observedAt = dryer.observedAt,
                machines = listOf(LaundryMachine("워시타워_1", null, dryer)),
                events = emptyList(),
                unknownEnums = emptyList(),
            ),
        )
        val engine = AutomationEngine(
            automation,
            notifications,
            publicData,
            mock(PushSender::class.java),
            Clock.fixed(Instant.ofEpochMilli(now), ZoneOffset.UTC),
        )

        assertEquals(0, engine.applyLaundryWatches(now))
        verify(automation).markLaundryWatchResumed("watch-1", now)
    }

    @Test
    fun `a durable recovery restores terminal notifications after attention`() {
        val now = Instant.parse("2026-08-19T10:00:00Z").toEpochMilli()
        for ((mode, expectedKind) in listOf(
            "confirmed-completion" to "laundry-completed",
            "estimated-completion" to "laundry-completion-expected",
        )) {
            val automation = mock(AutomationStore::class.java)
            val notifications = mock(NotificationStore::class.java)
            val publicData = mock(PublicDataStore::class.java)
            val idle = appliance(
                appliance = "dryer",
                operationalStatus = "IDLE",
                remainingMinutes = 0,
                estimatedFinishAt = null,
            )
            `when`(automation.activeLaundryWatches()).thenReturn(
                listOf(
                    watch(
                        mode = mode,
                        appliance = "dryer",
                        attentionUnresolved = true,
                        attentionRecovered = true,
                    ),
                ),
            )
            `when`(publicData.latestLaundryVersion()).thenReturn(
                LaundryVersion(
                    sourceVersionSha = "sha-$mode",
                    observedAt = idle.observedAt,
                    machines = listOf(LaundryMachine("워시타워_1", null, idle)),
                    events = emptyList(),
                    unknownEnums = emptyList(),
                ),
            )
            val engine = AutomationEngine(
                automation,
                notifications,
                publicData,
                mock(PushSender::class.java),
                Clock.fixed(Instant.ofEpochMilli(now), ZoneOffset.UTC),
            )

            assertEquals(0, engine.applyLaundryWatches(now))
            verify(automation).markLaundryWatchResumed("watch-1", now)
            val invocation = mockingDetails(notifications).invocations
                .single { it.method.name == "createFromLaundryWatch" }
            assertEquals(expectedKind, (invocation.arguments[0] as NotificationRecord).kind, mode)
            assertEquals(true, invocation.arguments[2], mode)
        }
    }

    private fun watch(
        mode: String,
        notifyBeforeMinutes: Int = 0,
        appliance: String = "washer",
        attentionUnresolved: Boolean = false,
        attentionUnresolvedAtEpochMs: Long? = null,
        pendingAttentionStatus: String? = null,
        pendingAttentionIncidentId: String? = null,
        attentionRecovered: Boolean = false,
    ) = ActiveLaundryWatch(
        id = "watch-1",
        userId = UUID.fromString("00000000-0000-0000-0000-000000000001"),
        machineId = "워시타워_1",
        appliance = appliance,
        sessionId = "session-1",
        notificationMode = mode,
        notifyBeforeMinutes = notifyBeforeMinutes,
        attentionUnresolved = attentionUnresolved,
        attentionUnresolvedAtEpochMs = attentionUnresolvedAtEpochMs,
        pendingAttentionStatus = pendingAttentionStatus,
        pendingAttentionIncidentId = pendingAttentionIncidentId,
        attentionRecovered = attentionRecovered,
    )

    private fun appliance(
        appliance: String = "washer",
        operationalStatus: String = "RUNNING",
        remainingMinutes: Int,
        estimatedFinishAt: String?,
        errorCode: String? = null,
        sessionId: String = "session-1",
        observedAt: String = "2026-08-19T09:52:00Z",
        stateCode: String = when (operationalStatus) {
            "ERROR" -> "ERROR"
            "PAUSED" -> "PAUSE"
            "COMPLETED" -> "END"
            "IDLE" -> "POWER_OFF"
            else -> if (appliance == "washer") "WASHING" else "RUNNING"
        },
    ) = LaundryAppliance(
        machineId = "워시타워_1",
        appliance = appliance,
        observedAt = observedAt,
        state = NormalizedEnum(stateCode, null, true),
        operationalStatus = operationalStatus,
        remainingMinutes = remainingMinutes,
        totalMinutes = 60,
        startedAt = "2026-08-19T09:00:00Z",
        estimatedFinishAt = estimatedFinishAt,
        remoteControlEnabled = null,
        cycleCount = null,
        sessionId = sessionId,
        errorCode = errorCode,
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
