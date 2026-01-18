/**
 * Quote - котировка маркет-мейкера
 *
 * @remarks
 * Value Object представляющий двухстороннюю котировку (bid/ask).
 *
 * Структура котировки:
 * - bid: цена покупки (lower)
 * - ask: цена продажи (higher)
 * - bidSize: объем на bid
 * - askSize: объем на ask
 * - spread: ask - bid
 *
 * Зачем нужен Quote?
 * - Инкапсуляция котировки как единого объекта
 * - Валидация (bid < ask, positive sizes)
 * - Расчет спреда и mid-price
 * - Проверка crossing (самоисполнение)
 *
 * @example
 * ```typescript
 * const quote = new Quote(
 *   Price.fromNumber(0.64),      // bid
 *   Price.fromNumber(0.66),      // ask
 *   Quantity.fromNumber(100),    // bidSize
 *   Quantity.fromNumber(100),    // askSize
 *   new Date()
 * );
 *
 * console.log(quote.getSpread()); // 0.02
 * console.log(quote.getMidPrice().value); // 0.65
 * ```
 */
import { Price } from './Price.js';
import { Quantity } from './Quantity.js';

/**
 * Value object Quote
 *
 * @remarks
 * Иммутабельный value object для котировок.
 * Bid и Ask могут быть null (односторонняя котировка).
 */
export class Quote {
  /**
   * Создаёт Quote
   *
   * @param bid - Цена bid (null для котировки только ask)
   * @param ask - Цена ask (null для котировки только bid)
   * @param bidSize - Объём bid
   * @param askSize - Объём ask
   * @param timestamp - Временная метка котировки (по умолчанию: текущее время)
   *
   * @throws {Error} Если bid >= ask (когда оба присутствуют)
   * @throws {Error} Если размеры отрицательные (должны быть >= 0)
   *
   * @example
   * ```typescript
   * // Двухсторонняя котировка
   * const quote1 = new Quote(
   *   Price.fromNumber(0.64),
   *   Price.fromNumber(0.66),
   *   Quantity.fromNumber(100),
   *   Quantity.fromNumber(100)
   * );
   *
   * // Котировка только bid
   * const quote2 = new Quote(
   *   Price.fromNumber(0.64),
   *   null,
   *   Quantity.fromNumber(100),
   *   Quantity.fromNumber(0)
   * );
   *
   * // Котировка только ask
   * const quote3 = new Quote(
   *   null,
   *   Price.fromNumber(0.66),
   *   Quantity.fromNumber(0),
   *   Quantity.fromNumber(100)
   * );
   * ```
   */
  constructor(
    public readonly bid: Price | null,
    public readonly ask: Price | null,
    public readonly bidSize: Quantity,
    public readonly askSize: Quantity,
    public readonly timestamp: Date = new Date()
  ) {
    this.validate();
  }

  /**
   * Валидирует котировку
   *
   * @throws {Error} Если валидация не прошла
   *
   * @remarks
   * Проверки:
   * 1. Хотя бы одна сторона должна быть не null
   * 2. Если обе стороны присутствуют: bid < ask
   * 3. Sizes должны быть >= 0
   * 4. Если bid/ask null, соответствующий size должен быть 0
   */
  private validate(): void {
    // Хотя бы одна сторона должна присутствовать
    if (!this.bid && !this.ask) {
      throw new Error('Quote must have at least bid or ask');
    }

    // Bid должен быть меньше ask
    if (this.bid && this.ask && this.bid.value >= this.ask.value) {
      throw new Error(
        `Bid ${this.bid.value} must be less than ask ${this.ask.value}`
      );
    }

    // Размеры должны быть неотрицательными
    if (this.bidSize.value < 0 || this.askSize.value < 0) {
      throw new Error('Quote sizes must be non-negative');
    }

    // Если bid равен null, bidSize должен быть 0
    if (!this.bid && this.bidSize.value > 0) {
      throw new Error('Bid size must be 0 when bid price is null');
    }

    // Если ask равен null, askSize должен быть 0
    if (!this.ask && this.askSize.value > 0) {
      throw new Error('Ask size must be 0 when ask price is null');
    }
  }

  /**
   * Вычисляет спред
   *
   * @returns Спред (ask - bid)
   *
   * @throws {Error} Если котировка односторонняя
   *
   * @remarks
   * spread = ask - bid
   *
   * @example
   * ```typescript
   * const quote = new Quote(
   *   Price.fromNumber(0.64),
   *   Price.fromNumber(0.66),
   *   ...
   * );
   *
   * const spread = quote.getSpread();
   * console.log(spread); // 0.02
   * ```
   */
  public getSpread(): number {
    if (!this.bid || !this.ask) {
      throw new Error('Cannot calculate spread for one-sided quote');
    }
    return this.ask.value - this.bid.value;
  }

  /**
   * Вычисляет среднюю цену
   *
   * @returns Средняя цена ((bid + ask) / 2)
   *
   * @throws {Error} Если котировка односторонняя
   *
   * @remarks
   * midPrice = (bid + ask) / 2
   *
   * @example
   * ```typescript
   * const quote = new Quote(
   *   Price.fromNumber(0.64),
   *   Price.fromNumber(0.66),
   *   ...
   * );
   *
   * const mid = quote.getMidPrice();
   * console.log(mid.value); // 0.65
   * ```
   */
  public getMidPrice(): Price {
    if (!this.bid || !this.ask) {
      throw new Error('Cannot calculate mid-price for one-sided quote');
    }
    return Price.fromNumber((this.bid.value + this.ask.value) / 2);
  }

  /**
   * Проверяет, является ли котировка двухсторонней
   *
   * @returns True если присутствуют и bid, и ask
   *
   * @example
   * ```typescript
   * const quote1 = new Quote(Price.fromNumber(0.64), Price.fromNumber(0.66), ...);
   * console.log(quote1.isTwoSided()); // true
   *
   * const quote2 = new Quote(Price.fromNumber(0.64), null, ...);
   * console.log(quote2.isTwoSided()); // false
   * ```
   */
  public isTwoSided(): boolean {
    return this.bid !== null && this.ask !== null;
  }

  /**
   * Проверяет, является ли котировка только bid
   *
   * @returns True если присутствует только bid
   *
   * @example
   * ```typescript
   * const quote = new Quote(Price.fromNumber(0.64), null, ...);
   * console.log(quote.isBidOnly()); // true
   * ```
   */
  public isBidOnly(): boolean {
    return this.bid !== null && this.ask === null;
  }

  /**
   * Проверяет, является ли котировка только ask
   *
   * @returns True если присутствует только ask
   *
   * @example
   * ```typescript
   * const quote = new Quote(null, Price.fromNumber(0.66), ...);
   * console.log(quote.isAskOnly()); // true
   * ```
   */
  public isAskOnly(): boolean {
    return this.bid === null && this.ask !== null;
  }

  /**
   * Проверяет, пересечётся ли котировка с ценами стакана
   *
   * @param orderbookBid - Лучший bid из стакана
   * @param orderbookAsk - Лучший ask из стакана
   * @returns True если котировка исполнится немедленно
   *
   * @remarks
   * Пересечение происходит когда:
   * - Наш bid >= ask стакана (немедленная покупка)
   * - Наш ask <= bid стакана (немедленная продажа)
   *
   * @example
   * ```typescript
   * const quote = new Quote(
   *   Price.fromNumber(0.67),  // our bid
   *   Price.fromNumber(0.68),
   *   ...
   * );
   *
   * const crosses = quote.crossesMarket(
   *   Price.fromNumber(0.65),  // orderbook bid
   *   Price.fromNumber(0.66)   // orderbook ask
   * );
   * console.log(crosses); // true (our bid 0.67 >= orderbook ask 0.66)
   * ```
   */
  public crossesMarket(orderbookBid: Price | null, orderbookAsk: Price | null): boolean {
    // Наш bid пересекается если >= ask стакана
    if (this.bid && orderbookAsk && this.bid.value >= orderbookAsk.value) {
      return true;
    }

    // Наш ask пересекается если <= bid стакана
    if (this.ask && orderbookBid && this.ask.value <= orderbookBid.value) {
      return true;
    }

    return false;
  }

  /**
   * Создаёт копию с скорректированными ценами
   *
   * @param bidAdjustment - Величина для добавления/вычитания из bid
   * @param askAdjustment - Величина для добавления/вычитания из ask
   * @returns Новый Quote со скорректированными ценами
   *
   * @remarks
   * Используется для корректировки перекоса в стратегиях.
   *
   * @example
   * ```typescript
   * const quote = new Quote(
   *   Price.fromNumber(0.64),
   *   Price.fromNumber(0.66),
   *   ...
   * );
   *
   * // Расширить спред (bid вниз, ask вверх)
   * const widened = quote.withAdjustment(-0.01, +0.01);
   * // bid: 0.63, ask: 0.67
   *
   * // Перекос к bid (управление запасами)
   * const skewed = quote.withAdjustment(-0.01, -0.01);
   * // bid: 0.63, ask: 0.65
   * ```
   */
  public withAdjustment(bidAdjustment: number, askAdjustment: number): Quote {
    const adjustPrice = (price: Price, adjustment: number): Price =>
      adjustment >= 0 ? price.add(adjustment) : price.subtract(Math.abs(adjustment));

    const newBid = this.bid ? adjustPrice(this.bid, bidAdjustment) : null;
    const newAsk = this.ask ? adjustPrice(this.ask, askAdjustment) : null;

    return new Quote(newBid, newAsk, this.bidSize, this.askSize, new Date());
  }

  /**
   * Строковое представление
   *
   * @returns Читаемая строка
   *
   * @example
   * ```typescript
   * const quote = new Quote(...);
   * console.log(quote.toString());
   * // '0.64 (100) / 0.66 (100) [spread: 0.02]'
   * ```
   */
  public toString(): string {
    const bidStr = this.bid ? `${this.bid.value.toFixed(4)} (${this.bidSize.value})` : 'N/A';
    const askStr = this.ask ? `${this.ask.value.toFixed(4)} (${this.askSize.value})` : 'N/A';
    const spreadStr = this.isTwoSided() ? ` [spread: ${this.getSpread().toFixed(4)}]` : '';

    return `${bidStr} / ${askStr}${spreadStr}`;
  }

  /**
   * Проверяет равенство с другой котировкой
   *
   * @param other - Другая котировка для сравнения
   * @returns True если котировки равны
   *
   * @remarks
   * Котировки равны если bid, ask и размеры равны (timestamp игнорируются).
   *
   * @example
   * ```typescript
   * const quote1 = new Quote(...);
   * const quote2 = new Quote(...);
   * console.log(quote1.equals(quote2));
   * ```
   */
  public equals(other: Quote): boolean {
    const pricesEqual = (a: Price | null, b: Price | null): boolean =>
      a === b || (a !== null && b !== null && a.equals(b));

    return (
      pricesEqual(this.bid, other.bid) &&
      pricesEqual(this.ask, other.ask) &&
      this.bidSize.equals(other.bidSize) &&
      this.askSize.equals(other.askSize)
    );
  }
}
