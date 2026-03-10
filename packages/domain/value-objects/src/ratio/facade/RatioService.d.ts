/**
 * Service facade для безопасного создания Ratio
 *
 * @remarks
 * ## Never Throw Contract
 * ВСЕ методы ГАРАНТИРУЮТ возврат Result<T, E> и НИКОГДА не бросают исключения
 *
 * ## Facade Error Contract
 * Каждый Err содержит context с полями:
 * - context.reason: RatioErrorReason (typed enum)
 * - context.op: string (название операции)
 * - context.[field]Value: string (значения, вызвавшие ошибку)
 * - context.source: ErrorSource
 *
 * ## Factory Methods
 * - fromDecimal(): создать из дроби (0.02 для 2%)
 * - fromPercent(): создать из процента (2 для 2%)
 * - fromBps(): создать из basis points (200 для 2%)
 *
 * ## Validation Options
 * - ensureGteMinusOne: проверить, что ratio >= -1 (для операций "1 + ratio")
 * - ensureLteOne: проверить, что ratio <= 1 (для операций "1 - ratio")
 *
 * @example
 * ```typescript
 * // Создание из разных форматов
 * const r1 = RatioService.fromDecimal(0.02); // 2%
 * const r2 = RatioService.fromPercent(2); // 2%
 * const r3 = RatioService.fromBps(200); // 2%
 *
 * // С валидацией для onePlus() operations
 * const markup = RatioService.fromPercent(10, { ensureGteMinusOne: true });
 * if (markup.ok) {
 *   // Безопасно: amount * (1 + ratio) не станет отрицательным
 * }
 *
 * // С валидацией для oneMinus() operations
 * const discount = RatioService.fromPercent(15, { ensureLteOne: true });
 * if (discount.ok) {
 *   // Безопасно: amount * (1 - ratio) не станет отрицательным
 * }
 * ```
 */
import Decimal from 'decimal.js';
import { Result } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import { Ratio } from '../core/Ratio.js';
/**
 * Опции для создания Ratio
 */
export interface RatioCreateOptions {
    /**
     * Проверить, что ratio >= -1
     * Используется для операций типа amount * (1 + ratio)
     */
    ensureGteMinusOne?: boolean;
    /**
     * Проверить, что ratio <= 1
     * Используется для операций типа amount * (1 - ratio)
     */
    ensureLteOne?: boolean;
}
export declare class RatioService {
    private static readonly SERVICE_NAME;
    /**
     * Создать Ratio из дроби (fraction)
     *
     * @param value - Дробь: 0.02 для 2%, 0.5 для 50%
     * @param options - Опции валидации
     * @returns Result с Ratio или InvalidRatioError
     * @throws Никогда - все ошибки оборачиваются в Result
     *
     * @remarks
     * Алгоритм работы (все шаги внутри wrapOp):
     * 1. Парсим value в Decimal через toDecimal()
     *    - Проверка на NaN, Infinity, невалидный формат
     *    - При ошибке возвращаем Err с reason INVALID_FORMAT
     * 2. Опциональная валидация ensureGteMinusOne
     *    - Проверяем decimal >= -1
     *    - При ошибке возвращаем Err с reason LESS_THAN_MINUS_ONE
     * 3. Опциональная валидация ensureLteOne
     *    - Проверяем decimal <= 1
     *    - При ошибке возвращаем Err с reason GREATER_THAN_ONE
     * 4. Создаём Ratio через Ratio.of(decimal)
     *    - Если invariant нарушен (NaN/Infinity) - wrapOp ловит и оборачивает
     *
     * Все ошибки автоматически обогащаются контекстом через wrapOp:
     * - service: 'RatioService'
     * - op: 'fromDecimal'
     * - raw: { field: 'decimal', value: String(value) }
     *
     * @example
     * ```typescript
     * const ratioResult = RatioService.fromDecimal(0.02);
     * if (ratioResult.ok) {
     *   console.log(ratioResult.value.toDecimal()); // Decimal(0.02)
     * }
     *
     * // С валидацией
     * const validRatio = RatioService.fromDecimal(-0.5, { ensureGteMinusOne: true });
     * // OK: -0.5 >= -1
     *
     * const invalidRatio = RatioService.fromDecimal(-1.5, { ensureGteMinusOne: true });
     * // Err: -1.5 < -1, reason = LESS_THAN_MINUS_ONE
     * ```
     */
    static fromDecimal(value: number | string | Decimal, options?: RatioCreateOptions): Result<Ratio, InvalidRatioError>;
    /**
     * Создать Ratio из процента (2 для 2%)
     *
     * @param percent - Процент: 2 для 2%, 50 для 50%
     * @param options - Опции валидации
     * @returns Result с Ratio или InvalidRatioError
     * @throws Никогда - все ошибки оборачиваются в Result
     *
     * @remarks
     * Алгоритм работы (все шаги внутри wrapOp):
     * 1. Парсим percent в Decimal через toDecimal()
     *    - Проверка на NaN, Infinity, невалидный формат
     *    - При ошибке возвращаем Err с reason INVALID_FORMAT
     * 2. Конвертируем процент в дробь: fraction = percent / 100
     *    - 2% → 0.02
     *    - 50% → 0.5
     * 3. Опциональная валидация ensureGteMinusOne
     *    - Проверяем fraction >= -1 (например, -100% = -1)
     * 4. Опциональная валидация ensureLteOne
     *    - Проверяем fraction <= 1 (например, 100% = 1)
     * 5. Создаём Ratio через Ratio.of(fraction)
     *
     * Все ошибки автоматически обогащаются контекстом через wrapOp:
     * - service: 'RatioService'
     * - op: 'fromPercent'
     * - raw: { field: 'percent', value: String(percent) }
     *
     * @example
     * ```typescript
     * const ratioResult = RatioService.fromPercent(2); // 2% => 0.02
     * if (ratioResult.ok) {
     *   console.log(ratioResult.value.toDecimal()); // Decimal(0.02)
     * }
     * ```
     */
    static fromPercent(percent: number | string | Decimal, options?: RatioCreateOptions): Result<Ratio, InvalidRatioError>;
    /**
     * Создать Ratio из basis points (200 для 2%)
     *
     * @param bps - Basis points: 200 для 2%, 100 для 1%
     * @param options - Опции валидации
     * @returns Result с Ratio или InvalidRatioError
     * @throws Никогда - все ошибки оборачиваются в Result
     *
     * @remarks
     * Алгоритм работы (все шаги внутри wrapOp):
     * 1. Парсим bps в Decimal через toDecimal()
     *    - Проверка на NaN, Infinity, невалидный формат
     *    - При ошибке возвращаем Err с reason INVALID_FORMAT
     * 2. Конвертируем basis points в дробь: fraction = bps / 10000
     *    - 200 bps → 0.02 (2%)
     *    - 100 bps → 0.01 (1%)
     *    - 10000 bps → 1.0 (100%)
     * 3. Опциональная валидация ensureGteMinusOne
     *    - Проверяем fraction >= -1 (например, -10000 bps = -1)
     * 4. Опциональная валидация ensureLteOne
     *    - Проверяем fraction <= 1 (например, 10000 bps = 1)
     * 5. Создаём Ratio через Ratio.of(fraction)
     *
     * Все ошибки автоматически обогащаются контекстом через wrapOp:
     * - service: 'RatioService'
     * - op: 'fromBps'
     * - raw: { field: 'bps', value: String(bps) }
     *
     * @example
     * ```typescript
     * const ratioResult = RatioService.fromBps(200); // 200 bps => 0.02
     * if (ratioResult.ok) {
     *   console.log(ratioResult.value.toDecimal()); // Decimal(0.02)
     * }
     * ```
     */
    static fromBps(bps: number | string | Decimal, options?: RatioCreateOptions): Result<Ratio, InvalidRatioError>;
    /**
     * Проверить равенство двух Ratio
     *
     * @param a - Первый Ratio
     * @param b - Второй Ratio
     * @returns true если Ratio равны
     *
     * @remarks
     * Простой делегирующий метод для симметрии API с другими Service классами.
     * Используйте напрямую `a.equals(b)` если предпочитаете более короткую запись.
     *
     * **Never Throw Contract:**
     * Гарантированно не бросает исключений. Если a или b равны null/undefined,
     * возвращает false.
     *
     * @example
     * ```typescript
     * const r1 = RatioService.fromPercent(2);
     * const r2 = RatioService.fromDecimal(0.02);
     * if (r1.ok && r2.ok) {
     *   const isEqual = RatioService.equals(r1.value, r2.value);
     *   console.log(isEqual); // true
     * }
     *
     * // Never throws
     * RatioService.equals(null as any, r1.value); // false
     * ```
     */
    static equals(a: Ratio, b: Ratio): boolean;
}
//# sourceMappingURL=RatioService.d.ts.map