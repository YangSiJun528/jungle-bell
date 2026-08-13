package app.junglebell.server.common

import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.ConstraintViolationException
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
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

class ApiException(
    val code: String,
    val status: HttpStatus = HttpStatus.BAD_REQUEST,
    cause: Throwable? = null,
) : RuntimeException(code, cause)

@RestControllerAdvice
class ApiErrorHandler {
    @ExceptionHandler(ApiException::class)
    fun api(error: ApiException): ResponseEntity<ApiErrorResponse> =
        ResponseEntity.status(error.status).body(ApiErrorResponse(error.code))

    @ExceptionHandler(
        MethodArgumentNotValidException::class,
        BindException::class,
        ConstraintViolationException::class,
        HandlerMethodValidationException::class,
        HttpMessageNotReadableException::class,
        MissingServletRequestParameterException::class,
        IllegalArgumentException::class,
    )
    fun invalidRequest(error: Exception): ResponseEntity<ApiErrorResponse> =
        ResponseEntity.badRequest().body(ApiErrorResponse("INVALID_REQUEST", validationIssues(error)))

    @ExceptionHandler(NoResourceFoundException::class)
    fun notFound(@Suppress("UNUSED_PARAMETER") error: NoResourceFoundException): ResponseEntity<ApiErrorResponse> =
        ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiErrorResponse("NOT_FOUND"))

    @ExceptionHandler(Exception::class)
    fun internal(error: Exception, request: HttpServletRequest): ResponseEntity<ApiErrorResponse> {
        request.servletContext.log("Unhandled API failure for ${request.method} ${request.requestURI}", error)
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
