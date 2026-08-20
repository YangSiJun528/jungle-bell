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

private const val MINUTE_MILLIS = 60_000L
private val ATTENDANCE_TIME_ZONE = ZoneId.of("Asia/Seoul")

internal data class AttendanceNotificationCopy(
    val kind: String,
    val title: String,
    val body: String,
)

internal data class AttendanceNotificationTiming(
    val deadlineAtEpochMs: Long,
    val countdownTargetEpochMs: Long?,
    val remainingMinutes: Long?,
)

internal fun attendanceRemainingMinutes(nowEpochMs: Long, targetEpochMs: Long): Long? {
    val remainingMillis = targetEpochMs - nowEpochMs
    if (remainingMillis <= 0) return null
    return remainingMillis / MINUTE_MILLIS + if (remainingMillis % MINUTE_MILLIS == 0L) 0 else 1
}

internal fun attendanceNotificationTiming(
    phase: String,
    deadline: Boolean,
    deadlineAtEpochMs: Long,
    endsAtEpochMs: Long,
    nowEpochMs: Long,
): AttendanceNotificationTiming {
    val countdownTargetEpochMs = when {
        !deadline -> deadlineAtEpochMs
        phase == "morning" -> endsAtEpochMs
        else -> null
    }
    return AttendanceNotificationTiming(
        deadlineAtEpochMs = deadlineAtEpochMs,
        countdownTargetEpochMs = countdownTargetEpochMs,
        remainingMinutes = countdownTargetEpochMs?.let { attendanceRemainingMinutes(nowEpochMs, it) },
    )
}

private fun attendanceTimeLabel(epochMs: Long): String {
    val time = Instant.ofEpochMilli(epochMs).atZone(ATTENDANCE_TIME_ZONE)
    return "%02d:%02d".format(time.hour, time.minute)
}

private fun attendanceRemainingLabel(minutes: Long): String {
    require(minutes > 0) { "Remaining attendance minutes must be positive." }
    if (minutes < 60) return "${minutes}분"
    val hours = minutes / 60
    val remainder = minutes % 60
    return if (remainder == 0L) "${hours}시간" else "${hours}시간 ${remainder}분"
}

internal fun attendanceNotificationCopy(
    phase: String,
    deadline: Boolean,
    fallbackReason: String?,
    timing: AttendanceNotificationTiming,
): AttendanceNotificationCopy {
    val label = when (phase) {
        "morning" -> "학습 시작"
        "evening" -> "학습 종료"
        else -> error("Unsupported attendance phase: $phase")
    }
    val morningGrace = phase == "morning" && deadline && timing.remainingMinutes != null
    val title = when {
        morningGrace -> "학습 시작 체크 지각 임박"
        deadline -> "$label 체크 마감"
        else -> "$label 체크가 필요합니다"
    }
    val timingBody = when {
        timing.countdownTargetEpochMs != null && timing.remainingMinutes != null -> {
            val deadlineKind = if (morningGrace) "최종 마감" else "마감"
            "${attendanceTimeLabel(timing.countdownTargetEpochMs)} ${deadlineKind}까지 " +
                "${attendanceRemainingLabel(timing.remainingMinutes)} 남았습니다."
        }
        deadline -> "${attendanceTimeLabel(timing.deadlineAtEpochMs)} 마감 시각이 지났습니다."
        else -> "$label 여부를 LMS에서 확인해 주세요."
    }
    val guidance = when (fallbackReason) {
        "desktop-offline" -> "PC가 연결되지 않아 출석 상태를 확인할 수 없습니다. LMS에서 직접 확인해 주세요."
        "login-required" ->
            "PC의 LMS 로그인이 만료되어 출석 상태를 확인할 수 없습니다. LMS에서 직접 확인해 주세요."
        else -> if (deadline && timing.remainingMinutes == null) "지금 LMS에서 확인해 주세요." else null
    }
    val body = listOfNotNull(timingBody, guidance).joinToString(" ")
    return AttendanceNotificationCopy("attendance-action-required", title, body)
}

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
        logger.info("Minute automation started.")
        val now = clock.millis()
        val lease = UUID.randomUUID().toString()
        val acquired = automation.tryAcquireLease("minute-automation", now, 50_000, lease)
        if (!acquired) {
            logger.debug("Minute automation skipped. reason=lease_not_acquired")
            return
        }

        val failedStageCount = listOf(
            runStage("attendance") { planAttendance(now) },
            runStage("meals") { publishMeals(now) },
            runStage("laundry") { applyLaundryWatches(now) },
        ).count { !it }
        logger.info("Minute automation completed. failedStageCount={}", failedStageCount)
    }

    fun runPushCycle() {
        runStage("push") { deliverPushes(clock.millis()) }
    }

    fun runHousekeeping() {
        logger.info("Housekeeping started.")
        val now = clock.millis()
        val lease = UUID.randomUUID().toString()
        val result = automation.runHousekeepingIfDue("hourly-housekeeping", now, 55 * 60_000, lease)
        if (result == null) {
            logger.debug("Housekeeping skipped. reason=lease_not_acquired")
            return
        }
        logger.info(
            "Housekeeping completed. desktopUiSessions={} pairingChallenges={} enrollmentAttempts={} " +
                "notifications={} mealAssets={}",
            result["desktopUiSessions"],
            result["pairingChallenges"],
            result["enrollmentAttempts"],
            result["notifications"],
            result["mealAssets"],
        )
    }

    internal fun planAttendance(now: Long): Int {
        var created = 0
        val desktopStates = automation.desktopStatesByUser()
        for (candidate in automation.attendancePreferences()) {
            for (phase in listOf("morning", "evening")) {
                val window = attendanceWindow(candidate, phase, now) ?: continue
                if (candidate.skipAttendanceDate == window.attendanceDate.toString()) continue
                if (candidate.skipSunday && window.attendanceDate.dayOfWeek == DayOfWeek.SUNDAY) continue
                if (attendanceAlreadyHandled(candidate, phase, window, now)) continue
                val reason = attendanceFallbackReason(desktopStates[candidate.userId].orEmpty(), now)
                val record = attendanceNotification(candidate.userId, phase, window, reason, now)
                if (notifications.create(record)) created += 1
            }
        }
        return created
    }

    internal fun publishMeals(now: Long): Int {
        val cutoff = Instant.ofEpochMilli(now).minus(Duration.ofHours(12))
        var created = 0
        val subscribers = mutableMapOf<String, List<UUID>>()
        for (post in automation.recentMealPublications(cutoff)) {
            val period = mealPeriod(post.title) ?: continue
            val serviceDate = mealServiceDate(post)
            val preview = post.body.replace(Regex("\\s+"), " ").trim().let {
                if (it.length <= 160) it else "${it.take(157)}..."
            }.ifBlank { "메뉴 내용을 확인해 주세요." }
            val label = if (period == "lunch") "중식" else "석식"
            for (userId in subscribers.getOrPut(period) { automation.mealSubscriberUserIds(period) }) {
                val id = UUID.randomUUID()
                val record = NotificationRecord(
                    id = id,
                    userId = userId,
                    sourceEventId = "meal:$serviceDate:$period:${post.contentSha}",
                    kind = "meal-published",
                    title = "오늘 ${label}이 올라왔어요",
                    body = preview,
                    path = "/#/meals",
                    payload = mapOf(
                        "notificationId" to id.toString(),
                        "kind" to "meal-published",
                        "title" to "오늘 ${label}이 올라왔어요",
                        "body" to preview,
                        "path" to "/#/meals",
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
            val decision = laundryNotificationDecision(watch, appliance, now)
            if (decision == null) {
                if (laundryWatchShouldCompleteSilently(watch, appliance)) {
                    automation.completeLaundryWatch(watch.id, now)
                }
                continue
            }
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

    private fun attendanceFallbackReason(devices: List<DesktopState>, now: Long): String? {
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
        val timing = attendanceNotificationTiming(
            phase = phase,
            deadline = window.deadline,
            deadlineAtEpochMs = window.deadlineAtEpochMs,
            endsAtEpochMs = window.endsAtEpochMs,
            nowEpochMs = now,
        )
        val copy = attendanceNotificationCopy(phase, window.deadline, fallbackReason, timing)
        return NotificationRecord(
            id,
            userId,
            "attendance:${window.attendanceDate}:$phase:${window.slot}",
            copy.kind,
            copy.title,
            copy.body,
            "/#/attendance",
            mapOf(
                "notificationId" to id.toString(),
                "kind" to copy.kind,
                "title" to copy.title,
                "body" to copy.body,
                "path" to "/#/attendance",
                "createdAtEpochMs" to now,
                "expiresAtEpochMs" to window.endsAtEpochMs,
                "attendanceDate" to window.attendanceDate.toString(),
                "phase" to phase,
                "fallbackReason" to fallbackReason,
                "deadlineAtEpochMs" to timing.deadlineAtEpochMs,
                "countdownTargetEpochMs" to timing.countdownTargetEpochMs,
                "remainingMinutes" to timing.remainingMinutes,
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
            attendanceDate = attendanceDate,
            phase = phase,
            slot = "%02d%02d".format(due.hour, due.minute),
            deadline = deadlineSlot,
            deadlineAtEpochMs = deadline.toInstant().toEpochMilli(),
            dueAtEpochMs = due.toInstant().toEpochMilli(),
            endsAtEpochMs = ends.toInstant().toEpochMilli(),
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

    private inline fun runStage(name: String, operation: () -> Int): Boolean {
        logger.debug("Automation stage started. stage={}", name)
        return try {
            val count = operation()
            if (count > 0) {
                logger.info("Automation stage completed. stage={} resultCount={}", name, count)
            } else {
                logger.debug("Automation stage completed. stage={} resultCount=0", name)
            }
            true
        } catch (error: Exception) {
            logger.error("Automation stage failed. stage={}", name, error)
            false
        }
    }
}

data class AttendanceWindow(
    val attendanceDate: LocalDate,
    val phase: String,
    val slot: String,
    val deadline: Boolean,
    val deadlineAtEpochMs: Long,
    val dueAtEpochMs: Long,
    val endsAtEpochMs: Long,
)

internal data class LaundryDecision(val notification: NotificationRecord, val completeWatch: Boolean)

internal fun laundryNotificationDecision(
    watch: ActiveLaundryWatch,
    appliance: LaundryAppliance,
    now: Long,
): LaundryDecision? {
    val terminal = appliance.operationalStatus in setOf("COMPLETED", "IDLE") ||
        appliance.projection?.status == "CONFIRMED_COMPLETED"
    val sessionMatches = watch.sessionId == appliance.sessionId || watch.sessionId == null && terminal
    if (!sessionMatches) return null

    val remainingMinutes = projectedRemainingMinutes(appliance, now)
    val estimatedCompletionReached = appliance.projection?.status == "AWAITING_COMPLETION_CONFIRMATION" ||
        appliance.operationalStatus == "RUNNING" && remainingMinutes == 0 || terminal
    val machine = Regex("\\d+$").find(watch.machineId)?.value?.let { "${it}번" } ?: watch.machineId
    val device = if (watch.appliance == "washer") "세탁기" else "건조기"
    val action = if (watch.appliance == "washer") "세탁" else "건조"
    val copy = when {
        watch.notificationMode == "before-completion" &&
            appliance.operationalStatus == "RUNNING" &&
            remainingMinutes in 1..watch.notifyBeforeMinutes -> LaundryNotificationCopy(
            kind = "laundry-finishing",
            title = "$action 종료 ${watch.notifyBeforeMinutes}분 전",
            body = "$machine $device\uAC00 곧 끝납니다.",
        )
        watch.notificationMode == "estimated-completion" && estimatedCompletionReached -> LaundryNotificationCopy(
            kind = "laundry-completion-expected",
            title = "$action 완료 예상",
            body = "$machine $device\uC758 예상 종료 시각입니다. 실제 상태를 확인해 주세요.",
        )
        watch.notificationMode == "confirmed-completion" && terminal -> LaundryNotificationCopy(
            kind = "laundry-completed",
            title = "$action 완료 확정",
            body = "$machine $device\uAC00 끝났습니다. 세탁물을 꺼내 주세요.",
        )
        else -> return null
    }
    val id = UUID.randomUUID()
    val expiresAt = now + if (copy.kind == "laundry-completed") {
        Duration.ofHours(6).toMillis()
    } else {
        Duration.ofHours(2).toMillis()
    }
    return LaundryDecision(
        notification = NotificationRecord(
            id = id,
            userId = watch.userId,
            sourceEventId = "${copy.kind}:${watch.id}:${watch.sessionId ?: "none"}:${watch.notificationMode}",
            kind = copy.kind,
            title = copy.title,
            body = copy.body,
            path = "/#/laundry",
            payload = mapOf(
                "notificationId" to id.toString(),
                "kind" to copy.kind,
                "title" to copy.title,
                "body" to copy.body,
                "path" to "/#/laundry",
                "machineId" to watch.machineId,
                "appliance" to watch.appliance,
                "sessionId" to watch.sessionId,
                "notificationMode" to watch.notificationMode,
                "remainingMinutes" to remainingMinutes,
                "createdAtEpochMs" to now,
                "expiresAtEpochMs" to expiresAt,
            ),
            createdAtEpochMs = now,
            dueAtEpochMs = now,
            expiresAtEpochMs = expiresAt,
        ),
        completeWatch = true,
    )
}

private data class LaundryNotificationCopy(val kind: String, val title: String, val body: String)

private fun projectedRemainingMinutes(appliance: LaundryAppliance, now: Long): Int {
    val estimatedFinishAt = appliance.estimatedFinishAt ?: return appliance.projection?.remainingMinutes
        ?: appliance.remainingMinutes
    val seconds = runCatching {
        Duration.between(Instant.ofEpochMilli(now), Instant.parse(estimatedFinishAt)).seconds
    }.getOrNull() ?: return appliance.projection?.remainingMinutes ?: appliance.remainingMinutes
    return if (seconds <= 0) 0 else ((seconds + 59) / 60).toInt()
}

private fun laundryWatchShouldCompleteSilently(
    watch: ActiveLaundryWatch,
    appliance: LaundryAppliance,
): Boolean {
    val replacedSession = watch.sessionId != null && appliance.sessionId != null &&
        watch.sessionId != appliance.sessionId
    val terminal = appliance.operationalStatus in setOf("COMPLETED", "IDLE") ||
        appliance.projection?.status == "CONFIRMED_COMPLETED"
    return replacedSession || terminal
}
