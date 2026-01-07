/**
 * PolymarketErrorMapper - ГРЯЗНЫЙ слой для HTTP → ExchangeError
 *
 * @remarks
 * ⚠️ ГРЯЗНЫЙ СЛОЙ (DIRTY LAYER) ⚠️
 *
 * Почему грязный:
 * - String matching response body (хрупкое, зависит от API формата)
 * - Парсинг JSON без schema validation
 * - Догадки о причине ошибки (неполная информация от API)
 * - Императивные if/else цепочки (нет exhaustive checking)
 *
 * КРИТИЧЕСКИ ВАЖНО:
 * ✅ Детерминированный (одинаковый HTTP → одинаковый ExchangeError)
 * ✅ НИКОГДА не бросает exceptions (всегда возвращает ExchangeError)
 * ✅ Неизвестные ошибки → FATAL (fail-safe)
 * ✅ Изолирован в одном файле (не распространяется на domain)
 *
 * Алгоритм:
 * 1. Проверить HTTP status code (429, 401, 404, 5xx, 0)
 * 2. Попытаться распарсить response body (если есть)
 * 3. String matching на response.message или response.error
 * 4. Вернуть соответствующий ExchangeError
 * 5. Если ничего не подошло → FATAL (require manual investigation)
 *
 * КОГДА РЕФАКТОРИТЬ:
 * - Когда Polymarket API предоставит формальный error schema
 * - Когда появится централизованный error catalog
 * - Когда накопится достаточно примеров для pattern recognition
 *
 * ВРЕМЕННОЕ РЕШЕНИЕ:
 * Пока Polymarket API не предоставляет формальных error codes,
 * мы вынуждены использовать string matching.
 * Это хрупко, но лучше чем бросать generic exceptions.
 *
 * @example
 * ```typescript
 * // HTTP 429 (Rate Limited)
 * const error = PolymarketErrorMapper.mapHttpError(429, {
 *   error: 'Too many requests',
 *   retryAfter: 60,
 * });
 * // → { type: 'RATE_LIMITED', retryAfter: 60 }
 *
 * // HTTP 400 (Market Closed)
 * const error = PolymarketErrorMapper.mapHttpError(400, {
 *   message: 'Market is closed',
 * });
 * // → { type: 'MARKET_CLOSED' }
 *
 * // HTTP 500 (Unknown Server Error)
 * const error = PolymarketErrorMapper.mapHttpError(500, {
 *   error: 'Internal Server Error',
 * });
 * // → { type: 'SERVER_ERROR', httpStatus: 500 }
 *
 * // Unknown Error
 * const error = PolymarketErrorMapper.mapHttpError(418, {
 *   message: 'I am a teapot',
 * });
 * // → { type: 'FATAL', requiresManualInvestigation: true }
 * ```
 */

import type { ExchangeError, FatalExchangeError } from '../../../domain/types/ExchangeError.js';
import { ExchangeErrorCode } from '../../../domain/types/ExchangeError.js';

/**
 * PolymarketApiErrorResponse - структура error response от Polymarket API
 *
 * @remarks
 * Неформальная структура (Polymarket не предоставляет schema).
 * Основано на эмпирических наблюдениях.
 *
 * Известные форматы:
 * - { error: string }
 * - { message: string }
 * - { error: string, retryAfter: number } (для 429)
 * - { detail: string } (иногда)
 *
 * Все поля опциональные (API может вернуть что угодно).
 */
interface PolymarketApiErrorResponse {
  error?: string;
  message?: string;
  detail?: string;
  retryAfter?: number; // Для 429 Rate Limited
  [key: string]: unknown; // API может вернуть любые поля
}

/**
 * PolymarketErrorMapper - маппер HTTP → ExchangeError
 *
 * @remarks
 * Stateless класс - все методы static (pure functions где возможно).
 * Единственный public метод: mapHttpError().
 */
export class PolymarketErrorMapper {
  /**
   * Маппит HTTP error → ExchangeError
   *
   * @param httpStatus - HTTP status code (0 для network errors)
   * @param responseBody - Response body (может быть undefined/null)
   * @param originalError - Оригинальная ошибка (для network errors)
   * @returns ExchangeError (детерминированный)
   *
   * @remarks
   * ДЕТЕРМИНИРОВАННАЯ ФУНКЦИЯ:
   * - Одинаковый (httpStatus, responseBody) → одинаковый ExchangeError
   * - НЕ использует Date.now(), random, external state
   * - Не бросает exceptions (всегда возвращает ExchangeError)
   *
   * Алгоритм priority (сверху вниз):
   * 1. Network errors (httpStatus === 0)
   * 2. Rate limiting (httpStatus === 429)
   * 3. Auth errors (httpStatus === 401 || 403)
   * 4. Not found (httpStatus === 404)
   * 5. Client errors (httpStatus 4xx с body parsing)
   * 6. Server errors (httpStatus 5xx)
   * 7. Unknown (FATAL)
   *
   * @example
   * ```typescript
   * // Rate Limited
   * const error = PolymarketErrorMapper.mapHttpError(429, { retryAfter: 60 });
   * // { type: 'RATE_LIMITED', retryAfter: 60 }
   *
   * // Network Error
   * const error = PolymarketErrorMapper.mapHttpError(0, null, new Error('ECONNREFUSED'));
   * // { type: 'NETWORK_ERROR', reason: 'CONNECTION_FAILED' }
   *
   * // Fatal Unknown
   * const error = PolymarketErrorMapper.mapHttpError(418);
   * // { type: 'FATAL', requiresManualInvestigation: true }
   * ```
   */
  public static mapHttpError(
    httpStatus: number,
    responseBody?: unknown,
    originalError?: Error
  ): ExchangeError {
    // Priority #1: Network errors (httpStatus === 0 означает нет HTTP response)
    if (httpStatus === 0) {
      return this.mapNetworkError(originalError);
    }

    // Priority #2: Rate limiting (429)
    if (httpStatus === 429) {
      return this.mapRateLimitedError(responseBody);
    }

    // Priority #3: Auth errors (401, 403)
    if (httpStatus === 401 || httpStatus === 403) {
      return this.mapAuthError(httpStatus, responseBody);
    }

    // Priority #4: Not found (404)
    if (httpStatus === 404) {
      return this.mapNotFoundError(responseBody);
    }

    // Priority #5: Client errors (4xx)
    if (httpStatus >= 400 && httpStatus < 500) {
      return this.mapClientError(httpStatus, responseBody);
    }

    // Priority #6: Server errors (5xx)
    if (httpStatus >= 500 && httpStatus < 600) {
      return this.mapServerError(httpStatus, responseBody);
    }

    // Priority #7: Unknown (FATAL)
    return this.mapFatalError(httpStatus, responseBody, 'Unknown HTTP status code');
  }

  /**
   * Маппит network errors (no HTTP response)
   *
   * @remarks
   * Network errors возникают когда нет HTTP response:
   * - ECONNREFUSED (connection refused)
   * - ETIMEDOUT (timeout)
   * - ENOTFOUND (DNS resolution failed)
   * - ECONNRESET (connection reset)
   *
   * Все network errors → NETWORK_ERROR (retryable).
   */
  private static mapNetworkError(originalError?: Error): ExchangeError {
    const errorMessage = originalError?.message || 'Network error';

    // String matching на error.message (грязно, но необходимо)
    let reason: 'TIMEOUT' | 'CONNECTION_FAILED' | 'DNS_FAILED' | 'UNKNOWN' = 'UNKNOWN';

    if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      reason = 'TIMEOUT';
    } else if (
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('ECONNRESET') ||
      errorMessage.includes('connection')
    ) {
      reason = 'CONNECTION_FAILED';
    } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
      reason = 'DNS_FAILED';
    }

    return {
      type: 'NETWORK_ERROR',
      code: ExchangeErrorCode.NETWORK_ERROR,
      message: `${reason}: ${errorMessage}`,
    };
  }

  /**
   * Маппит 429 Rate Limited errors
   *
   * @remarks
   * Polymarket API возвращает retryAfter в response body (иногда).
   * Если retryAfter отсутствует → используем default (60 секунд).
   */
  private static mapRateLimitedError(responseBody?: unknown): ExchangeError {
    const body = this.parseResponseBody(responseBody);
    const retryAfter = typeof body?.retryAfter === 'number' ? body.retryAfter : 60; // Default 60s

    return {
      type: 'RATE_LIMITED',
      code: ExchangeErrorCode.RATE_LIMITED,
      retryAfter,
      message: body?.error || body?.message || 'Rate limit exceeded',
    };
  }

  /**
   * Маппит 401/403 Auth errors
   *
   * @remarks
   * Auth errors означают invalid signature или expired credentials.
   * Retry бесполезен (нужно проверить API keys).
   */
  private static mapAuthError(httpStatus: number, responseBody?: unknown): ExchangeError {
    const body = this.parseResponseBody(responseBody);
    const reason = body?.error || body?.message || 'Authentication failed';

    return {
      type: 'AUTH_FAILED',
      code: ExchangeErrorCode.AUTH_FAILED,
      httpStatus: httpStatus === 401 || httpStatus === 403 ? httpStatus : 401,
      reason,
    };
  }

  /**
   * Маппит 404 Not Found errors
   *
   * @remarks
   * Обычно означает order not found (уже cancelled/filled).
   * Или market not found (неверный tokenId).
   *
   * String matching на message для определения причины.
   */
  private static mapNotFoundError(responseBody?: unknown): ExchangeError {
    const body = this.parseResponseBody(responseBody);
    const message = body?.error || body?.message || body?.detail || 'Not found';

    // String matching (грязно, но необходимо)
    // Проверяем что это order not found (а не market not found)
    // Note: isOrderNotFound используется для возможного будущего различения типов 404
    const isOrderNotFound =
      message.toLowerCase().includes('order') || message.toLowerCase().includes('not found');

    // Extract orderId if available (fallback to 'unknown')
    const orderId = typeof body?.orderId === 'string' ? body.orderId : 'unknown';

    return {
      type: 'ORDER_NOT_FOUND',
      code: ExchangeErrorCode.ORDER_NOT_FOUND,
      orderId, // API обычно не возвращает orderId в error
    };

    // Suppress unused variable warning - isOrderNotFound may be used in future
    void isOrderNotFound;
  }

  /**
   * Маппит client errors (4xx кроме 401, 403, 404, 429)
   *
   * @remarks
   * Client errors могут означать:
   * - Market closed
   * - Invalid order parameters (но это должно быть caught в validation)
   * - Business rule violations
   *
   * String matching на message для определения причины.
   */
  private static mapClientError(httpStatus: number, responseBody?: unknown): ExchangeError {
    const body = this.parseResponseBody(responseBody);
    const message = body?.error || body?.message || body?.detail || 'Client error';

    // String matching для MARKET_CLOSED (грязно, но необходимо)
    const isMarketClosed =
      message.toLowerCase().includes('market') &&
      (message.toLowerCase().includes('closed') ||
        message.toLowerCase().includes('inactive') ||
        message.toLowerCase().includes('unavailable'));

    if (isMarketClosed) {
      // Extract marketId if available (fallback to 'unknown')
      const marketId =
        typeof body?.marketId === 'string'
          ? body.marketId
          : typeof body?.tokenId === 'string'
            ? body.tokenId
            : 'unknown';

      return {
        type: 'MARKET_CLOSED',
        code: ExchangeErrorCode.MARKET_CLOSED,
        marketId, // API обычно не возвращает marketId в error
        reason: message,
      };
    }

    // Неизвестная client error → FATAL (требует investigation)
    return this.mapFatalError(httpStatus, responseBody, `Unrecognized client error: ${message}`);
  }

  /**
   * Маппит server errors (5xx)
   *
   * @remarks
   * Server errors - временные проблемы биржи.
   * Обычно retryable (с exponential backoff).
   */
  private static mapServerError(httpStatus: number, responseBody?: unknown): ExchangeError {
    const body = this.parseResponseBody(responseBody);
    const message = body?.error || body?.message || 'Server error';

    return {
      type: 'SERVER_ERROR',
      code: ExchangeErrorCode.SERVER_ERROR,
      status: httpStatus,
      message,
    };
  }

  /**
   * Маппит FATAL errors (unknown/unrecognized)
   *
   * @remarks
   * FATAL означает:
   * - Неизвестный HTTP status code
   * - Неизвестный error format
   * - Что-то пошло очень не так
   *
   * Требует manual investigation (не retry автоматически).
   * Стратегия ДОЛЖНА остановиться при FATAL.
   */
  private static mapFatalError(
    httpStatus: number,
    responseBody?: unknown,
    message?: string
  ): FatalExchangeError {
    return {
      type: 'FATAL',
      code: ExchangeErrorCode.FATAL,
      httpStatus,
      responseBody,
      message: message || 'Fatal exchange error (requires manual investigation)',
      requiresManualInvestigation: true,
    };
  }

  /**
   * Парсит response body в PolymarketApiErrorResponse
   *
   * @remarks
   * Response body может быть:
   * - undefined/null (нет body)
   * - string (JSON или plain text)
   * - object (уже parsed JSON)
   *
   * Безопасно парсит JSON (не бросает exceptions).
   */
  private static parseResponseBody(responseBody?: unknown): PolymarketApiErrorResponse | null {
    if (!responseBody) {
      return null;
    }

    // Если уже object - вернуть как есть
    if (typeof responseBody === 'object' && responseBody !== null) {
      return responseBody as PolymarketApiErrorResponse;
    }

    // Если string - попытаться распарсить JSON
    if (typeof responseBody === 'string') {
      try {
        return JSON.parse(responseBody) as PolymarketApiErrorResponse;
      } catch {
        // Не JSON - вернуть как { message: string }
        return { message: responseBody };
      }
    }

    // Неизвестный тип - вернуть null
    return null;
  }
}
