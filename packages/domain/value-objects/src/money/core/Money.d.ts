import Decimal from 'decimal.js';
import { type SupportedCurrency } from '@polymarket/ids';
export type { SupportedCurrency };
/**
 * Представляет денежную сумму с валютой.
 *
 * @remarks
 * ## Архитектура: Core (throws)
 *
 * Money - core value object, который:
 * - Бросает исключения при нарушении инвариантов
 * - НЕ содержит математических методов
 * - НЕ возвращает Result
 *
 * Для безопасного создания используйте {@link MoneyService}.
 *
 * ## Инварианты (enforced в core)
 *
 * 1. Валюта поддерживается (USDC)
 * 2. Сумма finite
 * 3. Сумма не NaN
 * 4. |Сумма| <= MAX_AMOUNT (1e15)
 *
 * ## НЕ инварианты (не в core)
 *
 * - Формат входных данных — парсинг делегируется Decimal
 *
 * ## Контекстные правила (НЕ в core)
 *
 * - Неотрицательность — бизнес-логика
 * - Минимальная сумма — PaymentPolicy
 * - Совпадение валют — MoneyService
 *
 * ## Математика — через MoneyService
 *
 * @see {@link MoneyService}
 * @see {@link MoneyInvariantViolation}
 */
export declare class Money {
    private readonly _amount;
    private readonly _currency;
    static readonly SUPPORTED_CURRENCIES: Set<"USDC">;
    static readonly MAX_AMOUNT: Decimal;
    /**
     * Singleton константы для нулевых сумм каждой валюты
     *
     * @remarks
     * Автоматически создаётся для всех валют из SUPPORTED_CURRENCIES.
     * При добавлении новой валюты - singleton создаётся автоматически.
     *
     * @example
     * ```typescript
     * const zero = Money.ZERO.USDC;
     * console.log(zero.value().toNumber()); // 0
     *
     * // После добавления EUR в SUPPORTED_CURRENCIES:
     * const zeroEur = Money.ZERO.EUR; // ✅ Автоматически доступен!
     * ```
     */
    static readonly ZERO: Record<SupportedCurrency, Money>;
    private constructor();
    /**
     * Создаёт Money из Decimal.
     *
     * @internal ТОЛЬКО для внутреннего использования в Core и Facade
     *
     * @param value - Сумма (Decimal)
     * @param currency - Валюта (default 'USDC')
     * @returns Money
     * @throws {MoneyInvariantViolation} Нарушение инвариантов
     *
     * @remarks
     * НЕ парсит - принимает готовый Decimal.
     * Все проверки инвариантов выполняются в конструкторе.
     * Для публичного API используйте MoneyService.create().
     *
     * Конвертация number/string → Decimal делается в MoneyService (Facade layer).
     *
     * @example
     * ```typescript
     * // ✅ В Core и Facade
     * const m = Money.of(new Decimal('100.5'), 'USDC');
     *
     * // ❌ В публичном коде - используй MoneyService.create()
     * const result = MoneyService.create(new Decimal(100), 'USDC');
     * if (!result.ok) {
     *   console.error(result.error);
     * }
     * ```
     */
    static of(value: Decimal, currency?: SupportedCurrency): Money;
    /**
     * Возвращает сумму как Decimal.
     *
     * @returns Decimal
     *
     * @example
     * ```typescript
     * const money = Money.of(new Decimal('100.5'), 'USDC');
     * const decimal = money.value(); // Decimal
     * ```
     */
    value(): Decimal;
    /**
     * Возвращает валюту.
     *
     * @returns Код валюты
     */
    currency(): SupportedCurrency;
    /**
     * Преобразует в number (lossy).
     *
     * @returns number
     *
     * @remarks
     * ⚠️ Может потерять точность. Для вычислений используйте {@link value}.
     *
     * @example
     * ```typescript
     * const money = Money.of(new Decimal('100.5'), 'USDC');
     * const num = money.toNumber(); // 100.5
     * ```
     */
    toNumber(): number;
    /**
     * Проверяет совпадение валют.
     *
     * @param other - Другой Money
     * @returns true если валюты совпадают
     *
     * @remarks
     * Используется в MoneyService для проверки совместимости.
     *
     * @example
     * ```typescript
     * const m1 = Money.of(new Decimal(100), 'USDC');
     * const m2 = Money.of(new Decimal(200), 'USDC');
     * console.log(m1.hasSameCurrency(m2)); // true
     * ```
     */
    hasSameCurrency(other: Money): boolean;
    /**
     * Проверяет что сумма равна нулю.
     *
     * @returns true если сумма равна 0
     *
     * @remarks
     * Точное сравнение без epsilon.
     *
     * @example
     * ```typescript
     * Money.ZERO.USDC.isZero(); // true
     * Money.of(new Decimal(0), 'USDC').isZero();     // true
     * Money.of(new Decimal(100), 'USDC').isZero();   // false
     * ```
     */
    isZero(): boolean;
    /**
     * Проверяет что сумма положительная (> 0).
     *
     * @returns true если сумма > 0
     *
     * @example
     * ```typescript
     * Money.of(new Decimal(100)).isPositive();   // true
     * Money.ZERO.USDC.isPositive(); // false
     * Money.of(new Decimal(-100), 'USDC').isPositive();  // false
     * ```
     */
    isPositive(): boolean;
    /**
     * Проверяет что сумма отрицательная (< 0).
     *
     * @returns true если сумма < 0
     *
     * @example
     * ```typescript
     * Money.of(new Decimal(-100), 'USDC').isNegative(); // true
     * Money.of(new Decimal(100), 'USDC').isNegative();  // false
     * Money.ZERO.USDC.isNegative(); // false
     * ```
     */
    isNegative(): boolean;
}
//# sourceMappingURL=Money.d.ts.map