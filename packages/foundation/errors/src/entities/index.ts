/**
 * Entity Errors - ошибки валидации entities
 *
 * @remarks
 * Этот модуль содержит специализированные классы ошибок для валидации
 * entities в доменной модели торговой системы.
 *
 * Все ошибки:
 * - Наследуются от TradingError
 * - Имеют severity = 'low' (проблемы валидации не критичны)
 * - Поддерживают статические и динамические сообщения
 * - Содержат структурированный context для отладки
 *
 * Категории ошибок:
 *
 * **Валидация рынков:**
 * - MarketValidationError - невалидные данные рынка (Market entity)
 *
 * **Валидация сделок:**
 * - TradeValidationError - невалидные данные сделки (Trade entity)
 *
 * **Валидация ордеров:**
 * - OrderValidationError - невалидные данные ордера (Order entity)
 *
 * **Валидация стакана ордеров:**
 * - OrderbookValidationError - невалидные данные orderbook (Orderbook entity)
 *
 * **Валидация портфеля:**
 * - PortfolioValidationError - невалидные данные портфеля (Portfolio entity)
 *
 * **Валидация позиций:**
 * - PositionValidationError - невалидные данные позиции (Position/PositionLot entity)
 *
 * @example
 * ```typescript
 * import {
 *   MarketValidationError,
 *   TradeValidationError,
 *   OrderValidationError,
 *   OrderbookValidationError,
 *   PortfolioValidationError,
 *   PositionValidationError
 * } from '@polymarket/errors';
 *
 * // Валидация рынка
 * if (!slug || slug.trim() === '') {
 *   throw new MarketValidationError(
 *     'Market slug cannot be empty',
 *     {
 *       code: MarketValidationError.code,
 *       context: { marketId, slug }
 *     }
 *   );
 * }
 *
 * // Валидация сделки
 * if (!['BUY', 'SELL'].includes(side)) {
 *   throw new TradeValidationError(
 *     `Invalid trade side: ${side}`,
 *     {
 *       code: TradeValidationError.code,
 *       context: { tradeId, side, validSides: ['BUY', 'SELL'] }
 *     }
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// Валидация рынков
export * from './MarketValidationError.js';

// Валидация сделок
export * from './TradeValidationError.js';

// Валидация ордеров
export * from './OrderValidationError.js';

// Валидация стакана ордеров
export * from './OrderbookValidationError.js';

// Валидация портфеля
export * from './PortfolioValidationError.js';

// Валидация позиций
export * from './PositionValidationError.js';

// Ошибки портфеля
export * from './InsufficientFundsError.js';
