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
 * const bid = Price.fromNumber(0.48);
 * const ask = Price.fromNumber(0.52);
 * const spread = Spread.create(bid, ask);
 * console.log(spread.width()); // 0.04
 * console.log(spread.midpoint().value); // 0.50
 * console.log(spread.widthPercentage().value); // 8%
 * ```
 */
import { Price } from './Price.js';
import { Percentage } from './Percentage.js';
import { TradingError } from '../../shared/errors/TradingError.js';

/**
 * Ошибка невалидного спреда
 *
 * @remarks
 * Выбрасывается когда спред невалиден (bid > ask).
 */
export class InvalidSpreadError extends TradingError {
  constructor(
    public readonly bid: number,
    public readonly ask: number
  ) {
    super(
      `Invalid spread: bid (${bid}) must be <= ask (${ask})`,
      'INVALID_SPREAD'
    );
  }
}

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
   * @returns Экземпляр Spread
   * @throws {InvalidSpreadError} Если bid > ask
   *
   * @remarks
   * Проверяет, что bid <= ask. На рынках предсказаний:
   * - Bid — это максимальная цена, которую покупатели готовы заплатить
   * - Ask — это минимальная цена, по которой продавцы готовы продать
   * - Ask должен быть >= bid (без пересечения рынка)
   *
   * @example
   * ```typescript
   * const bid = Price.fromNumber(0.48);
   * const ask = Price.fromNumber(0.52);
   * const spread = Spread.create(bid, ask);
   * ```
   */
  public static create(bid: Price, ask: Price): Spread {
    if (!Spread.isValid(bid, ask)) {
      throw new InvalidSpreadError(bid.value, ask.value);
    }
    return new Spread(bid, ask);
  }

  /**
   * Создаёт Spread из чисел bid и ask
   *
   * @param bid - Значение цены bid
   * @param ask - Значение цены ask
   * @returns Экземпляр Spread
   * @throws {InvalidPriceError} Если цены невалидны
   * @throws {InvalidSpreadError} Если bid > ask
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * ```
   */
  public static fromNumbers(bid: number, ask: number): Spread {
    const bidPrice = Price.fromNumber(bid);
    const askPrice = Price.fromNumber(ask);
    return Spread.create(bidPrice, askPrice);
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
   * const price = Price.fromNumber(0.50);
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
    return bid.value <= ask.value;
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
    return this.ask.value - this.bid.value;
  }

  /**
   * Вычисляет ширину спреда в процентах
   *
   * @returns Ширина спреда в процентах относительно середины
   *
   * @remarks
   * Вычисляет: (width / midpoint) * 100
   * Это нормализует спред для сравнения на разных уровнях цен.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const widthPct = spread.widthPercentage();
   * console.log(widthPct.value); // 8%
   * // Расчёт: (0.04 / 0.50) * 100 = 8%
   * ```
   */
  public widthPercentage(): Percentage {
    const mid = this.midpoint().value;
    if (mid === 0) {
      return Percentage.zero();
    }
    const widthPct = Math.min((this.width() / mid) * 100, 100);
    return Percentage.fromNumber(widthPct);
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
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const mid = spread.midpoint();
   * console.log(mid.value); // 0.50
   * ```
   */
  public midpoint(): Price {
    const midValue = (this.bid.value + this.ask.value) / 2;
    return Price.fromNumber(midValue);
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
    return Math.abs(this.width()) < Spread.EPSILON;
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
    return this.width() > threshold;
  }

  /**
   * Сужает спред, сдвигая bid/ask ближе друг к другу
   *
   * @param amount - Величина сужения (уменьшает ширину на 2x от этого значения)
   * @returns Новый Spread с суженной шириной
   *
   * @remarks
   * Сдвигает bid вверх и ask вниз на указанную величину.
   * Полезно для стратегий маркет-мейкинга.
   * Если величина привела бы к пересечению, возвращает спред с нулевой шириной в середине.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const tightened = spread.tighten(0.01);
   * console.log(tightened.bid.value); // 0.49
   * console.log(tightened.ask.value); // 0.51
   * console.log(tightened.width()); // 0.02
   * ```
   */
  public tighten(amount: number): Spread {
    const halfWidth = this.width() / 2;
    const tightenAmount = Math.min(amount, halfWidth);

    const newBid = this.bid.add(tightenAmount);
    const newAsk = this.ask.subtract(tightenAmount);

    return Spread.create(newBid, newAsk);
  }

  /**
   * Расширяет спред, раздвигая bid/ask
   *
   * @param amount - Величина расширения (увеличивает ширину на 2x от этого значения)
   * @returns Новый Spread с расширенной шириной
   *
   * @remarks
   * Сдвигает bid вниз и ask вверх на указанную величину.
   * Соблюдает границы цен [0.01, 0.99].
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const widened = spread.widen(0.02);
   * console.log(widened.bid.value); // 0.46
   * console.log(widened.ask.value); // 0.54
   * console.log(widened.width()); // 0.08
   * ```
   */
  public widen(amount: number): Spread {
    const newBid = this.bid.subtract(amount);
    const newAsk = this.ask.add(amount);
    return Spread.create(newBid, newAsk);
  }

  /**
   * Сдвигает спред вверх или вниз
   *
   * @param amount - Величина сдвига (положительное = вверх, отрицательное = вниз)
   * @returns Новый Spread сдвинутый на величину
   *
   * @remarks
   * Сдвигает и bid и ask на одинаковую величину.
   * Сохраняет ширину спреда. Соблюдает границы цен.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const shifted = spread.shift(0.05);
   * console.log(shifted.bid.value); // 0.53
   * console.log(shifted.ask.value); // 0.57
   * console.log(shifted.width()); // 0.04 (без изменений)
   * ```
   */
  public shift(amount: number): Spread {
    const shiftPrice = (price: Price): Price =>
      amount >= 0 ? price.add(amount) : price.subtract(Math.abs(amount));
    return Spread.create(shiftPrice(this.bid), shiftPrice(this.ask));
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
   * console.log(spread.contains(Price.fromNumber(0.50))); // true
   * console.log(spread.contains(Price.fromNumber(0.55))); // false
   * ```
   */
  public contains(price: Price): boolean {
    return price.value >= this.bid.value && price.value <= this.ask.value;
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
}