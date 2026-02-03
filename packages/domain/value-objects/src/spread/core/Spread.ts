import Decimal from 'decimal.js';
import { Price } from '../../price/index.js';
import { SpreadInvariantViolation } from './SpreadInvariantViolation.js';
import { SpreadErrorReason } from './SpreadErrorReason.js';

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
export class Spread {
  /**
   * Epsilon для сравнения с нулём
   */
  private static readonly EPSILON = new Decimal(0.0001);

  /**
   * Private constructor - используйте static factory methods
   *
   * @param b - Bid price
   * @param a - Ask price
   * @throws {SpreadInvariantViolation} Если bid > ask
   *
   * @remarks
   * Все проверки инвариантов выполняются в конструкторе.
   * Facade должен ловить исключения и преобразовывать в Result.
   */
  private constructor(
    private readonly b: Price,
    private readonly a: Price
  ) {
    // Инвариант: bid <= ask
    if (b.value().greaterThan(a.value())) {
      throw new SpreadInvariantViolation(
        `Bid ${b.value()} cannot be greater than ask ${a.value()}`,
        SpreadErrorReason.BID_GREATER_THAN_ASK
      );
    }
  }

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
  public static of(bid: Price, ask: Price): Spread {
    return new Spread(bid, ask);
  }

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
  public static zero(price: Price): Spread {
    return new Spread(price, price);
  }

  // ============================================================================
  // Getters
  // ============================================================================

  /**
   * Получить bid price
   *
   * @returns Bid price
   */
  public bid(): Price {
    return this.b;
  }

  /**
   * Получить ask price
   *
   * @returns Ask price
   */
  public ask(): Price {
    return this.a;
  }

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
  public width(): Decimal {
    return this.a.value().minus(this.b.value());
  }

  /**
   * Вычислить midpoint (среднюю цену)
   *
   * @returns Midpoint как Price
   *
   * @remarks
   * Midpoint = (bid + ask) / 2
   * Представляет теоретическую справедливую цену.
   *
   * @example
   * ```typescript
   * const spread = Spread.of(
   *   Price.of(new Decimal(0.48)),
   *   Price.of(new Decimal(0.52))
   * );
   * spread.midpoint(); // Price(0.50)
   * ```
   */
  public midpoint(): Price {
    const midValue = this.b
      .value()
      .plus(this.a.value())
      .dividedBy(2);

    // Midpoint всегда валиден если bid и ask валидны
    return Price.of(midValue);
  }

  /**
   * Вычислить ширину спреда в процентах
   *
   * @returns Width percentage как Decimal
   *
   * @remarks
   * Percentage = (width / midpoint) * 100
   * Нормализует спред для сравнения на разных уровнях цен.
   *
   * @example
   * ```typescript
   * const spread = Spread.of(
   *   Price.of(new Decimal(0.48)),
   *   Price.of(new Decimal(0.52))
   * );
   * spread.widthPercentage(); // Decimal(8)
   * // Расчёт: (0.04 / 0.50) * 100 = 8%
   * ```
   */
  public widthPercentage(): Decimal {
    const mid = this.midpoint().value();

    // Защита от деления на ноль
    if (mid.equals(0)) {
      return new Decimal(0);
    }

    return this.width().dividedBy(mid).times(100);
  }

  // ============================================================================
  // Comparison (Value Object требование)
  // ============================================================================

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
  public equals(other: Spread): boolean {
    return this.b.equals(other.b) && this.a.equals(other.a);
  }

  // ============================================================================
  // Utility Checks
  // ============================================================================

  /**
   * Проверить является ли ширина нулевой
   *
   * @returns true если ширина < EPSILON
   *
   * @remarks
   * Spread с нулевой шириной означает bid = ask (идеальная ликвидность).
   */
  public isZeroWidth(): boolean {
    return this.width().abs().lessThan(Spread.EPSILON);
  }

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
  public contains(price: Price): boolean {
    const priceValue = price.value();
    return !priceValue.lessThan(this.b.value()) && !priceValue.greaterThan(this.a.value());
  }
}
