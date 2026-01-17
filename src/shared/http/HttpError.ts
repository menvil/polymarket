/**
 * HttpError - кастомная ошибка для HTTP запросов
 *
 * @remarks
 * Используется HttpClient для обертки ошибок fetch.
 * Расширяет стандартный Error дополнительными полями:
 * - status: HTTP status code (404, 500, etc.)
 * - responseBody: тело ответа для debugging
 *
 * @example
 * ```typescript
 * throw new HttpError(404, 'Not Found', { detail: 'Market not found' });
 * ```
 */
export class HttpError extends Error {
  /**
   * HTTP status code
   */
  public readonly status: number;

  /**
   * Response body (если доступно)
   */
  public readonly responseBody?: unknown;

  /**
   * Создаёт HttpError
   *
   * @param status - HTTP status code
   * @param message - Описание ошибки
   * @param responseBody - Тело ответа (опционально)
   *
   * @example
   * ```typescript
   * throw new HttpError(500, 'Internal Server Error', { error: 'Database timeout' });
   * ```
   */
  constructor(status: number, message: string, responseBody?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.responseBody = responseBody;

    // Поддержка instanceof для transpiled кода
    Object.setPrototypeOf(this, HttpError.prototype);
  }

  /**
   * Проверяет, является ли ошибка временной (retryable)
   *
   * @returns true если ошибка временная (5xx, 429, timeout)
   *
   * @remarks
   * Временные ошибки:
   * - 5xx (Server errors)
   * - 429 (Too Many Requests)
   * - 408 (Request Timeout)
   */
  public isRetryable(): boolean {
    return (
      this.status >= 500 ||
      this.status === 429 ||
      this.status === 408
    );
  }
}
