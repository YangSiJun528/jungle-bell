package app.junglebell.server.domain.automation

interface PushSender {
    val configured: Boolean

    fun send(delivery: PushDelivery, now: Long): PushResult
}

data class PushResult(val status: String, val error: String?)
