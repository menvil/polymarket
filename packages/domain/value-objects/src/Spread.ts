/**
 * Value Object для спреда
 *
 * @remarks
 * Представляет спред bid-ask на рынках предсказаний.
 * Иммутабельный value object, инкапсулирующий цены bid и ask с валидацией.
 * Ширина спреда представляет разницу между ценами ask и bid.
 *
 * Алгоритм:
 * 1. Проверяет, что цена bid меньше или равна цене ask
 * 2. Хранит bid и ask как value objects Price
 * 3. Вычисляет ширину спреда как (ask - bid)
 * 4. Вычисляет середину как (bid + ask) / 2
 * 5. Все операции возвращают новые экземпляры Spread (иммутабельность)
 * 6. Предоставляет расчёт ширины спреда в процентах
 *
 * @example
 * ```typescript
 * const bid = Price.fromValue(0.48);
 * const ask = Price.fromValue(0.52);
 * const spread = Spread.create(bid, ask);
 * console.log(spread.width()); // 0.04
 * console.log(spread.midpoint().value); // 0.50
 * console.log(spread.widthPercentage()); // 8
 * ```
 */
import { Result, Ok, Err } from '@polymarket/result';
import { Price } from './Price.js';
import { InvalidPriceError, InvalidSpreadError } from '@polymarket/errors';
import Decimal from 'decimal.js';

export class Spread {
  public readonly bid: Price;
  public readonly ask: Price;

  private static readonly EPSILON = 0.0001;

  private constructor(bid: Price, ask: Price) {
    this.bid = bid;
    this.ask = ask;
  }

  /**
   * Создаёт Spread из цен bid и ask
   *
   * @param bid - Цена bid
   * @param ask - Цена ask
   * @returns Result с Spread или InvalidSpreadError
   *
   * @remarks
   * Проверяет, что bid <= ask. На рынках предсказаний:
   * - Bid — это максимальная цена, которую покупатели готовы заплатить
   * - Ask — это минимальная цена, по которой продавцы готовы продать
   * - Ask должен быть >= bid (без пересечения рынка)
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const bid = unwrap(Price.fromValue(0.48));
   * const ask = unwrap(Price.fromValue(0.52));
   *
   * const result = Spread.create(bid, ask);
   * if (result.ok) {
   *   const spread = result.value;
   *   console.log(spread.width()); // 0.04
   * } else {
   *   console.error(result.error.message);
   * }
   *
   * // Или используя unwrap
   * const spread = unwrap(Spread.create(bid, ask));
   * ```
   */
  public static create(bid: Price, ask: Price): Result<Spread, InvalidSpreadError> {
    if (!Spread.isValid(bid, ask)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Invalid spread: bid (${ctx.bid}) must be <= ask (${ctx.ask})`,
          {
            context: { bid: bid.value, ask: ask.value }
          }
        )
      );
    }
    return Ok(new Spread(bid, ask));
  }

  /**
   * Создаёт Spread из чисел bid и ask
   *
   * @param bid - Значение цены bid
   * @param ask - Значение цены ask
   * @returns Result с Spread или ошибкой (InvalidPriceError или InvalidSpreadError)
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const result = Spread.fromNumbers(0.48, 0.52);
   * if (result.ok) {
   *   const spread = result.value;
   *   console.log(spread.width()); // 0.04
   * }
   *
   * // Или используя unwrap
   * const spread = unwrap(Spread.fromNumbers(0.48, 0.52));
   * ```
   */
  public static fromNumbers(bid: number, ask: number): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    const bidResult = Price.fromValue(bid);
    if (!bidResult.ok) {
      return bidResult;
    }

    const askResult = Price.fromValue(ask);
    if (!askResult.ok) {
      return askResult;
    }

    return Spread.create(bidResult.value, askResult.value);
  }

  /**
   * Создаёт спред с нулевой шириной (bid = ask)
   *
   * @param price - Цена для bid и ask
   * @returns Spread с нулевой шириной
   *
   * @remarks
   * Спред с нулевой шириной указывает на идеально ликвидный рынок,
   * где цены bid и ask совпадают.
   *
   * @example
   * ```typescript
   * const price = Price.fromValue(0.50);
   * const spread = Spread.zero(price);
   * console.log(spread.width()); // 0
   * ```
   */
  public static zero(price: Price): Spread {
    return new Spread(price, price);
  }

  /**
   * Проверяет валидность спреда
   *
   * @param bid - Цена bid
   * @param ask - Цена ask
   * @returns True если валиден (bid <= ask)
   *
   * @remarks
   * Валидный спред требует bid <= ask.
   * Равные цены (bid = ask) представляют нулевой спред.
   */
  public static isValid(bid: Price, ask: Price): boolean {
    return !bid.isGreaterThan(ask);
  }

  /**
   * Вычисляет ширину спреда
   *
   * @returns Ширина спреда (ask - bid)
   *
   * @remarks
   * Ширина представляет стоимость ликвидности.
   * Узкие спреды указывают на более ликвидные рынки.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread.width()); // 0.04
   * ```
   */
  public width(): number {
    // Используем Decimal для точных вычислений
    return new Decimal(this.ask.value).minus(this.bid.value).toNumber();
  }

  /**
   * Вычисляет ширину спреда в процентах
   *
   * @returns Ширина спреда в процентах относительно середины (может быть > 100%)
   *
   * @remarks
   * Вычисляет: (width / midpoint) * 100
   * Это нормализует спред для сравнения на разных уровнях цен.
   * Для широких спредов значение может превышать 100%.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread.widthPercentage()); // 8
   * // Расчёт: (0.04 / 0.50) * 100 = 8%
   *
   * const wideSpread = Spread.fromNumbers(0.01, 0.99);
   * console.log(wideSpread.widthPercentage()); // 196
   * ```
   */
  public widthPercentage(): number {
    const mid = this.midpoint().value;

    // Используем Decimal для точного сравнения с нулем
    const midDecimal = new Decimal(mid);
    if (midDecimal.equals(0)) {
      return 0;
    }

    // Используем Decimal для точных вычислений
    return new Decimal(this.width()).dividedBy(mid).times(100).toNumber();
  }

  /**
   * Вычисляет среднюю цену
   *
   * @returns Средняя цена (среднее bid и ask)
   *
   * @remarks
   * Середина представляет теоретическую "справедливую" цену.
   * Часто используется как референсная цена для аналитики.
   *
   * Метод возвращает Price напрямую (не Result) так как:
   * - bid и ask уже валидированы при создании Spread
   * - среднее арифметическое двух валидных цен всегда валидно
   * - математическая гарантия: если 0.0001 ≤ bid ≤ ask ≤ 0.9999,
   *   то 0.0001 ≤ (bid + ask) / 2 ≤ 0.9999
   *
   * Использует Price.createTrusted() для создания без валидации,
   * так как значение математически гарантированно валидно.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const mid = spread.midpoint();
   * console.log(mid.value); // 0.50
   * ```
   */
  public midpoint(): Price {
    // Вычисляем среднюю точку спреда
    // Математически гарантированно валидно:
    // Если 0.0001 ≤ bid ≤ ask ≤ 0.9999, то 0.0001 ≤ (bid+ask)/2 ≤ 0.9999
    const midValue = new Decimal(this.bid.value)
      .plus(this.ask.value)
      .dividedBy(2)
      .toNumber();

    // Используем createTrusted() так как midValue математически гарантированно валиден
    return Price.createTrusted(midValue);
  }

  /**
   * Проверяет, имеет ли спред нулевую ширину
   *
   * @returns True если bid равен ask (в пределах epsilon)
   *
   * @remarks
   * Спред с нулевой шириной указывает на идеальную ликвидность на этом уровне цен.
   *
   * @example
   * ```typescript
   * const spread1 = Spread.fromNumbers(0.50, 0.50);
   * console.log(spread1.isZeroWidth()); // true
   *
   * const spread2 = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread2.isZeroWidth()); // false
   * ```
   */
  public isZeroWidth(): boolean {
    // Используем Decimal для точного сравнения
    const widthDecimal = new Decimal(this.width());
    const epsilonDecimal = new Decimal(Spread.EPSILON);
    return widthDecimal.abs().lessThan(epsilonDecimal);
  }

  /**
   * Проверяет, широкий ли спред
   *
   * @param threshold - Порог ширины (по умолчанию 0.05 = 5 центов)
   * @returns True если ширина превышает порог
   *
   * @remarks
   * Широкие спреды указывают на низкую ликвидность или высокую неопределённость.
   * Типичный порог для рынков предсказаний — 0.05 (5 центов).
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.45, 0.55);
   * console.log(spread.isWide()); // true (width = 0.10 > 0.05)
   * console.log(spread.isWide(0.15)); // false (width = 0.10 < 0.15)
   * ```
   */
  public isWide(threshold: number = 0.05): boolean {
    // Используем Decimal для точного сравнения
    const widthDecimal = new Decimal(this.width());
    const thresholdDecimal = new Decimal(threshold);
    return widthDecimal.greaterThan(thresholdDecimal);
  }

  /**
   * Сужает спред, сдвигая bid/ask ближе друг к другу
   *
   * @param amount - Величина сужения (уменьшает ширину на 2x от этого значения)
   * @returns Result с новым Spread или ошибкой:
   *   - InvalidSpreadError: если amount не является конечным числом, отрицателен, или не удалось создать новые цены
   *
   * @remarks
   * Сдвигает bid вверх и ask вниз на указанную величину.
   * Полезно для стратегий маркет-мейкинга.
   * Если величина привела бы к пересечению, возвращает спред с нулевой шириной в середине.
   * Метод возвращает Result вместо выбрасывания исключений.
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const spread = unwrap(Spread.fromNumbers(0.48, 0.52));
   * const result = spread.tighten(0.01);
   * if (result.ok) {
   *   const tightened = result.value;
   *   console.log(tightened.bid.value); // 0.49
   *   console.log(tightened.ask.value); // 0.51
   *   console.log(tightened.width()); // 0.02
   * }
   *
   * // Или используя unwrap
   * const tightened = unwrap(spread.tighten(0.01));
   * ```
   */
  public tighten(amount: number): Result<Spread, InvalidSpreadError> {
    // Валидация через Decimal
    if (!Number.isFinite(amount)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Invalid tighten amount ${ctx.amount}: must be a finite number`,
          {
            context: { amount }
          }
        )
      );
    }

    const amountDecimal = new Decimal(amount);
    if (amountDecimal.lessThan(0)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Invalid tighten amount ${ctx.amount}: must be >= 0`,
          {
            context: { amount }
          }
        )
      );
    }

    // Используем Decimal для вычисления halfWidth и сравнения
    const halfWidth = new Decimal(this.width()).dividedBy(2);
    const tightenAmountDecimal = amountDecimal.lessThanOrEqualTo(halfWidth) ? amountDecimal : halfWidth;
    const tightenAmount = tightenAmountDecimal.toNumber();

    const newBidResult = this.bid.add(tightenAmount);
    if (!newBidResult.ok) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Failed to adjust bid: ${ctx.error}`,
          { context: { error: newBidResult.error.message } }
        )
      );
    }

    const newAskResult = this.ask.subtract(tightenAmount);
    if (!newAskResult.ok) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Failed to adjust ask: ${ctx.error}`,
          { context: { error: newAskResult.error.message } }
        )
      );
    }

    return Spread.create(newBidResult.value, newAskResult.value);
  }

  /**
   * Расширяет спред, раздвигая bid/ask
   *
   * @param amount - Величина расширения (увеличивает ширину на 2x от этого значения)
   * @returns Result с новым Spread или ошибкой:
   *   - InvalidSpreadError: если amount не является конечным числом, отрицателен, или не удалось создать новые цены
   *
   * @remarks
   * Сдвигает bid вниз и ask вверх на указанную величину.
   * Соблюдает границы цен [0.0001, 0.9999].
   * Метод возвращает Result вместо выбрасывания исключений.
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const spread = unwrap(Spread.fromNumbers(0.48, 0.52));
   * const result = spread.widen(0.02);
   * if (result.ok) {
   *   const widened = result.value;
   *   console.log(widened.bid.value); // 0.46
   *   console.log(widened.ask.value); // 0.54
   *   console.log(widened.width()); // 0.08
   * }
   *
   * // Или используя unwrap
   * const widened = unwrap(spread.widen(0.02));
   * ```
   */
  public widen(amount: number): Result<Spread, InvalidSpreadError> {
    // Валидация через Decimal
    if (!Number.isFinite(amount)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Invalid widen amount ${ctx.amount}: must be a finite number`,
          {
            context: { amount }
          }
        )
      );
    }

    const amountDecimal = new Decimal(amount);
    if (amountDecimal.lessThan(0)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Invalid widen amount ${ctx.amount}: must be >= 0`,
          {
            context: { amount }
          }
        )
      );
    }

    const newBidResult = this.bid.subtract(amount);
    if (!newBidResult.ok) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Failed to adjust bid: ${ctx.error}`,
          { context: { error: newBidResult.error.message } }
        )
      );
    }

    const newAskResult = this.ask.add(amount);
    if (!newAskResult.ok) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Failed to adjust ask: ${ctx.error}`,
          { context: { error: newAskResult.error.message } }
        )
      );
    }

    return Spread.create(newBidResult.value, newAskResult.value);
  }

  /**
   * Сдвигает спред вверх или вниз
   *
   * @param amount - Величина сдвига (положительное = вверх, отрицательное = вниз)
   * @returns Result с новым Spread или ошибкой:
   *   - InvalidSpreadError: если amount не является конечным числом или не удалось создать новые цены
   *
   * @remarks
   * Сдвигает и bid и ask на одинаковую величину.
   * Сохраняет ширину спреда. Соблюдает границы цен.
   * Метод возвращает Result вместо выбрасывания исключений.
   *
   * Алгоритм:
   * 1. Валидирует входной параметр amount (должен быть конечным числом)
   * 2. Сдвигает bid и ask на величину amount
   * 3. Применяет границы цен с сохранением ширины спреда
   * 4. Возвращает Result с новым Spread
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const spread = unwrap(Spread.fromNumbers(0.48, 0.52));
   * const result = spread.shift(0.05);
   * if (result.ok) {
   *   const shifted = result.value;
   *   console.log(shifted.bid.value); // 0.53
   *   console.log(shifted.ask.value); // 0.57
   *   console.log(shifted.width()); // 0.04 (unchanged)
   * }
   *
   * // Или используя unwrap
   * const shifted = unwrap(spread.shift(0.05));
   *
   * // Обработка ошибок
   * const invalidResult = spread.shift(NaN);
   * if (!invalidResult.ok) {
   *   console.error(invalidResult.error.message);
   * }
   * ```
   */
  public shift(amount: number): Result<Spread, InvalidSpreadError> {
    // Валидация входного параметра
    if (!Number.isFinite(amount)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Invalid shift amount ${ctx.amount}: must be a finite number`,
          {
            context: { amount }
          }
        )
      );
    }

    const originalWidth = this.width();
    const minPriceDecimal = new Decimal(Price.minPrice);
    const maxPriceDecimal = new Decimal(Price.maxPrice);
    const originalWidthDecimal = new Decimal(originalWidth);

    // Вычисление целевых позиций с использованием Decimal
    let newBidDecimal = new Decimal(this.bid.value).plus(amount);
    let newAskDecimal = new Decimal(this.ask.value).plus(amount);

    // Ограничение с сохранением ширины - используем Decimal сравнения
    if (newBidDecimal.lessThan(minPriceDecimal)) {
      newBidDecimal = minPriceDecimal;
      newAskDecimal = minPriceDecimal.plus(originalWidthDecimal);
    }
    if (newAskDecimal.greaterThan(maxPriceDecimal)) {
      newBidDecimal = maxPriceDecimal.minus(originalWidthDecimal);
    }

    // Финальное ограничение для обеспечения корректных цен - используем Decimal методы
    const maxBidDecimal = maxPriceDecimal.minus(originalWidthDecimal);

    // Эквивалент Math.max(minPrice, Math.min(maxBidValue, newBidValue))
    if (newBidDecimal.lessThan(minPriceDecimal)) {
      newBidDecimal = minPriceDecimal;
    } else if (newBidDecimal.greaterThan(maxBidDecimal)) {
      newBidDecimal = maxBidDecimal;
    }

    // Пересчитываем ask на основе финального bid для сохранения ширины
    newAskDecimal = newBidDecimal.plus(originalWidthDecimal);

    // Создание новых Price с обработкой ошибок
    const newBidResult = Price.fromValue(newBidDecimal.toNumber());
    if (!newBidResult.ok) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Failed to create bid price: ${ctx.error}`,
          { context: { error: newBidResult.error.message } }
        )
      );
    }

    const newAskResult = Price.fromValue(newAskDecimal.toNumber());
    if (!newAskResult.ok) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Failed to create ask price: ${ctx.error}`,
          { context: { error: newAskResult.error.message } }
        )
      );
    }

    return Spread.create(newBidResult.value, newAskResult.value);
  }

  /**
   * Проверяет, находится ли цена внутри спреда
   *
   * @param price - Цена для проверки
   * @returns True если bid <= price <= ask
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread.contains(Price.fromValue(0.50))); // true
   * console.log(spread.contains(Price.fromValue(0.55))); // false
   * ```
   */
  public contains(price: Price): boolean {
    return !price.isLessThan(this.bid) && !price.isGreaterThan(this.ask);
  }

  /**
   * Проверяет равенство спредов
   *
   * @param other - Спред для сравнения
   * @returns True если оба bid и ask равны
   *
   * @example
   * ```typescript
   * const s1 = Spread.fromNumbers(0.48, 0.52);
   * const s2 = Spread.fromNumbers(0.48, 0.52);
   * console.log(s1.equals(s2)); // true
   * ```
   */
  public equals(other: Spread): boolean {
    return this.bid.equals(other.bid) && this.ask.equals(other.ask);
  }

  /**
   * Преобразует в строковое представление
   *
   * @returns Строка в формате "bid-ask (width)"
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread.toString()); // "0.4800-0.5200 (0.0400)"
   * ```
   */
  public toString(): string {
    return `${this.bid.toString()}-${this.ask.toString()} (${this.width().toFixed(4)})`;
  }

  /**
   * Преобразует в объектное представление
   *
   * @returns Объект с bid, ask, width и midpoint
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread.toObject());
   * // {
   * //   bid: 0.48,
   * //   ask: 0.52,
   * //   width: 0.04,
   * //   midpoint: 0.50
   * // }
   * ```
   */
  public toObject(): { bid: number; ask: number; width: number; midpoint: number } {
    return {
      bid: this.bid.value,
      ask: this.ask.value,
      width: this.width(),
      midpoint: this.midpoint().value,
    };
  }

  /**
   * Сериализует спред в JSON
   *
   * @returns JSON-представление спреда
   *
   * @remarks
   * Используется для передачи данных через API или сохранения в хранилище.
   * Возвращает bid и ask как числа.
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const spread = unwrap(Spread.fromNumbers(0.48, 0.52));
   * const json = spread.toJSON();
   * console.log(json);
   * // { bid: 0.48, ask: 0.52 }
   *
   * // Отправка через API
   * await fetch('/api/spreads', {
   *   method: 'POST',
   *   headers: { 'Content-Type': 'application/json' },
   *   body: JSON.stringify(spread.toJSON())
   * });
   * ```
   */
  public toJSON(): { bid: number; ask: number } {
    return {
      bid: this.bid.value,
      ask: this.ask.value
    };
  }

  /**
   * Десериализует спред из JSON
   *
   * @param json - JSON-объект с данными спреда
   * @returns Result с Spread или InvalidSpreadError/InvalidPriceError
   *
   * @remarks
   * Используется для восстановления спреда из API или хранилища.
   * Все значения валидируются через fromNumbers().
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * // Десериализация из API
   * const response = await fetch('/api/spreads/123');
   * const json = await response.json();
   *
   * const result = Spread.fromJSON(json);
   * if (result.ok) {
   *   const spread = result.value;
   *   console.log(spread.width()); // 0.04
   * } else {
   *   console.error('Invalid spread data:', result.error.message);
   * }
   *
   * // Прямая десериализация
   * const json = { bid: 0.48, ask: 0.52 };
   * const spread = unwrap(Spread.fromJSON(json));
   *
   * // Ошибка при невалидных данных
   * const invalidJson = { bid: 0.60, ask: 0.40 };  // bid > ask
   * const invalidResult = Spread.fromJSON(invalidJson);
   * console.log(invalidResult.ok); // false
   * ```
   */
  public static fromJSON(json: {
    bid: number;
    ask: number;
  }): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    return Spread.fromNumbers(json.bid, json.ask);
  }
}
