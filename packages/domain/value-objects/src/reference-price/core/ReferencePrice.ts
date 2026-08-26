/**
 * ReferencePrice — цена ВНЕШНЕГО актива (BTC/USD, ETH/USD, ...).
 *
 * @remarks
 * ## Зачем отдельный VO, а не `Price`
 *
 * `Price` — цена outcome-токена рынка предсказаний, и её инвариант —
 * жёсткий диапазон `[0.0001, 0.9999]`. Референсная цена базового актива
 * живёт в совершенно другом домене:
 *
 * ```text
 * Price            0.42, 0.73, 0.995            (доля вероятности)
 * ReferencePrice   79341.36626633028, 3021.5    (цена актива)
 * ```
 *
 * Попытка представить `79341.36` через `Price` — не «неудобство», а
 * нарушение инварианта: конструктор `Price` обязан её отвергнуть. Поэтому
 * референсные цены получают собственный canonical VO.
 *
 * ## Source-agnostic
 *
 * VO НЕ знает, откуда пришло значение: Binance, Chainlink, TWAP-окно, CEX
 * ticker — всё это provenance наблюдения, а не свойство самой цены.
 * Провенанс живёт в semantic-событии наблюдения, а не здесь; поэтому этот
 * же тип переиспользует будущий CEX Semantic Adapter.
 *
 * ## Инварианты
 * - Значение не NaN
 * - Значение конечно (finite)
 * - Значение строго положительно (`> 0`)
 *
 * Верхней границы НЕТ — это принципиальное отличие от `Price`.
 *
 * ## НЕ-инварианты
 * - Единица измерения (USD/USDT/...) — не моделируется: RTDS/CEX-фиды
 *   котируют пару в своём символе, символ хранится в наблюдении.
 * - Точность/тик — вопрос источника, а не VO.
 *
 * ## Точность
 * Внутреннее представление — `Decimal`. Значение НИКОГДА не проходит через
 * JS `number` при создании из десятичной строки: `ReferencePriceService`
 * парсит строку напрямую в `Decimal`.
 *
 * ## Архитектура (та же, что у остальных VO пакета)
 * - Core (`ReferencePrice.of`) БРОСАЕТ `ReferencePriceInvariantViolation`
 * - Facade (`ReferencePriceService`) возвращает `Result` и НИКОГДА не бросает
 *
 * @example
 * ```typescript
 * import { ReferencePriceService } from '@polymarket/value-objects';
 *
 * const result = ReferencePriceService.create('79341.36626633028');
 * if (result.ok) {
 *   console.log(result.value.value().toString()); // "79341.36626633028"
 * }
 * ```
 */
import Decimal from 'decimal.js';
import { ReferencePriceErrorReason } from '../errors/ReferencePriceErrorReason.js';
import { ReferencePriceInvariantViolation } from './ReferencePriceInvariantViolation.js';

/**
 * Цена внешнего актива — immutable value object.
 *
 * @remarks
 * Полное описание домена, инвариантов и причин существования отдельно от
 * `Price` — см. докблок модуля выше.
 */
export class ReferencePrice {
  /**
   * Единственный приватный конструктор.
   *
   * @param _value - Значение цены (`Decimal`)
   * @throws {ReferencePriceInvariantViolation} При нарушении инвариантов
   */
  private constructor(private readonly _value: Decimal) {
    // Инвариант 1: не NaN
    if (_value.isNaN()) {
      throw new ReferencePriceInvariantViolation(
        'Reference price cannot be NaN',
        ReferencePriceErrorReason.NAN,
      );
    }

    // Инвариант 2: конечное значение
    if (!_value.isFinite()) {
      throw new ReferencePriceInvariantViolation(
        'Reference price must be finite',
        ReferencePriceErrorReason.NON_FINITE,
      );
    }

    // Инвариант 3: строго положительное (отрицательные и ноль отсекаются здесь)
    if (!_value.greaterThan(0)) {
      throw new ReferencePriceInvariantViolation(
        `Reference price ${_value.toString()} must be positive`,
        ReferencePriceErrorReason.NOT_POSITIVE,
      );
    }

    Object.freeze(this);
  }

  /**
   * Создаёт ReferencePrice из готового `Decimal` (Core API).
   *
   * @param value - Значение цены (`Decimal`, уже распарсенный)
   * @returns Новый `ReferencePrice`
   * @throws {ReferencePriceInvariantViolation} Если значение NaN, не конечно
   *   либо не положительно
   *
   * @remarks
   * НЕ парсит вход: конверсия `string`/`number` → `Decimal` делается в
   * `ReferencePriceService` (Facade). Для публичного кода рекомендуется
   * именно Facade — он возвращает `Result` и не бросает.
   *
   * @example
   * ```typescript
   * const price = ReferencePrice.of(new Decimal('79341.36626633028'));
   * ```
   */
  public static of(value: Decimal): ReferencePrice {
    return new ReferencePrice(value);
  }

  /**
   * Возвращает точное значение цены.
   *
   * @returns `Decimal` значение (без потери точности)
   *
   * @example
   * ```typescript
   * price.value().toString(); // "79341.36626633028"
   * ```
   */
  public value(): Decimal {
    return this._value;
  }

  /**
   * Возвращает значение как `number` (lossy!).
   *
   * @returns `number` значение цены
   *
   * @remarks
   * ⚠️ Конверсия может потерять точность. Только для отображения/метрик,
   * НЕ для расчётов и НЕ для сравнения значений.
   *
   * @example
   * ```typescript
   * price.toNumber(); // 79341.36626633028 (может быть округлено)
   * ```
   */
  public toNumber(): number {
    return this._value.toNumber();
  }

  /**
   * Строгое сравнение двух референсных цен.
   *
   * @param other - Другая цена
   * @returns `true`, если значения строго равны по `Decimal`
   *
   * @example
   * ```typescript
   * ReferencePrice.of(new Decimal('1.10')).equals(ReferencePrice.of(new Decimal('1.1'))); // true
   * ```
   */
  public equals(other: ReferencePrice): boolean {
    return this._value.equals(other._value);
  }

  /**
   * Строковое представление БЕЗ потери точности.
   *
   * @returns Точная десятичная строка значения
   *
   * @example
   * ```typescript
   * String(price); // "79341.36626633028"
   * ```
   */
  public toString(): string {
    return this._value.toString();
  }
}
