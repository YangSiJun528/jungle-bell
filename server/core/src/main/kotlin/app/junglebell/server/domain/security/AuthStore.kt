package app.junglebell.server.domain.security

interface AuthStore {
    /** 인증과 마지막 사용 시각 갱신을 하나의 저장 작업으로 처리합니다. */
    fun authenticateAppSession(tokenHash: String, now: Long): SessionPrincipal?
    fun findDesktopUiSession(tokenHash: String, now: Long): StoredDesktopUiSession?
}

data class StoredDesktopUiSession(
    val principal: SessionPrincipal,
    val origin: String,
)
