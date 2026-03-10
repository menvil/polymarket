import Decimal from 'decimal.js';
/**
 * Core Quantity Value Object
 *
 * @remarks
 * Представляет количество акций/токенов на рынках предсказаний.
 *
 * Содержит ТОЛЬКО инварианты существования:
 * - Non-negative (>= 0)
 * - Finite value (не Infinity, не NaN)
 *
 * НЕ содержит:
 * - Математику (используй @polymarket/math + QuantityService)
 * - Бизнес-правила minSize (используй Rules/Policy)
 * - Округление (используй QuantityService)
 * - Сериализацию (используй Adapters)
 *
 * Внутреннее представление: хранит Decimal (opaque).
 * Наружу отдаёт Decimal через value() и number через toNumber() (lossy).
 *
 * @example
 * ```typescript
 * // Создание (только в Core/Facade)
 * const qty = Quantity.of(new Decimal(10));
 *
 * // В публичном коде используй QuantityService
 * const result = QuantityService.create(10);
 * if (result.ok) {
 *   const qty = result.value;
 * }
 *
 * // Константы
 * const zero = Quantity.ZERO;
 * const one = Quantity.ONE;
 *
 * // Доступ к значению
 * const decimal = qty1.value();    // Decimal
 * const num = qty1.toNumber();     // number (lossy)
 *
 * // Сравнение (без epsilon)
 * qty1.equals(qty2);     // boolean
 * qty1.isZero();         // boolean
 * qty1.isPositive();     // boolean
 * qty1.isLessThan(qty2); // boolean
 * qty1.isLessThanOrEqual(qty2); // boolean
 * qty1.isGreaterThan(qty2); // boolean
 * qty1.isGreaterThanOrEqual(qty2); // boolean
 *
 * // Для математики используй QuantityService:
 * const result = QuantityService.add(qty1, qty2);
 * ```
 */
export declare class Quantity {
    private readonly _value;
    /**
     * Константы для часто используемых значений
     */
    static readonly ZERO: Quantity;
    static readonly ONE: Quantity;
    private constructor();
    /**
     * Создаёт Quantity из Decimal
     *
     * @internal ТОЛЬКО для внутреннего использования в Core и Facade
     *
     * @remarks
     * НЕ парсит - принимает готовый Decimal.
     * Все проверки инвариантов выполняются в конструкторе.
     * Для публичного API используйте QuantityService.create().
     *
     * Конвертация number/string → Decimal делается в QuantityService (Facade layer).
     *
     * @param value - Значение (Decimal)
     * @returns Новый Quantity
     * @throws {QuantityInvariantViolation} Если значение не соответствует инвариантам
     *
     * @example
     * ```typescript
     * // ✅ В Core и Facade
     * const qty = Quantity.of(new Decimal(10));
     *
     * // ❌ В публичном коде - используй QuantityService.create()
     * const result = QuantityService.create(10);
     * if (!result.ok) {
     *   console.error(result.error);
     * }
     * ```
     */
    static of(value: Decimal): Quantity;
    /**
     * Возвращает Decimal значение
     *
     * @returns Внутренний Decimal объект
     *
     * @example
     * ```typescript
     * const qty = Quantity.of(new Decimal(10));
     * const decimal = qty.value(); // Decimal
     * ```
     */
    value(): Decimal;
    /**
     * Возвращает number значение (lossy conversion)
     *
     * @remarks
     * ⚠️ ВНИМАНИЕ: Преобразование в number может привести к потере точности.
     * Используйте только для отображения или когда точность не критична.
     * Для вычислений используйте value() для получения Decimal.
     *
     * @returns Number значение (может потерять точность для больших чисел)
     *
     * @example
     * ```typescript
     * const qty = Quantity.of(new Decimal("12345678901234567890.123456789"));
     * const num = qty.toNumber(); // Может потерять точность!
     * const decimal = qty.value(); // Сохраняет точность
     * ```
     */
    toNumber(): number;
    /**
     * Проверяет равенство с другим количеством
     *
     * @remarks
     * Точное сравнение без epsilon.
     * Epsilon — это политика сравнения, не свойство Quantity.
     *
     * @param other - Другой Quantity для сравнения
     * @returns true если значения равны, иначе false
     *
     * @example
     * ```typescript
     * const qty1 = Quantity.of(new Decimal(10));
     * const qty2 = Quantity.of(new Decimal(10));
     * const qty3 = Quantity.of(new Decimal(10.0000001));
     *
     * qty1.equals(qty2); // true
     * qty1.equals(qty3); // false (точное сравнение)
     * ```
     */
    equals(other: Quantity): boolean;
    /**
     * Проверяет что количество равно нулю
     *
     * @remarks
     * Точное сравнение без epsilon.
     *
     * @returns true если значение равно 0, иначе false
     *
     * @example
     * ```typescript
     * Quantity.ZERO.isZero();     // true
     * Quantity.of(new Decimal(0)).isZero();    // true
     * Quantity.of(new Decimal(0.0001)).isZero(); // false (точное сравнение)
     * ```
     */
    isZero(): boolean;
    /**
     * Проверяет что количество положительное (> 0)
     *
     * @returns true если значение > 0, иначе false
     *
     * @example
     * ```typescript
     * Quantity.of(new Decimal(10)).isPositive();  // true
     * Quantity.of(new Decimal(0)).isPositive();   // false
     * Quantity.ZERO.isPositive();    // false
     * ```
     */
    isPositive(): boolean;
    /**
     * Проверяет что это количество меньше другого
     *
     * @remarks
     * Точное сравнение без epsilon.
     *
     * @param other - Другой Quantity для сравнения
     * @returns true если this < other, иначе false
     *
     * @example
     * ```typescript
     * const qty1 = Quantity.of(new Decimal(5));
     * const qty2 = Quantity.of(new Decimal(10));
     *
     * qty1.isLessThan(qty2);  // true
     * qty2.isLessThan(qty1);  // false
     * qty1.isLessThan(qty1);  // false (равны)
     * ```
     */
    isLessThan(other: Quantity): boolean;
    /**
     * Проверяет что это количество меньше или равно другому
     *
     * @remarks
     * Точное сравнение без epsilon.
     *
     * @param other - Другой Quantity для сравнения
     * @returns true если this <= other, иначе false
     *
     * @example
     * ```typescript
     * const qty1 = Quantity.of(new Decimal(5));
     * const qty2 = Quantity.of(new Decimal(10));
     *
     * qty1.isLessThanOrEqual(qty2);  // true
     * qty2.isLessThanOrEqual(qty1);  // false
     * qty1.isLessThanOrEqual(qty1);  // true (равны)
     * ```
     */
    isLessThanOrEqual(other: Quantity): boolean;
    /**
     * Проверяет что это количество больше другого
     *
     * @remarks
     * Точное сравнение без epsilon.
     *
     * @param other - Другой Quantity для сравнения
     * @returns true если this > other, иначе false
     *
     * @example
     * ```typescript
     * const qty1 = Quantity.of(new Decimal(10));
     * const qty2 = Quantity.of(new Decimal(5));
     *
     * qty1.isGreaterThan(qty2);  // true
     * qty2.isGreaterThan(qty1);  // false
     * qty1.isGreaterThan(qty1);  // false (равны)
     * ```
     */
    isGreaterThan(other: Quantity): boolean;
    /**
     * Проверяет что это количество больше или равно другому
     *
     * @remarks
     * Точное сравнение без epsilon.
     *
     * @param other - Другой Quantity для сравнения
     * @returns true если this >= other, иначе false
     *
     * @example
     * ```typescript
     * const qty1 = Quantity.of(new Decimal(10));
     * const qty2 = Quantity.of(new Decimal(5));
     *
     * qty1.isGreaterThanOrEqual(qty2);  // true
     * qty2.isGreaterThanOrEqual(qty1);  // false
     * qty1.isGreaterThanOrEqual(qty1);  // true (равны)
     * ```
     */
    isGreaterThanOrEqual(other: Quantity): boolean;
}
//# sourceMappingURL=Quantity.d.ts.map