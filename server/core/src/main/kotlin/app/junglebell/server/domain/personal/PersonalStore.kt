package app.junglebell.server.domain.personal

import java.util.UUID

interface PersonalStore {
    fun attendance(userId: UUID): AttendancePreferences
    fun saveAttendance(userId: UUID, value: AttendancePreferences, now: Long): AttendancePreferences
    fun meal(userId: UUID): MealPreferences
    fun saveMeal(userId: UUID, value: MealPreferencesInput, now: Long): MealPreferences
    fun watches(userId: UUID): List<LaundryWatch>
    fun createWatch(userId: UUID, watch: LaundryWatch): Boolean
    fun cancelWatch(userId: UUID, id: String, now: Long): Boolean
}
