/**
 * ExecutionResult types - унифицированные результаты execution операций
 *
 * @remarks
 * ⚠️ ВРЕМЕННОЕ РЕШЕНИЕ (TEMPORARY) ⚠️
 *
 * Decision Layer получает ПРЯМОЙ доступ ко всем execution errors.
 * Это допустимо пока Decision Layer = consumer of execution semantics.
 *
 * ПРОБЛЕМА:
 * - Нет промежуточной абстракции
 * - Decision Layer знает все execution детали
 * - Изменение execution errors → breaking change для Decision Layer
 *
 * КОГДА РЕФАКТОРИТЬ:
 * - При добавлении meta-strategies
 * - При добавлении execution policies (throttling, batching)
 * - При добавлении multi-exchange routing
 *
 * БУДУЩЕЕ РЕШЕНИЕ:
 * Создать промежуточный ExecutionSummary:
 *
 * ```typescript
 * type ExecutionSummary =
 *   | { status: 'PLACED'; order: Order }
 *   | { status: 'REJECTED'; reason: string; retryable: boolean }
 *   | { status: 'FAILED'; reason: string; retryable: boolean };
 * ```
 *
 * И маппить PlaceOrderResult → ExecutionSummary внутри execution слоя.
 *
 * ---
 *
 * PlaceOrderError объединяет 2 типа ошибок:
 * - REJECTED (локальная валидация не прошла) - быстрый fail ДО HTTP
 * - FAILED (биржа отказала) - реакция ПОСЛЕ HTTP
 *
 * Decision Layer ДОЛЖЕН обрабатывать оба случая по-разному:
 * - REJECTED → проблема со стратегией (исправить intent)
 * - FAILED → проблема с внешним миром (retry, switch exchange, etc)
 *
 * @example
 * ```typescript
 * const result = await executionService.placeOrder(order);
 *
 * if (!result.ok) {
 *   if (result.error.kind === 'REJECTED') {
 *     // Локальная ошибка - проблема со стратегией
 *     switch (result.error.error.type) {
 *       case 'INSUFFICIENT_BALANCE':
 *         strategy.waitForDeposit();
 *         break;
 *       case 'INVALID_SIZE':
 *         strategy.adjustSize(result.error.error.min);
 *         break;
 *     }
 *   } else if (result.error.kind === 'FAILED') {
 *     // Внешняя ошибка - проблема с биржей/сетью
 *     switch (result.error.error.type) {
 *       case 'RATE_LIMITED':
 *         await sleep(result.error.error.retryAfter * 1000);
 *         return strategy.retry();
 *       case 'FATAL':
 *         strategy.stopStrategy();
 *         alertDeveloper(result.error.error);
 *         break;
 *     }
 *   }
 * }
 * ```
 */

import type { Result } from '../../shared/types/Result.js';
import type { ValidationError } from './ValidationError.js';
import type { ExchangeError } from './ExchangeError.js';
import type { Order } from '../entities/Order.js';

/**
 * PlaceOrderError - унифицированная ошибка размещения ордера
 *
 * @remarks
 * Discriminated union с полем `kind`:
 * - REJECTED: ValidationError (до HTTP, локальная проверка)
 * - FAILED: ExchangeError (после HTTP, внешняя ошибка)
 *
 * Decision Layer использует `kind` для различения:
 * - REJECTED → "я ошибся" (исправить intent, не retry)
 * - FAILED → "мир сломан" (retry, switch exchange)
 */
export type PlaceOrderError =
  | { kind: 'REJECTED'; error: ValidationError }
  | { kind: 'FAILED'; error: ExchangeError };

/**
 * PlaceOrderResult - результат размещения ордера
 *
 * @remarks
 * Result<Order, PlaceOrderError>
 * - Ok: Order успешно размещён (получен orderID от биржи)
 * - Err: ValidationError (REJECTED) или ExchangeError (FAILED)
 *
 * @example
 * ```typescript
 * const result = await executionService.placeOrder(order);
 *
 * if (result.ok) {
 *   console.log('Order placed:', result.value.id);
 * } else {
 *   console.error('Failed:', result.error.kind, result.error.error.type);
 * }
 * ```
 */
export type PlaceOrderResult = Result<Order, PlaceOrderError>;

/**
 * CancelOrderError - унифицированная ошибка отмены ордера
 *
 * @remarks
 * Для cancelOrder обычно НЕТ ValidationError (нечего валидировать).
 * Но можем добавить REJECTED для случая "order already cancelled locally".
 *
 * Пока только FAILED (ExchangeError).
 */
export type CancelOrderError =
  | { kind: 'REJECTED'; error: ValidationError } // Например, order already cancelled
  | { kind: 'FAILED'; error: ExchangeError };

/**
 * CancelOrderResult - результат отмены ордера
 *
 * @remarks
 * Result<void, CancelOrderError>
 * - Ok: void (ордер успешно отменён)
 * - Err: ExchangeError (биржа отказала)
 *
 * @example
 * ```typescript
 * const result = await executionService.cancelOrder(orderId);
 *
 * if (result.ok) {
 *   console.log('Order cancelled');
 * } else {
 *   if (result.error.error.type === 'ORDER_NOT_FOUND') {
 *     console.log('Order already cancelled/filled');
 *   }
 * }
 * ```
 */
export type CancelOrderResult = Result<void, CancelOrderError>;

/**
 * GetOrdersError - ошибка получения списка ордеров
 *
 * @remarks
 * Для getOpenOrders обычно только FAILED (ExchangeError).
 * Нет локальной валидации.
 */
export type GetOrdersError = { kind: 'FAILED'; error: ExchangeError };

/**
 * GetOrdersResult - результат получения списка ордеров
 *
 * @remarks
 * Result<Order[], GetOrdersError>
 * - Ok: массив открытых ордеров
 * - Err: ExchangeError (биржа отказала)
 *
 * @example
 * ```typescript
 * const result = await executionService.getOpenOrders(tokenId);
 *
 * if (result.ok) {
 *   console.log(`Found ${result.value.length} open orders`);
 * } else {
 *   console.error('Failed to fetch orders:', result.error.error.type);
 * }
 * ```
 */
export type GetOrdersResult = Result<Order[], GetOrdersError>;
