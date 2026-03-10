import Decimal from 'decimal.js';
import { Price } from '../../price/index.js';
import { Ratio } from '../../ratio/core/Ratio.js';
/**
 * Core Spread Value Object
 *
 * @remarks
 * Представляет bid-ask spread на рынках предсказаний.
 * Диапазон цен: каждая Price в [0.0001, 0.9999]
 *
 * Содержит ТОЛЬКО инварианты существования:
 * - bid <= ask (основной инвариант спреда)
 * - bid и ask являются валидными Price объектами
 *
 * НЕ проверяется в Core:
 * - Минимальная/максимальная ширина (проверяется в Rules)
 * - Контекстуальные ограничения рынка (будущие Policies)
 *
 * Математические операции (tighten/widen/shift) УДАЛЕНЫ из Core.
 * Используй SpreadService для всех операций.
 *
 * @internal ТОЛЬКО для внутреннего использования в Core и Facade
 * Для публичного API используйте SpreadService.create()
 */
export declare class Spread {
    private readonly _bid;
    private readonly _ask;
    /**
     * Private constructor - используйте static factory methods
     *
     * @param _bid - Bid price
     * @param _ask - Ask price
     * @throws {SpreadInvariantViolation} Если bid > ask
     *
     * @remarks
     * Все проверки инвариантов выполняются в конструкторе.
     * Facade должен ловить исключения и преобразовывать в Result.
     */
    private constructor();
    /**
     * Создаёт Spread из Price объектов (ТОЛЬКО для Core!)
     *
     * @internal ТОЛЬКО для внутреннего использования в Core и Facade
     *
     * @remarks
     * Бросает SpreadInvariantViolation при нарушении инвариантов.
     * Все проверки инвариантов выполняются в конструкторе.
     * Для публичного API используйте SpreadService.create().
     *
     * @param bid - Bid price
     * @param ask - Ask price
     * @returns Spread объект
     * @throws {SpreadInvariantViolation} При нарушении инвариантов
     *
     * @example
     * ```typescript
     * // ✅ В Core и Facade
     * const spread = Spread.of(bid, ask);
     *
     * // ❌ В публичном коде - используй SpreadService.create()
     * const result = SpreadService.create(bid, ask);
     * if (!result.ok) {
     *   console.error(result.error);
     * }
     * ```
     */
    static of(bid: Price, ask: Price): Spread;
    /**
     * Создать spread с нулевой шириной
     *
     * @internal ТОЛЬКО для внутреннего использования в Core и Facade
     *
     * @param price - Цена для bid и ask
     * @returns Spread с нулевой шириной
     *
     * @remarks
     * Spread с нулевой шириной означает идеально ликвидный рынок
     * где цены bid и ask совпадают.
     *
     * @example
     * ```typescript
     * // ✅ В Core и Facade
     * const spread = Spread.zero(price);
     * ```
     */
    static zero(price: Price): Spread;
    /**
     * Получить bid price
     *
     * @returns Bid price
     */
    bid(): Price;
    /**
     * Получить ask price
     *
     * @returns Ask price
     */
    ask(): Price;
    /**
     * Вычислить ширину спреда
     *
     * @returns Width как Decimal (ask - bid)
     *
     * @remarks
     * Ширина представляет стоимость ликвидности.
     * Узкие спреды = более ликвидные рынки.
     *
     * @example
     * ```typescript
     * const spread = Spread.of(
     *   Price.of(new Decimal(0.48)),
     *   Price.of(new Decimal(0.52))
     * );
     * spread.width(); // Decimal(0.04)
     * ```
     */
    width(): Decimal;
    /**
     * Вычислить mid (среднее между bid и ask)
     *
     * @returns Mid как Decimal
     *
     * @remarks
     * Mid = (bid + ask) / 2
     * Представляет теоретическую справедливую цену.
     *
     * Возвращает Decimal вместо Price для соблюдения контракта
     * "Core не бросает кроме инвариантов".
     * Для получения Price используйте SpreadService.getMidPrice().
     *
     * @example
     * ```typescript
     * const spread = Spread.of(
     *   Price.of(new Decimal(0.48)),
     *   Price.of(new Decimal(0.52))
     * );
     * spread.mid(); // Decimal(0.50)
     * ```
     */
    mid(): Decimal;
    /**
     * Алиас для mid() для обратной совместимости
     *
     * @returns Midpoint как Decimal
     *
     * @remarks
     * Используется в старых тестах. Новый код должен использовать mid().
     */
    midpoint(): Decimal;
    /**
     * Вычислить ширину спреда как дробь от mid-цены
     *
     * @returns Ratio (дробь, не процент): 0.08 для спреда шириной 8%
     *
     * @remarks
     * Ratio = width / midpoint
     * Нормализует спред для сравнения на разных уровнях цен.
     * Для отображения в процентах: `ratio.toDecimal().times(100)`
     *
     * @example
     * ```typescript
     * const spread = Spread.of(
     *   Price.of(new Decimal(0.48)),
     *   Price.of(new Decimal(0.52))
     * );
     * spread.widthRatio(); // Ratio(0.08)
     * // Расчёт: 0.04 / 0.50 = 0.08 (8%)
     * spread.widthRatio().toDecimal().times(100).toFixed(2); // "8.00"
     * ```
     */
    widthRatio(): Ratio;
    /**
     * Проверить равенство спредов
     *
     * @param other - Другой Spread
     * @returns true если bid и ask равны
     *
     * @example
     * ```typescript
     * const s1 = Spread.of(Price.of(new Decimal(0.48)), Price.of(new Decimal(0.52)));
     * const s2 = Spread.of(Price.of(new Decimal(0.48)), Price.of(new Decimal(0.52)));
     * s1.equals(s2); // true
     * ```
     */
    equals(other: Spread): boolean;
    /**
     * Проверить является ли ширина нулевой (строгое сравнение)
     *
     * @returns true если ширина === 0 (точное совпадение bid и ask)
     *
     * @remarks
     * Spread с нулевой шириной означает bid = ask (идеальная ликвидность).
     * Использует строгое сравнение без epsilon.
     */
    isZeroWidth(): boolean;
    /**
     * Проверить содержит ли spread цену
     *
     * @param price - Цена для проверки
     * @returns true если bid <= price <= ask
     *
     * @example
     * ```typescript
     * const spread = Spread.of(bid, ask);
     * spread.contains(Price.of(new Decimal(0.50))); // true
     * spread.contains(Price.of(new Decimal(0.55))); // false
     * ```
     */
    contains(price: Price): boolean;
    /**
     * Вычислить ширину спреда в basis points
     *
     * @returns Ширина в basis points (1 bp = 0.0001 = 0.01%)
     *
     * @remarks
     * Basis points - стандартная метрика в финансах для измерения спредов.
     * 1 bp = 0.0001, поэтому width * 10000 = bp
     *
     * @example
     * ```typescript
     * const spread = Spread.of(
     *   Price.of(new Decimal(0.48)),
     *   Price.of(new Decimal(0.52))
     * );
     * spread.widthInBasisPoints(); // Decimal(400)
     * // 0.04 * 10000 = 400 bp
     * ```
     */
    widthInBasisPoints(): Decimal;
    /**
     * Проверить пересекается ли spread с другим
     *
     * @param other - Другой Spread для проверки
     * @returns true если спреды имеют общие точки
     *
     * @remarks
     * Два спреда пересекаются если существует хотя бы одна цена,
     * принадлежащая обоим спредам.
     *
     * Математически: bid1 <= ask2 AND bid2 <= ask1
     *
     * @example
     * ```typescript
     * const s1 = Spread.of(Price.of(new Decimal(0.40)), Price.of(new Decimal(0.60)));
     * const s2 = Spread.of(Price.of(new Decimal(0.50)), Price.of(new Decimal(0.70)));
     * s1.overlaps(s2); // true (пересечение [0.50, 0.60])
     *
     * const s3 = Spread.of(Price.of(new Decimal(0.70)), Price.of(new Decimal(0.80)));
     * s1.overlaps(s3); // false (нет пересечения)
     * ```
     */
    overlaps(other: Spread): boolean;
    /**
     * Проверить содержится ли другой spread полностью внутри этого
     *
     * @param other - Другой Spread для проверки
     * @returns true если other полностью внутри this
     *
     * @remarks
     * Spread A содержит spread B если:
     * - A.bid <= B.bid
     * - B.ask <= A.ask
     *
     * @example
     * ```typescript
     * const outer = Spread.of(Price.of(new Decimal(0.40)), Price.of(new Decimal(0.60)));
     * const inner = Spread.of(Price.of(new Decimal(0.45)), Price.of(new Decimal(0.55)));
     * outer.containsSpread(inner); // true
     *
     * const partial = Spread.of(Price.of(new Decimal(0.50)), Price.of(new Decimal(0.70)));
     * outer.containsSpread(partial); // false (выходит за границы)
     * ```
     */
    containsSpread(other: Spread): boolean;
}
//# sourceMappingURL=Spread.d.ts.map