package app.junglebell.server.api.common

import app.junglebell.server.common.error.ApiException
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.ConstraintViolationException
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.slf4j.LoggerFactory
import org.springframework.validation.BindException
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.method.annotation.HandlerMethodValidationException
import org.springframework.web.servlet.resource.NoResourceFoundException

data class ValidationIssue(val path: String, val message: String)

data class ApiErrorResponse(
    val error: String,
    val issues: List<ValidationIssue>? = null,
)

@RestControllerAdvice
class ApiErrorHandler {
    private val logger = LoggerFactory.getLogger(javaClass)

    @ExceptionHandler(ApiException::class)
    fun api(error: ApiException): ResponseEntity<ApiErrorResponse> {
        logger.warn(
            "HTTP request rejected. status={} errorCode={}",
            error.status.value(),
            error.code,
        )
        return ResponseEntity.status(error.status).body(ApiErrorResponse(error.code))
    }

    @ExceptionHandler(
        MethodArgumentNotValidException::class,
        BindException::class,
        ConstraintViolationException::class,
        HandlerMethodValidationException::class,
        HttpMessageNotReadableException::class,
        MissingServletRequestParameterException::class,
        IllegalArgumentException::class,
    )
    fun invalidRequest(error: Exception): ResponseEntity<ApiErrorResponse> {
        logger.warn(
            "HTTP request rejected. status=400 errorCode=INVALID_REQUEST errorType={}",
            error.javaClass.simpleName,
        )
        return ResponseEntity.badRequest().body(ApiErrorResponse("INVALID_REQUEST", validationIssues(error)))
    }

    @ExceptionHandler(NoResourceFoundException::class)
    fun notFound(@Suppress("UNUSED_PARAMETER") error: NoResourceFoundException): ResponseEntity<ApiErrorResponse> {
        logger.debug("HTTP request resource not found. status=404 errorCode=NOT_FOUND")
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiErrorResponse("NOT_FOUND"))
    }

    @ExceptionHandler(Exception::class)
    fun internal(error: Exception, request: HttpServletRequest): ResponseEntity<ApiErrorResponse> {
        logger.error(
            "HTTP request failed. method={} status=500 errorCode=INTERNAL_ERROR",
            request.method,
            error,
        )
        return ResponseEntity.internalServerError().body(ApiErrorResponse("INTERNAL_ERROR"))
    }

    private fun validationIssues(error: Exception): List<ValidationIssue>? = when (error) {
        is MethodArgumentNotValidException -> error.bindingResult.fieldErrors.map {
            ValidationIssue(it.field, it.defaultMessage ?: "invalid value")
        }
        is BindException -> error.bindingResult.fieldErrors.map {
            ValidationIssue(it.field, it.defaultMessage ?: "invalid value")
        }
        is ConstraintViolationException -> error.constraintViolations.map {
            ValidationIssue(it.propertyPath.toString(), it.message)
        }
        else -> null
    }
}
