package app.junglebell.server.common.error

import org.springframework.http.HttpStatus

class ApiException(
    val code: String,
    val status: HttpStatus = HttpStatus.BAD_REQUEST,
    cause: Throwable? = null,
) : RuntimeException(code, cause)
