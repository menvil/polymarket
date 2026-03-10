import { Err } from '@polymarket/result';
import { InvalidSpreadError, ErrorSource } from '@polymarket/errors';
import { SpreadService } from '../facade/SpreadService.js';
import { SpreadErrorReason } from '../errors/SpreadErrorReason.js';
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
export class SpreadSerializer {
    static SERVICE_NAME = 'SpreadSerializer';
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
    static toJSON(spread) {
        return {
            bid: spread.bid().value().toNumber(),
            ask: spread.ask().value().toNumber(),
        };
    }
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
    static fromJSON(json) {
        const op = 'fromJSON';
        // Шаг 1: Проверка что это объект
        if (typeof json !== 'object' || json === null) {
            return Err(new InvalidSpreadError('Expected object, got ' + (json === null ? 'null' : typeof json), {
                context: {
                    source: ErrorSource.PARSING,
                    service: SpreadSerializer.SERVICE_NAME,
                    op,
                    raw: { json: String(json) },
                    reason: SpreadErrorReason.INVALID_DTO
                }
            }));
        }
        // Шаг 2: Проверка наличия поля bid
        if (!('bid' in json)) {
            return Err(new InvalidSpreadError('Missing required field: bid', {
                context: {
                    source: ErrorSource.PARSING,
                    service: SpreadSerializer.SERVICE_NAME,
                    op,
                    raw: { json: JSON.stringify(json) },
                    reason: SpreadErrorReason.INVALID_DTO
                }
            }));
        }
        // Шаг 3: Проверка наличия поля ask
        if (!('ask' in json)) {
            return Err(new InvalidSpreadError('Missing required field: ask', {
                context: {
                    source: ErrorSource.PARSING,
                    service: SpreadSerializer.SERVICE_NAME,
                    op,
                    raw: { json: JSON.stringify(json) },
                    reason: SpreadErrorReason.INVALID_DTO
                }
            }));
        }
        // Теперь безопасно извлекаем поля
        const { bid, ask } = json;
        // Шаг 4: Проверка типа bid
        if (typeof bid !== 'number') {
            return Err(new InvalidSpreadError(`Invalid type for field 'bid': expected number, got ${typeof bid}`, {
                context: {
                    source: ErrorSource.PARSING,
                    service: SpreadSerializer.SERVICE_NAME,
                    op,
                    raw: { field: 'bid', value: String(bid), type: typeof bid },
                    reason: SpreadErrorReason.INVALID_DTO
                }
            }));
        }
        // Шаг 5: Проверка типа ask
        if (typeof ask !== 'number') {
            return Err(new InvalidSpreadError(`Invalid type for field 'ask': expected number, got ${typeof ask}`, {
                context: {
                    source: ErrorSource.PARSING,
                    service: SpreadSerializer.SERVICE_NAME,
                    op,
                    raw: { field: 'ask', value: String(ask), type: typeof ask },
                    reason: SpreadErrorReason.INVALID_DTO
                }
            }));
        }
        // Шаг 6: Делегируем бизнес-валидацию и создание в SpreadService
        return SpreadService.fromValues(bid, ask);
    }
    /**
     * Сериализовать в JSON строку
     *
     * @param spread - Spread для сериализации
     * @returns JSON строка
     */
    static toJSONString(spread) {
        return JSON.stringify(SpreadSerializer.toJSON(spread));
    }
    /**
     * Десериализовать из JSON строки
     *
     * @param jsonString - JSON строка
     * @returns Result со Spread или InvalidSpreadError
     */
    static fromJSONString(jsonString) {
        try {
            const parsed = JSON.parse(jsonString);
            return SpreadSerializer.fromJSON(parsed);
        }
        catch (error) {
            return Err(new InvalidSpreadError(`Invalid JSON string: ${error instanceof Error ? error.message : String(error)}`, {
                context: {
                    source: ErrorSource.PARSING,
                    service: SpreadSerializer.SERVICE_NAME,
                    op: 'fromJSONString',
                    raw: { jsonString },
                    error: error instanceof Error ? error.message : String(error),
                    reason: SpreadErrorReason.INVALID_JSON
                }
            }));
        }
    }
}
//# sourceMappingURL=SpreadSerializer.js.map