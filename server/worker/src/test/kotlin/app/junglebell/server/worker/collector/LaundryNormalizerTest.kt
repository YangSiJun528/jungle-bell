package app.junglebell.server.worker.collector

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import tools.jackson.databind.json.JsonMapper

class LaundryNormalizerTest {
    private val mapper = JsonMapper.builder().build()
    private val normalizer = LaundryNormalizer()
    private val observedAt = Instant.parse("2026-08-20T04:45:00Z")

    @Test
    fun `normalizes a machine with appliance data`() {
        val raw = mapper.readTree(
            """
            {
              "워시타워_1": {
                "washer": {
                  "runState": {"currentState": "POWER_OFF"},
                  "timer": {"remainHour": 0, "remainMinute": 0, "totalHour": 0, "totalMinute": 0}
                }
              }
            }
            """.trimIndent(),
        )

        val result = normalizer.normalize(raw, "a".repeat(64), observedAt, null)

        assertEquals("워시타워_1", result.machines.single().id)
        assertEquals("IDLE", assertNotNull(result.machines.single().washer).operationalStatus)
    }

    @Test
    fun `rejects the all-null response returned by a failed source`() {
        val raw = mapper.readTree(
            """
            {"워시타워_1": null, "워시타워_2": null}
            """.trimIndent(),
        )

        assertFailsWith<IllegalArgumentException> {
            normalizer.normalize(raw, "b".repeat(64), observedAt, null)
        }
    }

    @Test
    fun `rejects an empty response or a machine without appliances`() {
        listOf("{}", "{\"error\": {\"message\": \"upstream unavailable\"}}")
            .map(mapper::readTree)
            .forEach { raw ->
                assertFailsWith<IllegalArgumentException> {
                    normalizer.normalize(raw, "c".repeat(64), observedAt, null)
                }
            }
    }

    @Test
    fun `rejects explicit null appliance values`() {
        val raw = mapper.readTree("{\"워시타워_1\": {\"washer\": null}}")

        assertFailsWith<IllegalArgumentException> {
            normalizer.normalize(raw, "d".repeat(64), observedAt, null)
        }
    }

    @Test
    fun `records error and pause transitions before the dryer powers off`() {
        val running = normalizer.normalize(
            dryerRaw("RUNNING", remainingMinutes = 49),
            "running",
            observedAt,
            null,
        )
        val error = normalizer.normalize(
            dryerRaw("RUNNING", remainingMinutes = 49, error = "EMPTY_WATER_ALERT_ERROR"),
            "error",
            observedAt.plusSeconds(60),
            running,
        )
        val idleAfterError = normalizer.normalize(
            dryerRaw("POWER_OFF", remainingMinutes = 0),
            "idle-after-error",
            observedAt.plusSeconds(120),
            error,
        )
        val errorCleared = idleAfterError.events.single { it.type == "ERROR_CLEARED" }

        assertEquals("RUNNING", errorCleared.previousState)
        assertEquals("POWER_OFF", errorCleared.currentState)
        assertEquals(idleAfterError.machines.single().dryer?.sessionId, errorCleared.sessionId)

        val paused = normalizer.normalize(
            dryerRaw("PAUSE", remainingMinutes = 49),
            "paused",
            observedAt.plusSeconds(60),
            running,
        )
        val idleAfterPause = normalizer.normalize(
            dryerRaw("POWER_OFF", remainingMinutes = 0),
            "idle-after-pause",
            observedAt.plusSeconds(120),
            paused,
        )
        val pauseChanged = idleAfterPause.events.single { it.type == "STATE_CHANGED" }

        assertEquals("PAUSE", pauseChanged.previousState)
        assertEquals("POWER_OFF", pauseChanged.currentState)
        assertEquals(idleAfterPause.machines.single().dryer?.sessionId, pauseChanged.sessionId)
    }

    private fun dryerRaw(state: String, remainingMinutes: Int, error: String? = null) = mapper.readTree(
        """
        {
          "워시타워_1": {
            "dryer": {
              "runState": {"currentState": "$state"},
              "timer": {
                "remainHour": 0,
                "remainMinute": $remainingMinutes,
                "totalHour": 1,
                "totalMinute": 0
              }${error?.let { ",\n              \"error\": \"$it\"" }.orEmpty()}
            }
          }
        }
        """.trimIndent(),
    )
}
