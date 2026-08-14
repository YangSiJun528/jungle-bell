package app.junglebell.server.domain.automation

import app.junglebell.server.domain.notification.NotificationRecord
import app.junglebell.server.domain.notification.NotificationStore
import app.junglebell.server.domain.publicapi.LaundryAppliance
import app.junglebell.server.domain.publicapi.PublicDataStore
import org.slf4j.LoggerFactory
import java.time.Clock
import java.time.DayOfWeek
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID

class AutomationEngine(
    private val automation: AutomationStore,
    private val notifications: NotificationStore,
    private val publicData: PublicDataStore,
    private val pushSender: PushSender,
    private val clock: Clock,
) {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val kst = ZoneId.of("Asia/Seoul")

    fun runMinuteCycle() {
        val now = clock.millis()
        val lease = UUID.randomUUID().toString()
        val acquired = automation.tryAcquireLease("minute-automation", now, 50_000, lease)
        if (!acquired) return

        runStage("attendance") { planAttendance(now) }
        runStage("meals") { publishMeals(now) }
        runStage("laundry") { applyLaundryWatches(now) }
        runStage("push") { deliverPushes(now) }
    }

    fun runHousekeeping() {
        val now = clock.millis()
        val lease = UUID.randomUUID().toString()
        val result = automation.runHousekeepingIfDue("hourly-housekeeping", now, 55 * 60_000, lease)
        if (result != null) logger.info("Housekeeping completed: {}", result)
    }

    internal fun planAttendance(now: Long): Int {
        var created = 0
        for (candidate in automation.attendancePreferences()) {
            for (phase in listOf("morning", "evening")) {
                val window = attendanceWindow(candidate, phase, now) ?: continue
                if (candidate.skipAttendanceDate == window.attendanceDate.toString()) continue
                if (candidate.skipSunday && window.attendanceDate.dayOfWeek == DayOfWeek.SUNDAY) continue
                if (attendanceAlreadyHandled(candidate, phase, window, now)) continue
                val reason = attendanceFallbackReason(candidate.userId, now)
                val record = attendanceNotification(candidate.userId, phase, window, reason, now)
                if (notifications.create(record)) created += 1
            }
        }
        return created
    }

    internal fun publishMeals(now: Long): Int {
        val cutoff = Instant.ofEpochMilli(now).minus(Duration.ofHours(12))
        var created = 0
        for (post in automation.recentMealPublications(cutoff)) {
            val period = mealPeriod(post.title) ?: continue
            val serviceDate = mealServiceDate(post)
            val preview = post.body.replace(Regex("\\s+"), " ").trim().let {
                if (it.length <= 160) it else "${it.take(157)}..."
            }.ifBlank { "메뉴 내용을 확인해 주세요." }
            val label = if (period == "lunch") "중식" else "석식"
            for (userId in automation.mealSubscriberUserIds(period)) {
                val id = UUID.randomUUID()
                val record = NotificationRecord(
                    id = id,
                    userId = userId,
                    sourceEventId = "meal:$serviceDate:$period:${post.contentSha}",
                    kind = "meal-published",
                    title = "오늘 ${label}이 올라왔어요",
                    body = preview,
                    path = "/dashboard.html#meals",
                    payload = mapOf(
                        "notificationId" to id.toString(),
                        "kind" to "meal-published",
                        "title" to "오늘 ${label}이 올라왔어요",
                        "body" to preview,
                        "path" to "/dashboard.html#meals",
                        "createdAtEpochMs" to now,
                        "expiresAtEpochMs" to post.contentFirstSeenAt.plus(Duration.ofHours(12)).toEpochMilli(),
                        "meal" to period,
                        "serviceDate" to serviceDate.toString(),
                        "contentSha" to post.contentSha,
                    ),
                    createdAtEpochMs = now,
                    dueAtEpochMs = now,
                    expiresAtEpochMs = post.contentFirstSeenAt.plus(Duration.ofHours(12)).toEpochMilli(),
                )
                if (record.expiresAtEpochMs > now &&
                    notifications.create(record)
                ) created += 1
            }
        }
        return created
    }

    internal fun applyLaundryWatches(now: Long): Int {
        val version = publicData.latestLaundryVersion() ?: return 0
        val appliances = version.machines.flatMap { machine -> listOfNotNull(machine.washer, machine.dryer) }
            .associateBy { "${it.machineId}:${it.appliance}" }
        var created = 0
        for (watch in automation.activeLaundryWatches()) {
            val appliance = appliances["${watch.machineId}:${watch.appliance}"] ?: continue
            val decision = laundryDecision(watch, appliance, now) ?: continue
            val inserted = notifications.createFromLaundryWatch(
                decision.notification,
                watch.id,
                decision.completeWatch,
                now,
            )
            if (inserted) created += 1
        }
        return created
    }

    internal fun deliverPushes(now: Long): Int {
        if (!pushSender.configured) return 0
        val lease = UUID.randomUUID().toString()
        val deliveries = automation.claimPushDeliveries(now, lease, 50)
        var delivered = 0
        for (delivery in deliveries) {
            val result = pushSender.send(delivery, now)
            val attempts = delivery.attempts + 1
            val nextAttempt = if (result.status == "retry" && attempts < 5 && delivery.expiresAtEpochMs > now) {
                now + minOf(15 * 60_000L, 30_000L shl minOf(attempts - 1, 5))
            } else null
            val finalStatus = when {
                result.status == "delivered" -> "delivered"
                result.status == "gone" -> "gone"
                nextAttempt != null -> "retry"
                else -> "failed"
            }
            automation.settlePush(delivery, lease, finalStatus, now, nextAttempt, result.error)
            if (finalStatus == "delivered") delivered += 1
        }
        return delivered
    }

    private fun attendanceAlreadyHandled(
        candidate: AttendanceCandidate,
        phase: String,
        window: AttendanceWindow,
        now: Long,
    ): Boolean {
        if (candidate.attendanceDate != window.attendanceDate.toString()) return false
        if (phase == "morning" && candidate.morningChecked == true) return true
        if (phase == "evening" && candidate.eveningChecked == true) return true
        val fresh = candidate.collectedAtEpochMs?.let { now - it in 0..Duration.ofMinutes(15).toMillis() } == true
        return fresh && candidate.cohortStatus in setOf("upcoming", "ended", "none")
    }

    private fun attendanceFallbackReason(userId: UUID, now: Long): String? {
        val devices = automation.desktopStates(userId)
        val recent = devices.filter { device ->
            device.lastSeenAtEpochMs?.let { now - it in 0..Duration.ofMinutes(10).toMillis() } == true
        }
        return when {
            recent.isEmpty() -> "desktop-offline"
            recent.all { it.lmsSessionState != "connected" } && recent.any { it.lmsSessionState == "login-required" } ->
                "login-required"
            else -> null
        }
    }

    private fun attendanceNotification(
        userId: UUID,
        phase: String,
        window: AttendanceWindow,
        fallbackReason: String?,
        now: Long,
    ): NotificationRecord {
        val id = UUID.randomUUID()
        val label = if (phase == "morning") "입실" else "퇴실"
        val title = if (window.deadline) "$label 체크 마감" else "$label 체크가 필요합니다"
        val body = when (fallbackReason) {
            "desktop-offline" -> "PC가 연결되지 않아 출석 상태를 확인할 수 없습니다. LMS에서 직접 확인해 주세요."
            "login-required" -> "PC의 LMS 로그인이 만료되어 출석 상태를 확인할 수 없습니다."
            else -> "$label 여부를 LMS에서 확인해 주세요."
        }
        return NotificationRecord(
            id,
            userId,
            "attendance:${window.attendanceDate}:$phase:${window.slot}",
            "attendance-$phase",
            title,
            body,
            "/dashboard.html#attendance",
            mapOf(
                "notificationId" to id.toString(),
                "kind" to "attendance-$phase",
                "title" to title,
                "body" to body,
                "path" to "/dashboard.html#attendance",
                "createdAtEpochMs" to now,
                "expiresAtEpochMs" to window.endsAtEpochMs,
                "attendanceDate" to window.attendanceDate.toString(),
                "phase" to phase,
                "fallbackReason" to fallbackReason,
            ),
            now,
            window.dueAtEpochMs,
            window.endsAtEpochMs,
        )
    }

    private fun attendanceWindow(candidate: AttendanceCandidate, phase: String, now: Long): AttendanceWindow? {
        val local = Instant.ofEpochMilli(now).atZone(kst)
        return if (phase == "morning") {
            if (!candidate.morning) return null
            val start = local.toLocalDate().atTime(candidate.morningStartHour, 0).atZone(kst)
            val deadline = local.toLocalDate().atTime(10, 0).atZone(kst)
            alignedWindow(local, start, deadline, candidate.morningIntervalMinutes, local.toLocalDate(), phase)
        } else {
            if (!candidate.evening) return null
            val attendanceDate = if (local.hour >= 23) local.toLocalDate() else local.toLocalDate().minusDays(1)
            val start = attendanceDate.atTime(23, 0).atZone(kst)
            val deadline = attendanceDate.plusDays(1).atTime(candidate.eveningEndHour, 0).atZone(kst)
            alignedWindow(local, start, deadline, candidate.eveningIntervalMinutes, attendanceDate, phase)
        }
    }

    private fun alignedWindow(
        now: ZonedDateTime,
        start: ZonedDateTime,
        deadline: ZonedDateTime,
        intervalMinutes: Int,
        attendanceDate: LocalDate,
        phase: String,
    ): AttendanceWindow? {
        val graceEnd = deadline.plusMinutes(10)
        if (now.isBefore(start) || !now.isBefore(graceEnd)) return null
        val deadlineSlot = !now.isBefore(deadline)
        val due = if (deadlineSlot) deadline else {
            val elapsed = Duration.between(start, now).toMinutes()
            start.plusMinutes(elapsed / intervalMinutes * intervalMinutes.toLong())
        }
        val ends = if (deadlineSlot) graceEnd else minOf(due.plusMinutes(intervalMinutes.toLong()), deadline)
        return AttendanceWindow(
            attendanceDate,
            phase,
            "%02d%02d".format(due.hour, due.minute),
            deadlineSlot,
            due.toInstant().toEpochMilli(),
            ends.toInstant().toEpochMilli(),
        )
    }

    private fun mealPeriod(title: String?): String? = when {
        title?.contains(Regex("중식|점심")) == true -> "lunch"
        title?.contains(Regex("석식|저녁")) == true -> "dinner"
        else -> null
    }

    private fun mealServiceDate(post: MealPublication): LocalDate {
        val reference = (post.publishedAt ?: post.updatedAt ?: post.firstSeenAt).atZone(kst).toLocalDate()
        val match = Regex("(?:(\\d{4})년\\s*)?(\\d{1,2})월\\s*(\\d{1,2})일")
            .find(post.title.orEmpty())
        if (match != null) {
            return runCatching {
                LocalDate.of(
                    match.groupValues[1].takeIf(String::isNotEmpty)?.toInt() ?: reference.year,
                    match.groupValues[2].toInt(),
                    match.groupValues[3].toInt(),
                )
            }.getOrDefault(reference)
        }
        return reference
    }

    private fun laundryDecision(
        watch: ActiveLaundryWatch,
        appliance: LaundryAppliance,
        now: Long,
    ): LaundryDecision? {
        val sessionMatches = watch.sessionId == null || watch.sessionId == appliance.sessionId
        val machine = Regex("\\d+$").find(watch.machineId)?.value?.let { "${it}번" } ?: watch.machineId
        val device = if (watch.appliance == "washer") "세탁기" else "건조기"
        val action = if (watch.appliance == "washer") "세탁" else "건조"
        val kind: String
        val title: String
        val body: String
        val suffix: String
        val complete: Boolean
        when {
            watch.notifyWhenAvailable && watch.sessionId == null && appliance.operationalStatus == "IDLE" -> {
                kind = "laundry-available"
                title = "$device 사용 가능"
                body = "$machine $device\uB97C 사용할 수 있습니다."
                suffix = "available:${appliance.observedAt}"
                complete = true
            }
            sessionMatches && watch.sessionId != null && appliance.operationalStatus in setOf("COMPLETED", "IDLE") -> {
                kind = "laundry-completed"
                title = "$action 완료"
                body = "$machine $device\uAC00 끝났습니다. 세탁물을 꺼내 주세요."
                suffix = "terminal"
                complete = true
            }
            sessionMatches && watch.sessionId != null && appliance.operationalStatus in setOf("ERROR", "PAUSED") -> {
                kind = "laundry-attention"
                title = "$action ${if (appliance.operationalStatus == "ERROR") "오류" else "일시 정지"}"
                body = "$machine $device 상태를 확인해 주세요."
                suffix = appliance.operationalStatus
                complete = false
            }
            sessionMatches && watch.sessionId != null && appliance.operationalStatus == "RUNNING" &&
                appliance.remainingMinutes in 1..watch.notifyBeforeMinutes -> {
                kind = "laundry-finishing"
                title = "$action 종료 ${watch.notifyBeforeMinutes}분 전"
                body = "$machine $device\uAC00 곧 끝납니다."
                suffix = watch.notifyBeforeMinutes.toString()
                complete = false
            }
            watch.sessionId != null && appliance.sessionId != null && watch.sessionId != appliance.sessionId -> {
                automation.completeLaundryWatch(watch.id, now)
                return null
            }
            else -> return null
        }
        val id = UUID.randomUUID()
        val expiresAt = now + if (kind == "laundry-finishing") Duration.ofHours(2).toMillis() else Duration.ofHours(6).toMillis()
        val sourceEventId = "$kind:${watch.id}:${appliance.sessionId ?: "none"}:$suffix"
        return LaundryDecision(
            NotificationRecord(
                id,
                watch.userId,
                sourceEventId,
                kind,
                title,
                body,
                "/dashboard.html#laundry",
                mapOf(
                    "notificationId" to id.toString(),
                    "kind" to kind,
                    "title" to title,
                    "body" to body,
                    "path" to "/dashboard.html#laundry",
                    "machineId" to watch.machineId,
                    "appliance" to watch.appliance,
                    "sessionId" to appliance.sessionId,
                    "createdAtEpochMs" to now,
                    "expiresAtEpochMs" to expiresAt,
                ),
                now,
                now,
                expiresAt,
            ),
            complete,
        )
    }

    private inline fun runStage(name: String, operation: () -> Int) {
        runCatching(operation)
            .onSuccess { count -> if (count > 0) logger.info("{} created or delivered {} item(s)", name, count) }
            .onFailure { error -> logger.error("{} automation failed", name, error) }
    }
}

data class AttendanceWindow(
    val attendanceDate: LocalDate,
    val phase: String,
    val slot: String,
    val deadline: Boolean,
    val dueAtEpochMs: Long,
    val endsAtEpochMs: Long,
)

private data class LaundryDecision(val notification: NotificationRecord, val completeWatch: Boolean)
