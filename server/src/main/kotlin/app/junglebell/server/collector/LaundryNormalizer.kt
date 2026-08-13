package app.junglebell.server.collector

import app.junglebell.server.publicapi.LaundryAppliance
import app.junglebell.server.publicapi.LaundryEvent
import app.junglebell.server.publicapi.LaundryMachine
import app.junglebell.server.publicapi.LaundryVersion
import app.junglebell.server.publicapi.NormalizedEnum
import app.junglebell.server.publicapi.UnknownEnumObservation
import tools.jackson.databind.JsonNode
import org.springframework.stereotype.Component
import java.time.Instant

@Component
class LaundryNormalizer {
    private val knownStates = setOf(
        "POWER_OFF", "INITIAL", "RESERVED", "DETECTING", "DISPENSING", "SOAKING",
        "WASHING", "RINSING", "SPINNING", "RUNNING", "DRYING", "COOLING",
        "REFRESHING", "WRINKLE_CARE", "PAUSE", "END", "ERROR",
    )

    fun normalize(raw: JsonNode, sha: String, observedAt: Instant, previous: LaundryVersion?): LaundryVersion {
        require(raw.isObject) { "Laundry response must be an object" }
        val unknown = mutableListOf<UnknownEnumObservation>()
        val events = mutableListOf<LaundryEvent>()
        val previousById = previous?.machines?.associateBy { it.id }.orEmpty()
        val machines = raw.propertyNames().sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it }).map { machineId ->
            val tower = raw.path(machineId)
            val washer = tower.get("washer")?.takeUnless(JsonNode::isNull)?.let {
                appliance(machineId, "washer", it, observedAt, previousById[machineId]?.washer, unknown, events)
            }
            val dryer = tower.get("dryer")?.takeUnless(JsonNode::isNull)?.let {
                appliance(machineId, "dryer", it, observedAt, previousById[machineId]?.dryer, unknown, events)
            }
            LaundryMachine(machineId, washer, dryer)
        }
        return LaundryVersion(1, sha, observedAt.toString(), machines, events, unknown)
    }

    private fun appliance(
        machineId: String,
        kind: String,
        raw: JsonNode,
        observedAt: Instant,
        previous: LaundryAppliance?,
        unknown: MutableList<UnknownEnumObservation>,
        events: MutableList<LaundryEvent>,
    ): LaundryAppliance {
        val rawState = raw.path("runState").path("currentState").takeUnless { it.isMissingNode || it.isNull }
            ?.asString()
        val state = when {
            rawState == null -> NormalizedEnum("UNKNOWN", null, false)
            rawState in knownStates -> NormalizedEnum(rawState, null, true)
            else -> {
                unknown += UnknownEnumObservation(machineId, kind, "$kind.runState.currentState", rawState)
                NormalizedEnum("UNKNOWN", rawState, false)
            }
        }
        val timer = raw.path("timer")
        val remaining = timer.path("remainHour").asInt(0) * 60 + timer.path("remainMinute").asInt(0)
        val total = timer.path("totalHour").asInt(0) * 60 + timer.path("totalMinute").asInt(0)
        val error = raw.get("error")?.takeUnless(JsonNode::isNull)?.asString()
        val operational = operationalStatus(state, remaining, error)
        val cycleCount = raw.path("cycle").path("cycleCount").takeUnless { it.isMissingNode || it.isNull }
            ?.asInt()
        val sessionId = when {
            rawState == null -> previous?.sessionId
            operational in setOf("IDLE", "COMPLETED") -> previous?.sessionId
            kind == "washer" && cycleCount != null -> "$machineId:washer:cycle:$cycleCount"
            previous?.sessionId != null && previous.operationalStatus !in setOf("IDLE", "COMPLETED") -> previous.sessionId
            else -> "$machineId:$kind:$observedAt"
        }
        val startedAt = when {
            sessionId == null -> UNKNOWN_STARTED_AT
            previous?.sessionId == sessionId -> previous.startedAt
            operational == "RUNNING" -> observedAt.toString()
            else -> UNKNOWN_STARTED_AT
        }
        val current = LaundryAppliance(
            machineId,
            kind,
            observedAt.toString(),
            state,
            operational,
            remaining,
            total,
            startedAt,
            if (operational == "RUNNING") observedAt.plusSeconds(remaining * 60L).toString() else null,
            raw.path("remoteControlEnable").path("remoteControlEnabled")
                .takeUnless { it.isMissingNode || it.isNull }?.asBoolean(),
            cycleCount,
            sessionId,
            error,
        )
        events += detectEvents(previous, current)
        return current
    }

    private fun operationalStatus(state: NormalizedEnum, remaining: Int, error: String?): String = when {
        !state.known -> "UNKNOWN"
        state.code == "ERROR" || error != null -> "ERROR"
        state.code == "PAUSE" -> "PAUSED"
        state.code == "END" -> "COMPLETED"
        state.code in setOf("POWER_OFF", "INITIAL") -> "IDLE"
        state.code == "RESERVED" -> "SCHEDULED"
        remaining > 0 || state.code != "POWER_OFF" -> "RUNNING"
        else -> "IDLE"
    }

    private fun detectEvents(previous: LaundryAppliance?, current: LaundryAppliance): List<LaundryEvent> {
        if (previous == null || previous.state.raw == null && !previous.state.known || current.state.raw == null && !current.state.known) {
            return emptyList()
        }
        val types = buildList {
            if (previous.operationalStatus != "RUNNING" && current.operationalStatus == "RUNNING") add("STARTED")
            if (previous.operationalStatus != "COMPLETED" && current.operationalStatus == "COMPLETED") add("COMPLETED")
            if (previous.operationalStatus != "ERROR" && current.operationalStatus == "ERROR") add("ERROR_ENTERED")
            if (previous.operationalStatus == "ERROR" && current.operationalStatus != "ERROR") add("ERROR_CLEARED")
            if (previous.operationalStatus != "PAUSED" && current.operationalStatus == "PAUSED") add("PAUSED")
            if (previous.operationalStatus == "RUNNING" && current.operationalStatus == "IDLE") add("STOPPED_UNEXPECTEDLY")
            if ((previous.state.raw ?: previous.state.code) != (current.state.raw ?: current.state.code)) add("STATE_CHANGED")
        }
        return types.distinct().map { type ->
            LaundryEvent(
                "${current.machineId}:${current.appliance}:${current.sessionId ?: "none"}:${current.observedAt}:$type",
                current.machineId,
                current.appliance,
                current.sessionId,
                type,
                previous.observedAt,
                current.observedAt,
                null,
                previous.state.raw ?: previous.state.code,
                current.state.raw ?: current.state.code,
                mapOf("changeWindow" to mapOf("after" to previous.observedAt, "atOrBefore" to current.observedAt)),
            )
        }
    }

    companion object {
        const val UNKNOWN_STARTED_AT = "1970-01-01T00:00:00Z"
    }
}
