import Decimal from 'decimal.js';
import type { OutcomePrice } from '../../outcome-price/index.js';
import type { DecimalPrice } from '../../shared/index.js';
import { Ratio } from '../../ratio/core/Ratio.js';
import { SpreadInvariantViolation } from './SpreadInvariantViolation.js';
import { SpreadErrorReason } from '../errors/SpreadErrorReason.js';

/**
 * Core Spread Value Object
 *
 * @remarks
 * Представляет bid-ask spread на рынках предсказаний.
 * Диапазон цен: каждая OutcomePrice в [0.0001, 0.9999]
 *
 * Содержит ТОЛЬКО инварианты существования:
 * - bid <= ask (основной инвариант спреда)
 * - bid и ask являются валидными OutcomePrice объектами
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
export class Spread<TPrice extends DecimalPrice = OutcomePrice> {
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
  private constructor(
    private readonly _bid: TPrice,
    private readonly _ask: TPrice
  ) {
    // Инвариант: bid <= ask
    if (_bid.value().greaterThan(_ask.value())) {
      throw new SpreadInvariantViolation(
        `Bid ${_bid.value()} cannot be greater than ask ${_ask.value()}`,
        SpreadErrorReason.BID_GREATER_THAN_ASK
      );
    }
  }

  /**
   * Создаёт Spread из OutcomePrice объектов (ТОЛЬКО для Core!)
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
  public static of<T extends DecimalPrice>(bid: T, ask: T): Spread<T> {
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
  public static zero<T extends DecimalPrice>(price: T): Spread<T> {
    return new Spread(price, price);
  }

  /**
   * Получить bid price
   *
   * @returns Bid price
   */
  public bid(): TPrice {
    return this._bid;
  }

  /**
   * Получить ask price
   *
   * @returns Ask price
   */
  public ask(): TPrice {
    return this._ask;
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
   *   OutcomePrice.of(new Decimal(0.48)),
   *   OutcomePrice.of(new Decimal(0.52))
   * );
   * spread.width(); // Decimal(0.04)
   * ```
   */
  public width(): Decimal {
    return this._ask.value().minus(this._bid.value());
  }

  /**
   * Вычислить mid (среднее между bid и ask)
   *
   * @returns Mid как Decimal
   *
   * @remarks
   * Mid = (bid + ask) / 2
   * Представляет теоретическую справедливую цену.
   *
   * Возвращает Decimal вместо OutcomePrice для соблюдения контракта
   * "Core не бросает кроме инвариантов".
   * Для получения OutcomePrice используйте SpreadService.getMidPrice().
   *
   * @example
   * ```typescript
   * const spread = Spread.of(
   *   OutcomePrice.of(new Decimal(0.48)),
   *   OutcomePrice.of(new Decimal(0.52))
   * );
   * spread.mid(); // Decimal(0.50)
   * ```
   */
  public mid(): Decimal {
    return this._bid
      .value()
      .plus(this._ask.value())
      .dividedBy(2);
  }

  /**
   * Алиас для mid() для обратной совместимости
   *
   * @returns Midpoint как Decimal
   *
   * @remarks
   * Используется в старых тестах. Новый код должен использовать mid().
   */
  public midpoint(): Decimal {
    return this.mid();
  }

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
   *   OutcomePrice.of(new Decimal(0.48)),
   *   OutcomePrice.of(new Decimal(0.52))
   * );
   * spread.widthRatio(); // Ratio(0.08)
   * // Расчёт: 0.04 / 0.50 = 0.08 (8%)
   * spread.widthRatio().toDecimal().times(100).toFixed(2); // "8.00"
   * ```
   */
  public widthRatio(): Ratio {
    const mid = this.mid();

    // Защита от деления на ноль
    if (mid.equals(0)) {
      return Ratio.ZERO;
    }

    return Ratio.of(this.width().dividedBy(mid));
  }

  /**
   * Проверить равенство спредов
   *
   * @param other - Другой Spread
   * @returns true если bid и ask равны
   *
   * @example
   * ```typescript
   * const s1 = Spread.of(OutcomePrice.of(new Decimal(0.48)), OutcomePrice.of(new Decimal(0.52)));
   * const s2 = Spread.of(OutcomePrice.of(new Decimal(0.48)), OutcomePrice.of(new Decimal(0.52)));
   * s1.equals(s2); // true
   * ```
   */
  public equals(other: Spread<TPrice>): boolean {
    // Сравнение через Decimal, а не через `equals` конкретного VO: контракт
    // `DecimalPrice` намеренно минимален и метода сравнения не содержит —
    // требовать его от всякого будущего типа цены значило бы сузить круг
    // типов, ради расширения которого generic и вводился. Результат тот же:
    // `OutcomePrice.equals`/`AssetPrice.equals` сами делегируют `Decimal.equals`.
    return (
      this._bid.value().equals(other._bid.value()) &&
      this._ask.value().equals(other._ask.value())
    );
  }

  /**
   * Проверить является ли ширина нулевой (строгое сравнение)
   *
   * @returns true если ширина === 0 (точное совпадение bid и ask)
   *
   * @remarks
   * Spread с нулевой шириной означает bid = ask (идеальная ликвидность).
   * Использует строгое сравнение без epsilon.
   */
  public isZeroWidth(): boolean {
    return this.width().equals(0);
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
   * spread.contains(OutcomePrice.of(new Decimal(0.50))); // true
   * spread.contains(OutcomePrice.of(new Decimal(0.55))); // false
   * ```
   */
  public contains(price: TPrice): boolean {
    const priceValue = price.value();
    return priceValue.greaterThanOrEqualTo(this._bid.value()) && priceValue.lessThanOrEqualTo(this._ask.value());
  }

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
   *   OutcomePrice.of(new Decimal(0.48)),
   *   OutcomePrice.of(new Decimal(0.52))
   * );
   * spread.widthInBasisPoints(); // Decimal(400)
   * // 0.04 * 10000 = 400 bp
   * ```
   */
  public widthInBasisPoints(): Decimal {
    return this.width().times(10000);
  }

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
   * const s1 = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));
   * const s2 = Spread.of(OutcomePrice.of(new Decimal(0.50)), OutcomePrice.of(new Decimal(0.70)));
   * s1.overlaps(s2); // true (пересечение [0.50, 0.60])
   *
   * const s3 = Spread.of(OutcomePrice.of(new Decimal(0.70)), OutcomePrice.of(new Decimal(0.80)));
   * s1.overlaps(s3); // false (нет пересечения)
   * ```
   */
  public overlaps(other: Spread<TPrice>): boolean {
    return this._bid.value().lessThanOrEqualTo(other._ask.value())
      && other._bid.value().lessThanOrEqualTo(this._ask.value());
  }

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
   * const outer = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));
   * const inner = Spread.of(OutcomePrice.of(new Decimal(0.45)), OutcomePrice.of(new Decimal(0.55)));
   * outer.containsSpread(inner); // true
   *
   * const partial = Spread.of(OutcomePrice.of(new Decimal(0.50)), OutcomePrice.of(new Decimal(0.70)));
   * outer.containsSpread(partial); // false (выходит за границы)
   * ```
   */
  public containsSpread(other: Spread<TPrice>): boolean {
    return other._bid.value().greaterThanOrEqualTo(this._bid.value())
      && other._ask.value().lessThanOrEqualTo(this._ask.value());
  }
}
