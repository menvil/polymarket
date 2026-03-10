import { type Result } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import { Spread } from '../core/Spread.js';
/**
 * JSON контракт для Spread сериализации
 *
 * @remarks
 * Используется как:
 * - Контракт API (документация структуры)
 * - Return type для toJSON()
 * - Type hint при создании JSON
 *
 * При парсинге (fromJSON) НЕ полагайся на этот тип -
 * делай полную runtime валидацию с unknown!
 */
export interface SpreadJSON {
    /**
     * Bid price (number)
     */
    bid: number;
    /**
     * Ask price (number)
     */
    ask: number;
}
/**
 * Сериализатор для Spread
 *
 * @remarks
 * ГРАНИЦА СИСТЕМЫ: принимает unknown, выполняет полную runtime валидацию.
 *
 * Отвечает за преобразование между Spread и JSON:
 * - toJSON(): Spread → SpreadJSON (type-safe)
 * - fromJSON(): unknown → Result<Spread> (runtime-safe)
 *
 * Контракт:
 * - fromJSON НИКОГДА не доверяет типам, делает полную проверку
 * - toJSON ВСЕГДА возвращает валидный SpreadJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
 *
 * // Сериализация (type-safe)
 * const json = SpreadSerializer.toJSON(spread);
 * console.log(json); // { bid: 0.48, ask: 0.52 }
 *
 * // Десериализация (runtime-safe)
 * const result = SpreadSerializer.fromJSON({ bid: 0.48, ask: 0.52 });
 * if (result.ok) {
 *   console.log(result.value.width()); // Decimal(0.04)
 * }
 *
 * // Валидация работает
 * const invalid = SpreadSerializer.fromJSON({ bid: "invalid" });
 * console.log(invalid.ok); // false
 * ```
 */
export declare class SpreadSerializer {
    private static readonly SERVICE_NAME;
    /**
     * Сериализовать Spread в JSON объект
     *
     * @param spread - Spread для сериализации
     * @returns SpreadJSON объект с bid/ask как numbers
     *
     * @remarks
     * Возвращает строго типизированный SpreadJSON.
     * Гарантирует что все поля присутствуют и имеют правильные типы.
     */
    static toJSON(spread: Spread): SpreadJSON;
    /**
     * Десериализовать Spread из JSON объекта
     *
     * @param json - Неизвестный объект для парсинга (unknown)
     * @returns Result со Spread или InvalidSpreadError
     *
     * @remarks
     * **ПОЛНАЯ RUNTIME ВАЛИДАЦИЯ:**
     * 1. Проверяет что json это объект
     * 2. Проверяет наличие полей bid и ask
     * 3. Проверяет что bid и ask это numbers
     * 4. Делегирует создание в SpreadService для бизнес-валидации
     *
     * НЕ использует type casts без проверок!
     * НЕ доверяет TypeScript types на границе системы!
     *
     * @example
     * ```typescript
     * // Валидный JSON
     * const ok = SpreadSerializer.fromJSON({ bid: 0.48, ask: 0.52 });
     *
     * // Невалидные случаи (все возвращают Err)
     * SpreadSerializer.fromJSON(null);              // не объект
     * SpreadSerializer.fromJSON({});                // отсутствуют поля
     * SpreadSerializer.fromJSON({ bid: 0.5 });      // отсутствует ask
     * SpreadSerializer.fromJSON({ bid: "0.5", ask: 0.52 }); // неверный тип
     * SpreadSerializer.fromJSON({ bid: 0.6, ask: 0.5 });    // bid > ask (бизнес-правило)
     * ```
     */
    static fromJSON(json: unknown): Result<Spread, InvalidSpreadError>;
    /**
     * Сериализовать в JSON строку
     *
     * @param spread - Spread для сериализации
     * @returns JSON строка
     */
    static toJSONString(spread: Spread): string;
    /**
     * Десериализовать из JSON строки
     *
     * @param jsonString - JSON строка
     * @returns Result со Spread или InvalidSpreadError
     */
    static fromJSONString(jsonString: string): Result<Spread, InvalidSpreadError>;
}
//# sourceMappingURL=SpreadSerializer.d.ts.map