/**
 * Quote Value Object Module
 *
 * @remarks
 * Публичный API для работы с котировками маркет-мейкера.
 *
 * Архитектура:
 * - Core Layer: Quote (value object с бизнес-логикой)
 * - Facade Layer: QuoteService (Result API, "Never Throw" контракт)
 * - Adapters Layer: QuoteSerializer, QuoteFormatter
 * - Rules Layer: валидационные правила для котировок
 *
 * @example
 * ```typescript
 * import { QuoteService, QuoteFormatter, type QuoteJson } from '@polymarket/value-objects/quote';
 *
 * // Создание котировки через Facade
 * const result = QuoteService.create(0.48, 0.52, 100, 150);
 * if (!result.ok) {
 *   console.error(result.error.message);
 *   return;
 * }
 *
 * const quote = result.value;
 *
 * // Вычисления
 * console.log(quote.spreadWidth());      // 0.04
 * console.log(quote.spreadPercentage()); // 8.0%
 * console.log(quote.midPrice());         // 0.50
 *
 * // Форматирование
 * console.log(QuoteFormatter.toDisplay(quote));
 * // "0.4800 @ 100.00 / 0.5200 @ 150.00"
 *
 * console.log(QuoteFormatter.toShort(quote));
 * // "0.4800/0.5200"
 *
 * // Сериализация
 * const json = QuoteSerializer.toJSON(quote);
 * const jsonString = QuoteSerializer.toString(quote);
 * ```
 */

// ============================================================================
// Core Layer - Value Object
// ============================================================================

/**
 * Quote - основной value object для котировок
 *
 * @remarks
 * Используется внутри приложения для бизнес-логики.
 * Конструктор приватный, создание через Quote.of() (может бросать исключения).
 * Для безопасного создания используйте QuoteService.create().
 */
export { Quote } from './core/index.js';

/**
 * QuoteInvariantViolation - исключение при нарушении инвариантов
 *
 * @remarks
 * Бросается из Quote.of() при попытке создать невалидную котировку.
 */
export { QuoteInvariantViolation } from './core/index.js';

// ============================================================================
// Facade Layer - Result API ("Never Throw")
// ============================================================================

/**
 * QuoteService - главный фасад для работы с котировками
 *
 * @remarks
 * Все методы используют Result<T, E> и никогда не бросают исключения.
 * Рекомендуется использовать этот сервис вместо прямого создания Quote.
 *
 * Методы:
 * - createFromDecimals() - создание из Decimal значений
 * - create() - создание из number значений
 * - bidOnly() - создание bid-only котировки
 * - askOnly() - создание ask-only котировки
 * - shift() - сдвиг котировки на дельту
 * - skew() - независимый сдвиг bid и ask
 * - updateSizes() - обновление размеров
 * - getSpreadOrZero() - получение spread (0 для one-sided)
 * - getMidOrNull() - получение mid price (null для one-sided)
 */
export { QuoteService } from './facade/index.js';

// ============================================================================
// Adapters Layer - Serialization & Formatting
// ============================================================================

/**
 * QuoteSerializer - сериализация/десериализация Quote в JSON
 *
 * @remarks
 * Методы:
 * - toJSON() - Quote → QuoteJson
 * - fromJSON() - QuoteJson → Result<Quote>
 * - toString() - Quote → JSON string
 * - parse() - JSON string → Result<Quote>
 */
export { QuoteSerializer } from './adapters/index.js';

/**
 * QuoteJson - интерфейс для JSON-представления котировки
 */
export type { QuoteJson } from './adapters/index.js';

/**
 * QuoteFormatter - форматирование котировок для отображения
 *
 * @remarks
 * Методы:
 * - toDisplay() - "bid @ size / ask @ size"
 * - toShort() - "bid/ask"
 * - toDetailed() - полный формат с spread и mid
 * - toTable() - табличный формат
 * - formatSpread() - форматирование spread
 * - formatMid() - форматирование mid price
 */
export { QuoteFormatter } from './adapters/index.js';

/**
 * QuoteFormatOptions - опции форматирования
 */
export type { QuoteFormatOptions } from './adapters/index.js';

// ============================================================================
// Errors
// ============================================================================

/**
 * QuoteErrorReason - типизированные причины ошибок
 *
 * @remarks
 * Enum со всеми возможными причинами ошибок при работе с котировками:
 * - BOTH_SIDES_NULL - отсутствуют bid и ask
 * - BID_GREATER_THAN_ASK - bid >= ask
 * - INVALID_FORMAT - ошибка парсинга
 * - INVALID_BID - невалидная цена bid
 * - INVALID_ASK - невалидная цена ask
 * - INVALID_BID_SIZE - невалидный размер bid
 * - INVALID_ASK_SIZE - невалидный размер ask
 * - BID_SIZE_MUST_BE_POSITIVE - размер bid должен быть > 0
 * - ASK_SIZE_MUST_BE_POSITIVE - размер ask должен быть > 0
 * - SPREAD_TOO_NARROW - spread меньше минимального
 * - SPREAD_TOO_WIDE - spread больше максимального
 * - MARKET_CROSSING - котировка пересекает рынок
 */
export { QuoteErrorReason } from './errors/index.js';

// ============================================================================
// Rules Layer - Validation Rules
// ============================================================================

/**
 * ValidateQuoteSizes - проверка размеров котировки
 *
 * @remarks
 * Правило: если есть price, то size должен быть > 0
 */
export { ValidateQuoteSizes } from './rules/ValidateQuoteSizes.js';

/**
 * ValidateMinSpread - проверка минимального spread
 *
 * @remarks
 * Правило: spread >= minSpread
 */
export { ValidateMinSpread } from './rules/ValidateMinSpread.js';

/**
 * ValidateMaxSpread - проверка максимального spread
 *
 * @remarks
 * Правило: spread <= maxSpread
 */
export { ValidateMaxSpread } from './rules/ValidateMaxSpread.js';

/**
 * ValidateMarketCrossing - проверка пересечения с orderbook
 *
 * @remarks
 * Правила:
 * - quote bid < orderbook ask
 * - quote ask > orderbook bid
 */
export { ValidateMarketCrossing } from './rules/ValidateMarketCrossing.js';
