/**
 * SignedQuantity Value Object
 *
 * @remarks
 * Представляет знаковое количество (может быть положительным, отрицательным или нулем).
 *
 * Инварианты:
 * - Must be finite (не NaN, не Infinity)
 * - Нормализация -0 → 0
 *
 * Используется для:
 * - Изменения позиций (position deltas)
 * - Profit & Loss (P&L)
 * - Нетто-позиции (net positions)
 * - Любые знаковые количества
 *
 * Отличия от Quantity:
 * - Quantity: >= 0 (только неотрицательные)
 * - SignedQuantity: любое конечное число (может быть отрицательным)
 *
 * @example
 * ```typescript
 * import { SignedQuantity } from '@polymarket/value-objects';
 * import Decimal from 'decimal.js';
 *
 * // Положительное изменение
 * const increase = SignedQuantity.of(new Decimal(10));
 *
 * // Отрицательное изменение
 * const decrease = SignedQuantity.of(new Decimal(-10));
 *
 * // Ноль
 * const noChange = SignedQuantity.ZERO;
 *
 * // Проверка знака
 * if (qty.isPositive()) { console.log('Положительное'); }
 * if (qty.isNegative()) { console.log('Отрицательное'); }
 * const sign = qty.sign(); // -1 | 0 | 1
 *
 * // Абсолютное значение
 * const abs = qty.abs(); // SignedQuantity
 *
 * // Инверсия знака
 * const negated = qty.neg(); // SignedQuantity
 * ```
 */
import Decimal from 'decimal.js';
/**
 * SignedQuantity - знаковое количество
 *
 * @remarks
 * Immutable value object для представления знаковых количеств.
 * Хранит Decimal integer/decimal для точности.
 *
 * Core содержит ТОЛЬКО:
 * - of(Decimal) — создание из валидированного Decimal
 * - Instance методы (value, comparisons, sign operations)
 *
 * Для создания из number/string используйте SignedQuantityService.
 */
export declare class SignedQuantity {
    private readonly _value;
    /**
     * Константы для часто используемых значений
     */
    static readonly ZERO: SignedQuantity;
    static readonly ONE: SignedQuantity;
    static readonly MINUS_ONE: SignedQuantity;
    /**
     * Приватный конструктор - используйте static фабрики
     *
     * @param _value - Значение как Decimal
     */
    private constructor();
    /**
     * Создаёт SignedQuantity из Decimal
     *
     * @internal ТОЛЬКО для внутреннего использования в Core и Facade
     *
     * @remarks
     * НЕ парсит - принимает готовый Decimal.
     * Автоматически нормализует -0 в 0.
     * Все проверки инвариантов выполняются в конструкторе.
     * Для публичного API используйте SignedQuantityService.create().
     *
     * @param value - Значение (Decimal)
     * @returns Новый SignedQuantity
     * @throws {SignedQuantityInvariantViolation} Если значение не соответствует инвариантам
     *
     * @example
     * ```typescript
     * // ✅ В Core и Facade
     * const qty = SignedQuantity.of(new Decimal(10));
     * const negative = SignedQuantity.of(new Decimal(-10));
     *
     * // Нормализация -0
     * const zero1 = SignedQuantity.of(new Decimal(-0)); // → 0
     * const zero2 = SignedQuantity.of(new Decimal(0));  // → 0
     * console.log(zero1.equals(zero2)); // true
     *
     * // ❌ В публичном коде - используй SignedQuantityService.create()
     * const result = SignedQuantityService.create(10);
     * if (!result.ok) {
     *   console.error(result.error);
     * }
     * ```
     */
    static of(value: Decimal): SignedQuantity;
    /**
     * Возвращает Decimal значение
     *
     * @returns Внутренний Decimal объект
     *
     * @example
     * ```typescript
     * const qty = SignedQuantity.of(new Decimal(-10));
     * const decimal = qty.value(); // Decimal(-10)
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
     * const qty = SignedQuantity.of(new Decimal("-12345678901234567890.123456789"));
     * const num = qty.toNumber(); // Может потерять точность!
     * const decimal = qty.value(); // Сохраняет точность
     * ```
     */
    toNumber(): number;
    /**
     * Проверяет равенство с другим SignedQuantity
     *
     * @param other - Другой SignedQuantity
     * @returns true если значения равны
     *
     * @remarks
     * СТРОГОЕ равенство без epsilon (использует Decimal.equals).
     *
     * @example
     * ```typescript
     * const qty1 = SignedQuantity.of(new Decimal(-10));
     * const qty2 = SignedQuantity.of(new Decimal(-10));
     * console.log(qty1.equals(qty2)); // true
     *
     * // Нормализация -0
     * const zero1 = SignedQuantity.of(new Decimal(-0));
     * const zero2 = SignedQuantity.of(new Decimal(0));
     * console.log(zero1.equals(zero2)); // true
     * ```
     */
    equals(other: SignedQuantity): boolean;
    /**
     * Проверяет, является ли значение нулем
     *
     * @returns true если значение равно нулю
     *
     * @example
     * ```typescript
     * const zero = SignedQuantity.ZERO;
     * console.log(zero.isZero()); // true
     *
     * const qty = SignedQuantity.of(new Decimal(-10));
     * console.log(qty.isZero()); // false
     * ```
     */
    isZero(): boolean;
    /**
     * Проверяет, является ли значение положительным
     *
     * @returns true если значение > 0
     *
     * @example
     * ```typescript
     * const positive = SignedQuantity.of(new Decimal(10));
     * console.log(positive.isPositive()); // true
     *
     * const negative = SignedQuantity.of(new Decimal(-10));
     * console.log(negative.isPositive()); // false
     *
     * const zero = SignedQuantity.ZERO;
     * console.log(zero.isPositive()); // false
     * ```
     */
    isPositive(): boolean;
    /**
     * Проверяет, является ли значение отрицательным
     *
     * @returns true если значение < 0
     *
     * @example
     * ```typescript
     * const negative = SignedQuantity.of(new Decimal(-10));
     * console.log(negative.isNegative()); // true
     *
     * const positive = SignedQuantity.of(new Decimal(10));
     * console.log(positive.isNegative()); // false
     *
     * const zero = SignedQuantity.ZERO;
     * console.log(zero.isNegative()); // false
     * ```
     */
    isNegative(): boolean;
    /**
     * Проверяет, меньше ли это значение другого
     *
     * @param other - Другой SignedQuantity
     * @returns true если this < other
     *
     * @example
     * ```typescript
     * const smaller = SignedQuantity.of(new Decimal(-10));
     * const larger = SignedQuantity.of(new Decimal(5));
     * console.log(smaller.isLessThan(larger)); // true
     * ```
     */
    isLessThan(other: SignedQuantity): boolean;
    /**
     * Проверяет, меньше или равно ли это значение другому
     *
     * @param other - Другой SignedQuantity
     * @returns true если this <= other
     *
     * @example
     * ```typescript
     * const qty1 = SignedQuantity.of(new Decimal(-10));
     * const qty2 = SignedQuantity.of(new Decimal(-10));
     * console.log(qty1.isLessThanOrEqual(qty2)); // true
     * ```
     */
    isLessThanOrEqual(other: SignedQuantity): boolean;
    /**
     * Проверяет, больше ли это значение другого
     *
     * @param other - Другой SignedQuantity
     * @returns true если this > other
     *
     * @example
     * ```typescript
     * const larger = SignedQuantity.of(new Decimal(5));
     * const smaller = SignedQuantity.of(new Decimal(-10));
     * console.log(larger.isGreaterThan(smaller)); // true
     * ```
     */
    isGreaterThan(other: SignedQuantity): boolean;
    /**
     * Проверяет, больше или равно ли это значение другому
     *
     * @param other - Другой SignedQuantity
     * @returns true если this >= other
     *
     * @example
     * ```typescript
     * const qty1 = SignedQuantity.of(new Decimal(10));
     * const qty2 = SignedQuantity.of(new Decimal(10));
     * console.log(qty1.isGreaterThanOrEqual(qty2)); // true
     * ```
     */
    isGreaterThanOrEqual(other: SignedQuantity): boolean;
    /**
     * Возвращает знак числа
     *
     * @returns -1 (отрицательное), 0 (ноль), 1 (положительное)
     *
     * @remarks
     * Возвращает строго типизированный union type для type safety.
     *
     * @example
     * ```typescript
     * const positive = SignedQuantity.of(new Decimal(10));
     * console.log(positive.sign()); // 1
     *
     * const negative = SignedQuantity.of(new Decimal(-10));
     * console.log(negative.sign()); // -1
     *
     * const zero = SignedQuantity.ZERO;
     * console.log(zero.sign()); // 0
     * ```
     */
    sign(): -1 | 0 | 1;
    /**
     * Возвращает абсолютное значение
     *
     * @returns SignedQuantity с абсолютным значением (всегда >= 0)
     *
     * @remarks
     * Возвращает новый SignedQuantity с положительным значением.
     * Инвариант: result.value() >= 0
     *
     * Для конвертации в Quantity используйте:
     * ```typescript
     * const absQty = QuantityService.create(signedQty.abs().value());
     * ```
     *
     * @example
     * ```typescript
     * const negative = SignedQuantity.of(new Decimal(-10.5));
     * const abs = negative.abs(); // SignedQuantity(10.5)
     * console.log(abs.toNumber()); // 10.5
     *
     * const positive = SignedQuantity.of(new Decimal(10.5));
     * const abs2 = positive.abs(); // SignedQuantity(10.5)
     * console.log(abs2.toNumber()); // 10.5
     * ```
     */
    abs(): SignedQuantity;
    /**
     * Возвращает значение с противоположным знаком
     *
     * @returns Новый SignedQuantity с инвертированным знаком
     *
     * @remarks
     * Инверсия знака: положительное → отрицательное, отрицательное → положительное, 0 → 0.
     *
     * @example
     * ```typescript
     * const positive = SignedQuantity.of(new Decimal(10));
     * const negative = positive.neg(); // SignedQuantity(-10)
     *
     * const negative2 = SignedQuantity.of(new Decimal(-10));
     * const positive2 = negative2.neg(); // SignedQuantity(10)
     *
     * const zero = SignedQuantity.ZERO;
     * const stillZero = zero.neg(); // SignedQuantity(0)
     * ```
     */
    neg(): SignedQuantity;
}
//# sourceMappingURL=SignedQuantity.d.ts.map