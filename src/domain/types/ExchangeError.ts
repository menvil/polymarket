/**
 * ExchangeError - ошибки от биржи (ПОСЛЕ HTTP запроса)
 *
 * @remarks
 * Эти ошибки приходят от внешнего мира (HTTP response, network layer).
 * Они означают "мир сломан" (биржа отказала, сеть упала, auth failed).
 *
 * Критерий принадлежности ExchangeError:
 * ✅ Приходит ОТ HTTP response или network layer
 * ✅ Внешняя ошибка (не под контролем стратегии)
 * ✅ Может требовать retry (RATE_LIMITED, SERVER_ERROR, NETWORK_ERROR)
 *
 * Источники ExchangeError:
 * - HTTP status codes (429, 401, 404, 5xx)
 * - Network errors (timeout, connection refused)
 * - Response body parsing (market closed, order not found)
 *
 * Decision Layer реакция на ExchangeError:
 * - FAILED означает "проблема с внешним миром"
 * - Может быть временной (retry) или постоянной (switch exchange)
 * - Стратегия должна реагировать на конкретный тип ошибки
 *
 * ВАЖНО:
 * - Маппинг ДОЛЖЕН быть детерминированным (одинаковый HTTP → одинаковый ExchangeError)
 * - FatalExchangeError ТРЕБУЕТ остановки стратегии (не retry автоматически)
 *
 * @example
 * ```typescript
 * // Rate limited
 * const error: ExchangeError = {
 *   type: 'RATE_LIMITED',
 *   code: ExchangeErrorCode.RATE_LIMITED,
 *   retryAfter: 60,
 *   message: 'Too many requests',
 * };
 *
 * // Decision Layer обработка
 * if (error.type === 'RATE_LIMITED') {
 *   await sleep(error.retryAfter * 1000);
 *   return strategy.retry();
 * }
 * ```
 */

/**
 * ExchangeErrorCode - enum для машинной обработки
 *
 * @remarks
 * Используется для:
 * - Switch statements (exhaustive checking)
 * - Metrics/monitoring (группировка ошибок)
 * - Structured logging
 * - Retry policies (какие ошибки retry-able)
 */
export enum ExchangeErrorCode {
    /** Rate limit от биржи (429) - подождать retryAfter */
    RATE_LIMITED = 'RATE_LIMITED',

    /** Auth failed (401/403) - invalid signature, account suspended */
    AUTH_FAILED = 'AUTH_FAILED',

    /** Рынок закрыт/неактивен - переключиться на другой рынок */
    MARKET_CLOSED = 'MARKET_CLOSED',

    /** Ордер не найден (404) - уже исполнен/отменён */
    ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',

    /** Server error (5xx) - временная проблема биржи, retry */
    SERVER_ERROR = 'SERVER_ERROR',

    /** Network error (timeout, connection refused) - retry */
    NETWORK_ERROR = 'NETWORK_ERROR',

    /** Критическая ошибка - ОСТАНОВИТЬ СТРАТЕГИЮ */
    FATAL = 'FATAL',
}

/**
 * ExchangeError - discriminated union всех exchange ошибок
 *
 * @remarks
 * Включает FatalExchangeError как отдельный вариант.
 * FatalExchangeError ДОЛЖЕН обрабатываться ЯВНО (остановка стратегии).
 */
export type ExchangeError =
    | RateLimitedError
    | AuthFailedError
    | MarketClosedError
    | OrderNotFoundError
    | ServerError
    | NetworkError
    | FatalExchangeError;

/**
 * RateLimitedError - биржа throttle (HTTP 429)
 *
 * @remarks
 * Возникает когда:
 * - Слишком много запросов к API
 * - Превышен rate limit
 *
 * Реакция стратегии:
 * - Подождать retryAfter секунд
 * - Retry тот же запрос
 * - Снизить частоту запросов
 */
export interface RateLimitedError {
    type: 'RATE_LIMITED';
    code: ExchangeErrorCode.RATE_LIMITED;

    /** Секунды до следующей попытки (из Retry-After header) */
    retryAfter?: number;

    /** Описание ошибки */
    message: string;
}

/**
 * AuthFailedError - authentication failed (HTTP 401/403)
 *
 * @remarks
 * Возникает когда:
 * - Invalid signature (неправильный private key)
 * - Expired nonce
 * - Account suspended/banned
 *
 * Реакция стратегии:
 * - Проверить credentials
 * - Остановить стратегию (если account suspended)
 * - Алерт разработчику
 */
export interface AuthFailedError {
    type: 'AUTH_FAILED';
    code: ExchangeErrorCode.AUTH_FAILED;

    /** Причина auth failure */
    reason: string;

    /** HTTP status code (401 или 403) */
    httpStatus: 401 | 403;
}

/**
 * MarketClosedError - рынок закрыт/неактивен
 *
 * @remarks
 * Возникает когда:
 * - Market expired (прошёл endDate)
 * - Market inactive (временно закрыт)
 * - Market resolved (результат известен)
 *
 * Реакция стратегии:
 * - Переключиться на другой рынок
 * - Закрыть существующие позиции (если возможно)
 * - Пропустить trade
 */
export interface MarketClosedError {
    type: 'MARKET_CLOSED';
    code: ExchangeErrorCode.MARKET_CLOSED;

    /** Market ID / Token ID */
    marketId: string;

    /** Причина закрытия */
    reason: string;
}

/**
 * OrderNotFoundError - ордер не найден (HTTP 404)
 *
 * @remarks
 * Возникает когда:
 * - Ордер уже исполнен (filled)
 * - Ордер уже отменён (cancelled)
 * - Ордер никогда не существовал (неправильный ID)
 *
 * Реакция стратегии:
 * - Проверить статус ордера через getOpenOrders()
 * - Продолжить (не критично)
 */
export interface OrderNotFoundError {
    type: 'ORDER_NOT_FOUND';
    code: ExchangeErrorCode.ORDER_NOT_FOUND;

    /** Order ID который не найден */
    orderId: string;
}

/**
 * ServerError - биржа вернула 5xx (HTTP 500-599)
 *
 * @remarks
 * Возникает когда:
 * - Internal server error (500)
 * - Service unavailable (503)
 * - Gateway timeout (504)
 *
 * Это ВРЕМЕННАЯ ошибка биржи.
 *
 * Реакция стратегии:
 * - Retry с exponential backoff
 * - Максимум 3-5 retry
 * - Если все retry failed → переключиться на другую биржу
 */
export interface ServerError {
    type: 'SERVER_ERROR';
    code: ExchangeErrorCode.SERVER_ERROR;

    /** HTTP status code (500-599) */
    status: number;

    /** Описание ошибки */
    message: string;
}

/**
 * NetworkError - network layer error (timeout, connection refused)
 *
 * @remarks
 * Возникает когда:
 * - Connection timeout
 * - DNS resolution failed
 * - Connection refused
 * - SSL/TLS error
 *
 * Это ВРЕМЕННАЯ ошибка network layer.
 *
 * Реакция стратегии:
 * - Проверить соединение
 * - Retry с exponential backoff
 * - Если все retry failed → алерт о проблемах с сетью
 */
export interface NetworkError {
    type: 'NETWORK_ERROR';
    code: ExchangeErrorCode.NETWORK_ERROR;

    /** Описание ошибки */
    message: string;
}

/**
 * FatalExchangeError - критическая ошибка (ОСТАНОВИТЬ СТРАТЕГИЮ)
 *
 * @remarks
 * ⚠️ КРИТИЧЕСКАЯ ОШИБКА ⚠️
 *
 * Возникает когда:
 * - Получен HTTP response который НЕ смогли распарсить
 * - Биржа вернула новый тип ошибки (API breaking change)
 * - Response body не соответствует ожидаемому формату
 * - Неизвестный HTTP status code
 *
 * КРИТИЧЕСКИ ВАЖНО:
 * ❌ НЕ retry автоматически (можем усугубить проблему)
 * ❌ НЕ игнорировать (можем потерять деньги)
 * ✅ Логировать с ПОЛНЫМ контекстом (для investigation)
 * ✅ Останавливать стратегию (fail-safe)
 * ✅ Алертить разработчика (требует manual investigation)
 *
 * Decision Layer ДОЛЖЕН:
 * - Проверять FATAL в ПЕРВУЮ очередь
 * - Останавливать торговлю НЕМЕДЛЕННО
 * - НЕ пытаться "угадать" что делать
 * - Логировать ВСЁ (httpStatus, responseBody, raw error)
 *
 * @example
 * ```typescript
 * if (error.type === 'FATAL') {
 *   logger.error('[CRITICAL] Fatal exchange error', {
 *     httpStatus: error.httpStatus,
 *     responseBody: error.responseBody,
 *     message: error.message,
 *   });
 *
 *   strategy.stopStrategy(); // ← ОСТАНОВИТЬ
 *   alertDeveloper(error);    // ← АЛЕРТ
 *
 *   throw new Error('Strategy stopped due to fatal error');
 * }
 * ```
 */
export interface FatalExchangeError {
    type: 'FATAL';
    code: ExchangeErrorCode.FATAL;

    /** HTTP status code (для investigation) */
    httpStatus: number;

    /** Raw response body (для investigation) */
    responseBody?: unknown;

    /** Описание проблемы */
    message: string;

    /** Явный флаг требующий manual investigation */
    requiresManualInvestigation: true;
}

/**
 * Проверяет является ли ошибка retryable (временной)
 *
 * @param error - ExchangeError для проверки
 * @returns true если ошибка временная (можно retry)
 *
 * @remarks
 * Retryable errors:
 * - RATE_LIMITED (подождать retryAfter)
 * - SERVER_ERROR (5xx временная проблема биржи)
 * - NETWORK_ERROR (временная проблема сети)
 *
 * Non-retryable errors:
 * - AUTH_FAILED (проблема с credentials)
 * - MARKET_CLOSED (рынок закрыт)
 * - ORDER_NOT_FOUND (ордер не существует)
 * - FATAL (требует manual investigation)
 *
 * @example
 * ```typescript
 * if (isRetryableError(error)) {
 *   await sleep(calculateBackoff(attempt));
 *   return strategy.retry();
 * }
 * ```
 */
export function isRetryableError(error: ExchangeError): boolean {
    return (
        error.type === 'RATE_LIMITED' ||
        error.type === 'SERVER_ERROR' ||
        error.type === 'NETWORK_ERROR'
    );
}

/**
 * Проверяет является ли ошибка фатальной
 *
 * @param error - ExchangeError для проверки
 * @returns true если ошибка фатальная
 *
 * @remarks
 * Фатальная ошибка ТРЕБУЕТ:
 * - Остановки стратегии
 * - Manual investigation
 * - НЕ retry автоматически
 *
 * @example
 * ```typescript
 * if (isFatalError(error)) {
 *   strategy.stopStrategy();
 *   alertDeveloper(error);
 * }
 * ```
 */
export function isFatalError(error: ExchangeError): error is FatalExchangeError {
    return error.type === 'FATAL';
}
