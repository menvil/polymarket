import { Result } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Quote } from '../core/Quote.js';
/**
 * JSON контракт для Quote сериализации
 *
 * @remarks
 * Используется как:
 * - Контракт API (документация структуры)
 * - Return type для toJSON()
 * - Type hint при создании JSON
 *
 * При парсинге (fromJSON) НЕ полагайся на этот тип -
 * делай полную runtime валидацию с unknown!
 *
 * Все числовые значения представлены как number для совместимости с JSON.
 */
export interface QuoteJSON {
    /**
     * Цена bid (может быть null для ask-only котировок)
     */
    bid: number | null;
    /**
     * Цена ask (может быть null для bid-only котировок)
     */
    ask: number | null;
    /**
     * Размер bid ордера
     */
    bidSize: number;
    /**
     * Размер ask ордера
     */
    askSize: number;
    /**
     * Временная метка в миллисекундах (Unix timestamp)
     */
    timestamp: number;
    /**
     * ID источника маркет-данных
     */
    sourceId: string;
    /**
     * ID инструмента
     */
    instrumentId: string;
}
/**
 * JSON сериализатор для Quote
 *
 * @remarks
 * ГРАНИЦА СИСТЕМЫ: принимает unknown, валидирует структуру.
 *
 * Отвечает за:
 * - Валидацию типов на границе (unknown → typed)
 * - Сериализацию/десериализацию JSON
 * - Читаемую диагностику через safeStringify
 *
 * Контракт:
 * - fromJSON НИКОГДА не доверяет типам, делает полную проверку
 * - toJSON ВСЕГДА возвращает валидный QuoteJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { QuoteSerializer } from '@polymarket/value-objects/quote';
 *
 * // Десериализация
 * const result = QuoteSerializer.fromJSON({
 *   bid: 0.48,
 *   ask: 0.52,
 *   bidSize: 100,
 *   askSize: 150,
 *   timestamp: Date.now()
 * });
 * if (result.ok) {
 *   const quote = result.value;
 *   console.log(quote.isTwoSided()); // true
 * }
 *
 * // Сериализация
 * const json = QuoteSerializer.toJSON(quote);
 * console.log(json); // { bid: 0.48, ask: 0.52, ... }
 *
 * // String методы
 * const jsonString = QuoteSerializer.toJSONString(quote);
 * const parseResult = QuoteSerializer.fromJSONString(jsonString);
 * ```
 */
export declare class QuoteSerializer {
    private static readonly SERVICE_NAME;
    /**
     * Сериализует Quote в JSON объект
     *
     * @param quote - Quote для сериализации
     * @returns QuoteJSON объект
     *
     * @remarks
     * Возвращает строго типизированный QuoteJSON.
     * Гарантирует что все поля присутствуют и имеют правильные типы.
     * Использует number для совместимости с JSON.
     *
     * @example
     * ```typescript
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
     * const json = QuoteSerializer.toJSON(quote);
     * console.log(json.bid); // 0.48
     * ```
     */
    static toJSON(quote: Quote): QuoteJSON;
    /**
     * Десериализует Quote из JSON объекта
     *
     * @param json - Неизвестный объект для парсинга (unknown)
     * @returns Result с Quote или InvalidQuoteError
     *
     * @remarks
     * **ПОЛНАЯ RUNTIME ВАЛИДАЦИЯ:**
     * 1. Проверяет что json это объект
     * 2. Проверяет наличие всех обязательных полей
     * 3. Проверяет типы всех полей
     * 4. Делегирует создание в QuoteService для бизнес-валидации
     *
     * НЕ использует type casts без проверок!
     * НЕ доверяет TypeScript types на границе системы!
     *
     * @example
     * ```typescript
     * // Валидный JSON
     * const ok = QuoteSerializer.fromJSON({
     *   bid: 0.48,
     *   ask: 0.52,
     *   bidSize: 100,
     *   askSize: 150,
     *   timestamp: Date.now()
     * });
     *
     * // Невалидные случаи (все возвращают Err)
     * QuoteSerializer.fromJSON(null);                     // не объект
     * QuoteSerializer.fromJSON({});                       // отсутствуют поля
     * QuoteSerializer.fromJSON({ bid: "0.5", ... });      // неверный тип
     * QuoteSerializer.fromJSON({ bid: 0.6, ask: 0.5, ...}); // bid > ask (бизнес-правило)
     * ```
     */
    static fromJSON(json: unknown): Result<Quote, InvalidQuoteError>;
    /**
     * Сериализует в JSON строку
     *
     * @param quote - Quote для сериализации
     * @returns JSON строка
     *
     * @example
     * ```typescript
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
     * const jsonString = QuoteSerializer.toJSONString(quote);
     * console.log(jsonString); // '{"bid":0.48,"ask":0.52,...}'
     * ```
     */
    static toJSONString(quote: Quote): string;
    /**
     * Десериализует из JSON строки
     *
     * @param jsonString - JSON строка
     * @returns Result с Quote или InvalidQuoteError
     *
     * @remarks
     * Парсит JSON строку и вызывает fromJSON() для валидации и создания Quote.
     * Обрабатывает ошибки парсинга JSON.
     *
     * @example
     * ```typescript
     * const jsonString = '{"bid":0.48,"ask":0.52,"bidSize":100,"askSize":150,"timestamp":1234567890}';
     * const result = QuoteSerializer.fromJSONString(jsonString);
     *
     * if (result.ok) {
     *   const quote = result.value;
     * } else {
     *   console.error(result.error.message);
     * }
     * ```
     */
    static fromJSONString(jsonString: string): Result<Quote, InvalidQuoteError>;
}
//# sourceMappingURL=QuoteSerializer.d.ts.map