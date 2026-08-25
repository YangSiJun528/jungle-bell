package app.junglebell.server.domain.usage

import java.time.Clock
import java.util.UUID
import org.springframework.stereotype.Service

@Service
class UsagePreferenceService(
    private val store: UsageStore,
    private val clock: Clock,
) {
    fun get(userId: UUID): UsagePreference = store.usagePreference(userId)

    fun put(userId: UUID, enabled: Boolean): UsagePreference =
        store.putUsagePreference(userId, enabled, clock.millis())
}
