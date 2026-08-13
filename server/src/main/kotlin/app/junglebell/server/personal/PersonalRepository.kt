package app.junglebell.server.personal

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.sql.Date
import java.util.UUID

@Repository
class PersonalRepository(private val jdbc: JdbcClient) {
    fun attendance(userId: UUID): AttendancePreferences = jdbc.sql(
        "SELECT * FROM attendance_preference WHERE user_id = :userId",
    ).param("userId", userId).query { row, _ ->
        AttendancePreferences(
            row.getBoolean("enabled"),
            row.getBoolean("morning_enabled"),
            row.getBoolean("evening_enabled"),
            row.getInt("morning_start_hour"),
            row.getInt("evening_end_hour"),
            row.getInt("morning_interval_minutes"),
            row.getInt("evening_interval_minutes"),
            row.getBoolean("skip_sunday"),
            row.getDate("skip_attendance_date")?.toLocalDate()?.toString(),
        )
    }.single()

    fun updateAttendance(userId: UUID, value: AttendancePreferences, now: Long) {
        jdbc.sql(
            """
            INSERT INTO attendance_preference(
                user_id, enabled, morning_enabled, evening_enabled, morning_start_hour,
                evening_end_hour, morning_interval_minutes, evening_interval_minutes,
                skip_sunday, skip_attendance_date, updated_at_epoch_ms
            ) VALUES (:userId, :enabled, :morning, :evening, :morningStartHour,
                :eveningEndHour, :morningInterval, :eveningInterval, :skipSunday,
                :skipDate, :now)
            ON CONFLICT (user_id) DO UPDATE SET
                enabled = EXCLUDED.enabled,
                morning_enabled = EXCLUDED.morning_enabled,
                evening_enabled = EXCLUDED.evening_enabled,
                morning_start_hour = EXCLUDED.morning_start_hour,
                evening_end_hour = EXCLUDED.evening_end_hour,
                morning_interval_minutes = EXCLUDED.morning_interval_minutes,
                evening_interval_minutes = EXCLUDED.evening_interval_minutes,
                skip_sunday = EXCLUDED.skip_sunday,
                skip_attendance_date = EXCLUDED.skip_attendance_date,
                updated_at_epoch_ms = EXCLUDED.updated_at_epoch_ms
            """.trimIndent(),
        ).param("userId", userId).param("enabled", value.enabled)
            .param("morning", value.morning).param("evening", value.evening)
            .param("morningStartHour", value.morningStartHour).param("eveningEndHour", value.eveningEndHour)
            .param("morningInterval", value.morningIntervalMinutes)
            .param("eveningInterval", value.eveningIntervalMinutes).param("skipSunday", value.skipSunday)
            .param("skipDate", value.skipAttendanceDate?.let(Date::valueOf)).param("now", now).update()
    }

    fun meal(userId: UUID): MealPreferences = jdbc.sql(
        "SELECT enabled, lunch, dinner, updated_at_epoch_ms FROM meal_preference WHERE user_id = :userId",
    ).param("userId", userId).query { row, _ ->
        MealPreferences(
            row.getBoolean("enabled"),
            row.getBoolean("lunch"),
            row.getBoolean("dinner"),
            row.getLong("updated_at_epoch_ms"),
        )
    }.single()

    fun updateMeal(userId: UUID, value: MealPreferencesInput, now: Long) {
        jdbc.sql(
            """
            INSERT INTO meal_preference(user_id, enabled, lunch, dinner, updated_at_epoch_ms)
            VALUES (:userId, :enabled, :lunch, :dinner, :now)
            ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled,
                lunch = EXCLUDED.lunch, dinner = EXCLUDED.dinner,
                updated_at_epoch_ms = EXCLUDED.updated_at_epoch_ms
            """.trimIndent(),
        ).param("userId", userId).param("enabled", value.enabled).param("lunch", value.lunch)
            .param("dinner", value.dinner).param("now", now).update()
    }

    fun watches(userId: UUID): List<LaundryWatch> = jdbc.sql(
        "SELECT * FROM laundry_watch WHERE user_id = :userId ORDER BY created_at_epoch_ms DESC, id",
    ).param("userId", userId).query { row, _ ->
        LaundryWatch(
            row.getString("id"),
            row.getString("machine_id"),
            row.getString("appliance"),
            row.getString("session_id"),
            row.getInt("notify_before_minutes"),
            row.getBoolean("notify_when_available"),
            row.getString("status"),
            row.getLong("created_at_epoch_ms"),
            row.getLong("updated_at_epoch_ms"),
        )
    }.list()

    fun insertWatch(userId: UUID, watch: LaundryWatch) {
        jdbc.sql(
            """
            INSERT INTO laundry_watch(
                id, user_id, machine_id, appliance, session_id, notify_before_minutes,
                notify_when_available, status, created_at_epoch_ms, updated_at_epoch_ms
            ) VALUES (:id, :userId, :machineId, :appliance, :sessionId,
                :notifyBefore, :notifyAvailable, :status, :createdAt, :updatedAt)
            """.trimIndent(),
        ).param("id", watch.id).param("userId", userId).param("machineId", watch.machineId)
            .param("appliance", watch.appliance).param("sessionId", watch.sessionId)
            .param("notifyBefore", watch.notifyBeforeMinutes).param("notifyAvailable", watch.notifyWhenAvailable)
            .param("status", watch.status).param("createdAt", watch.createdAtEpochMs)
            .param("updatedAt", watch.updatedAtEpochMs).update()
    }

    fun cancelWatch(userId: UUID, id: String, now: Long): Boolean = jdbc.sql(
        """
        UPDATE laundry_watch SET status = 'cancelled', updated_at_epoch_ms = :now
        WHERE id = :id AND user_id = :userId AND status = 'active'
        """.trimIndent(),
    ).param("now", now).param("id", id).param("userId", userId).update() == 1
}
