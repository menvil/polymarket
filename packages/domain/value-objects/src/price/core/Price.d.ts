import Decimal from 'decimal.js';
/**
 * Core Price Value Object
 *
 * @remarks
 * Представляет цену на Polymarket-like рынках предсказаний.
 * Диапазон: [0.0001, 0.9999]
 *
 * Содержит ТОЛЬКО инварианты существования:
 * - Not NaN
 * - Finite
 * - Диапазон [MIN, MAX] (отрицательные значения автоматически отфильтровываются проверкой MIN)
 * - Строгое равенство
 *
 * Методы toTick/floor/ceil/round УДАЛЕНЫ из Core.
 * Используй PriceService для математических операций.
 */
export declare class Price {
    private readonly _value;
    private static readonly MIN_PRICE;
    private static readonly MAX_PRICE;
    /**
     * Минимальная цена (базовый тик Polymarket)
     * Все tickSize должны быть кратны этому значению
     */
    static readonly MIN: Price;
    /**
     * Максимальная цена
     */
    static readonly MAX: Price;
    /**
     * Половина диапазона
     */
    static readonly HALF: Price;
    private constructor();
    /**
     * Создаёт Price из Decimal (ТОЛЬКО для Core!)
     *
     * @internal ТОЛЬКО для внутреннего использования в Core и Facade
     *
     * @remarks
     * НЕ парсит - принимает готовый Decimal.
     * Все проверки инвариантов выполняются в конструкторе.
     * Для публичного API используйте PriceService.create().
     *
     * Конвертация number/string → Decimal делается в PriceService (Facade layer).
     *
     * @param value - Значение цены (Decimal)
     * @returns Price объект
     * @throws {PriceInvariantViolation} При нарушении инвариантов
     *
     * @example
     * ```typescript
     * // ✅ В Core и Facade
     * const price = Price.of(new Decimal('0.5'));
     *
     * // ❌ В публичном коде - используй PriceService.create()
     * const result = PriceService.create(0.5);
     * if (!result.ok) {
     *   console.error(result.error);
     * }
     * ```
     */
    static of(value: Decimal): Price;
    /**
     * Возвращает Decimal значение
     *
     * @returns Decimal значение цены
     *
     * @example
     * ```typescript
     * const price = Price.of(new Decimal(0.5));
     * const decimal = price.value();
     * console.log(decimal.toString()); // "0.5"
     * ```
     */
    value(): Decimal;
    /**
     * Возвращает number значение
     *
     * @remarks
     * Может потерять точность для очень больших/малых чисел.
     * Для вычислений используйте value().
     *
     * @returns number значение цены
     *
     * @example
     * ```typescript
     * const price = Price.of(new Decimal(0.5));
     * const num = price.toNumber();
     * console.log(num); // 0.5
     * ```
     */
    toNumber(): number;
    /**
     * Проверяет строгое равенство с другой ценой
     *
     * @remarks
     * СТРОГОЕ равенство по Decimal.equals().
     *
     * @param other - Другая цена
     * @returns true если значения строго равны
     *
     * @example
     * ```typescript
     * const price1 = Price.of(new Decimal(0.5));
     * const price2 = Price.of(new Decimal(0.5));
     * console.log(price1.equals(price2)); // true
     * ```
     */
    equals(other: Price): boolean;
    /**
     * Проверяет что эта цена меньше другой
     *
     * @param other - Другая цена
     * @returns true если this < other
     *
     * @example
     * ```typescript
     * const p1 = Price.of(new Decimal(0.5));
     * const p2 = Price.of(new Decimal(0.6));
     * console.log(p1.isLessThan(p2)); // true
     * ```
     */
    isLessThan(other: Price): boolean;
    /**
     * Проверяет что эта цена меньше или равна другой
     *
     * @param other - Другая цена
     * @returns true если this <= other
     *
     * @example
     * ```typescript
     * const p1 = Price.of(new Decimal(0.5));
     * const p2 = Price.of(new Decimal(0.5));
     * console.log(p1.isLessThanOrEqual(p2)); // true
     * ```
     */
    isLessThanOrEqual(other: Price): boolean;
    /**
     * Проверяет что эта цена больше другой
     *
     * @param other - Другая цена
     * @returns true если this > other
     *
     * @example
     * ```typescript
     * const p1 = Price.of(new Decimal(0.6));
     * const p2 = Price.of(new Decimal(0.5));
     * console.log(p1.isGreaterThan(p2)); // true
     * ```
     */
    isGreaterThan(other: Price): boolean;
    /**
     * Проверяет что эта цена больше или равна другой
     *
     * @param other - Другая цена
     * @returns true если this >= other
     *
     * @example
     * ```typescript
     * const p1 = Price.of(new Decimal(0.5));
     * const p2 = Price.of(new Decimal(0.5));
     * console.log(p1.isGreaterThanOrEqual(p2)); // true
     * ```
     */
    isGreaterThanOrEqual(other: Price): boolean;
    /**
     * Проверяет что цена равна нулю
     *
     * @returns false - Price не может быть нулем (MIN = 0.0001)
     *
     * @remarks
     * Этот метод всегда возвращает false, т.к. минимальная цена 0.0001.
     * Добавлен для единообразия API с Quantity и Money.
     *
     * @example
     * ```typescript
     * const price = Price.of(new Decimal(0.5));
     * console.log(price.isZero()); // false (всегда)
     * ```
     */
    isZero(): boolean;
    /**
     * Проверяет что это минимальная цена
     *
     * @returns true если цена равна минимальной
     *
     * @example
     * ```typescript
     * const price = Price.MIN;
     * console.log(price.isMin()); // true
     * ```
     */
    isMin(): boolean;
    /**
     * Проверяет что это максимальная цена
     *
     * @returns true если цена равна максимальной
     *
     * @example
     * ```typescript
     * const price = Price.MAX;
     * console.log(price.isMax()); // true
     * ```
     */
    isMax(): boolean;
}
//# sourceMappingURL=Price.d.ts.map