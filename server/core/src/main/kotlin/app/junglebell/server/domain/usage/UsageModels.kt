package app.junglebell.server.domain.usage

enum class UsageClient(val value: String) {
    WEB("web"),
    PWA("pwa"),
    DESKTOP("desktop"),
}

enum class UsageActivity(val value: String) {
    UI_OPENED("ui_opened"),
}

enum class UsageFeature(val value: String) {
    ATTENDANCE_SETTINGS_CHANGED("attendance_settings_changed"),
    MEAL_NOTIFICATION_SETTINGS_CHANGED("meal_notification_settings_changed"),
    LAUNDRY_WATCH_CREATED("laundry_watch_created"),
    LAUNDRY_WATCH_CANCELLED("laundry_watch_cancelled"),
    MOBILE_DEVICE_PAIRED("mobile_device_paired"),
    MOBILE_DEVICE_REVOKED("mobile_device_revoked"),
    PUSH_SUBSCRIPTION_REGISTERED("push_subscription_registered"),
    PUSH_SUBSCRIPTION_REMOVED("push_subscription_removed"),
}

enum class UsageSummaryScope {
    AUTHENTICATED_ACTIVITY,
    AUTHENTICATED_FEATURE,
    ANONYMOUS_ACTIVITY,
}

data class UsagePreference(val enabled: Boolean?)

data class UsagePurgeResult(
    val anonymousRows: Int,
    val userActivityRows: Int,
    val featureRows: Int,
    val summaryRows: Int,
)
