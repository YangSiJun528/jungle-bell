package app.junglebell.server.domain.automation

import kotlin.test.Test
import kotlin.test.assertEquals

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
}
