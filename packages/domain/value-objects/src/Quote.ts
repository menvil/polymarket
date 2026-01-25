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
 * import { unwrap } from '@polymarket/result';
 *
 * const bid = unwrap(Price.fromValue(0.64));
 * const ask = unwrap(Price.fromValue(0.66));
 * const bidSize = unwrap(Quantity.fromValue(100));
 * const askSize = unwrap(Quantity.fromValue(100));
 *
 * const result = Quote.create(bid, ask, bidSize, askSize);
 * if (result.ok) {
 *   const quote = result.value;
 *   console.log(quote.getSpread()); // 0.02
 *   console.log(quote.getMidPrice().value); // 0.65
 * }
 * ```
 */
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Price } from './Price.js';
import { Quantity } from './Quantity.js';
import Decimal from 'decimal.js';

/**
 * Value object Quote
 *
 * @remarks
 * Иммутабельный value object для котировок.
 * Bid и Ask могут быть null (односторонняя котировка).
 */
export class Quote {
  private constructor(
    public readonly bid: Price | null,
    public readonly ask: Price | null,
    public readonly bidSize: Quantity,
    public readonly askSize: Quantity,
    public readonly timestamp: Date
  ) {}

  /**
   * Создаёт Quote
   *
   * @param bid - Цена bid (null для котировки только ask)
   * @param ask - Цена ask (null для котировки только bid)
   * @param bidSize - Объём bid
   * @param askSize - Объём ask
   * @param timestamp - Временная метка котировки (по умолчанию: текущее время)
   * @returns Result с Quote или InvalidQuoteError
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const bid = unwrap(Price.fromValue(0.64));
   * const ask = unwrap(Price.fromValue(0.66));
   * const bidSize = unwrap(Quantity.fromValue(100));
   * const askSize = unwrap(Quantity.fromValue(100));
   *
   * // Двухсторонняя котировка
   * const result = Quote.create(bid, ask, bidSize, askSize);
   * if (result.ok) {
   *   const quote = result.value;
   * } else {
   *   console.error(result.error.message);
   * }
   *
   * // Или используя unwrap
   * const quote = unwrap(Quote.create(bid, ask, bidSize, askSize));
   *
   * // Котировка только bid
   * const bidOnly = unwrap(Quote.create(bid, null, bidSize, Quantity.zero()));
   *
   * // Котировка только ask
   * const askOnly = unwrap(Quote.create(null, ask, Quantity.zero(), askSize));
   * ```
   */
  public static create(
    bid: Price | null,
    ask: Price | null,
    bidSize: Quantity,
    askSize: Quantity,
    timestamp: Date = new Date()
  ): Result<Quote, InvalidQuoteError> {
    // Хотя бы одна сторона должна присутствовать
    if (!bid && !ask) {
      return Err(
        new InvalidQuoteError('Quote must have at least bid or ask', {
        })
      );
    }

    // Bid должен быть меньше ask
    if (bid && ask && !bid.isLessThan(ask)) {
      return Err(
        new InvalidQuoteError(
          (ctx) => `Bid ${ctx.bid} must be less than ask ${ctx.ask}`,
          { context: { bid: bid.value, ask: ask.value } }
        )
      );
    }

    // Размеры должны быть неотрицательными (используем Decimal для точных сравнений)
    const bidSizeDecimal = new Decimal(bidSize.value);
    const askSizeDecimal = new Decimal(askSize.value);

    if (bidSizeDecimal.lessThan(0) || askSizeDecimal.lessThan(0)) {
      return Err(
        new InvalidQuoteError('Quote sizes must be non-negative', {
          context: {
            bidSize: bidSize.value,
            askSize: askSize.value
          }
        })
      );
    }

    // Если bid равен null, bidSize должен быть 0
    if (!bid && bidSizeDecimal.greaterThan(0)) {
      return Err(
        new InvalidQuoteError('Bid size must be 0 when bid price is null', {
          context: {
            bidSize: bidSize.value
          }
        })
      );
    }

    // Если ask равен null, askSize должен быть 0
    if (!ask && askSizeDecimal.greaterThan(0)) {
      return Err(
        new InvalidQuoteError('Ask size must be 0 when ask price is null', {
          context: {
            askSize: askSize.value
          }
        })
      );
    }

    return Ok(new Quote(bid, ask, bidSize, askSize, timestamp));
  }

  /**
   * Вычисляет спред
   *
   * @returns Result с числом спреда или InvalidQuoteError
   *
   * @remarks
   * spread = ask - bid
   * Возвращает ошибку если котировка односторонняя.
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const quote = unwrap(Quote.create(
   *   unwrap(Price.fromValue(0.64)),
   *   unwrap(Price.fromValue(0.66)),
   *   unwrap(Quantity.fromValue(100)),
   *   unwrap(Quantity.fromValue(100))
   * ));
   *
   * const result = quote.getSpread();
   * if (result.ok) {
   *   console.log(result.value); // 0.02
   * }
   *
   * // Или используя unwrap
   * const spread = unwrap(quote.getSpread());
   * ```
   */
  public getSpread(): Result<number, InvalidQuoteError> {
    if (!this.bid || !this.ask) {
      return Err(
        new InvalidQuoteError('Cannot calculate spread for one-sided quote', {
          context: { bid: this.bid?.value, ask: this.ask?.value }
        })
      );
    }
    // Используем Decimal для точных вычислений
    const spread = new Decimal(this.ask.value).minus(this.bid.value).toNumber();
    return Ok(spread);
  }

  /**
   * Вычисляет среднюю цену
   *
   * @returns Result с Price или InvalidQuoteError
   *
   * @remarks
   * midPrice = (bid + ask) / 2
   * Возвращает ошибку если котировка односторонняя.
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const quote = unwrap(Quote.create(
   *   unwrap(Price.fromValue(0.64)),
   *   unwrap(Price.fromValue(0.66)),
   *   unwrap(Quantity.fromValue(100)),
   *   unwrap(Quantity.fromValue(100))
   * ));
   *
   * const result = quote.getMidPrice();
   * if (result.ok) {
   *   console.log(result.value.value); // 0.65
   * }
   *
   * // Или используя unwrap
   * const mid = unwrap(quote.getMidPrice());
   * ```
   */
  public getMidPrice(): Result<Price, InvalidQuoteError> {
    if (!this.bid || !this.ask) {
      return Err(
        new InvalidQuoteError('Cannot calculate mid-price for one-sided quote', {
          context: { bid: this.bid?.value, ask: this.ask?.value }
        })
      );
    }
    // Используем Decimal для точных вычислений
    const midValue = new Decimal(this.bid.value)
      .plus(this.ask.value)
      .dividedBy(2)
      .toNumber();

    const midResult = Price.fromValue(midValue);
    if (!midResult.ok) {
      return Err(
        new InvalidQuoteError(
          (ctx) => `Failed to calculate mid-price: ${ctx.error}`,
          { context: { error: midResult.error.message, midValue } }
        )
      );
    }

    return Ok(midResult.value);
  }

  /**
   * Проверяет, является ли котировка двухсторонней
   *
   * @returns True если присутствуют и bid, и ask
   *
   * @example
   * ```typescript
   * const quote1 = unwrap(Quote.create(Price.fromValue(0.64), Price.fromValue(0.66), ...);
   * console.log(quote1.isTwoSided()); // true
   *
   * const quote2 = unwrap(Quote.create(Price.fromValue(0.64), null, ...);
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
   * const quote = unwrap(Quote.create(Price.fromValue(0.64), null, ...);
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
   * const quote = unwrap(Quote.create(null, Price.fromValue(0.66), ...);
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
   * const quote = unwrap(Quote.create(
   *   Price.fromValue(0.67),  // our bid
   *   Price.fromValue(0.68),
   *   ...
   * );
   *
   * const crosses = quote.crossesMarket(
   *   Price.fromValue(0.65),  // orderbook bid
   *   Price.fromValue(0.66)   // orderbook ask
   * );
   * console.log(crosses); // true (our bid 0.67 >= orderbook ask 0.66)
   * ```
   */
  public crossesMarket(orderbookBid: Price | null, orderbookAsk: Price | null): boolean {
    // Наш bid пересекается если >= ask стакана
    if (this.bid && orderbookAsk && !this.bid.isLessThan(orderbookAsk)) {
      return true;
    }

    // Наш ask пересекается если <= bid стакана
    if (this.ask && orderbookBid && !this.ask.isGreaterThan(orderbookBid)) {
      return true;
    }

    return false;
  }

  /**
   * Создаёт копию с скорректированными ценами
   *
   * @param bidAdjustment - Величина для добавления/вычитания из bid
   * @param askAdjustment - Величина для добавления/вычитания из ask
   * @returns Result с новым Quote или InvalidQuoteError
   *
   * @remarks
   * Используется для корректировки перекоса в стратегиях.
   *
   * Возвращает Result для правильной обработки ошибок при:
   * - Невалидных adjustment значениях (NaN, Infinity)
   * - Ценах вне допустимого диапазона после корректировки
   * - Пересечении bid/ask после корректировки
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const quote = unwrap(Quote.create(
   *   unwrap(Price.fromValue(0.64)),
   *   unwrap(Price.fromValue(0.66)),
   *   ...
   * ));
   *
   * // Расширить спред (bid вниз, ask вверх)
   * const result = quote.withAdjustment(-0.01, +0.01);
   * if (result.ok) {
   *   const widened = result.value;
   *   // bid: 0.63, ask: 0.67
   * }
   *
   * // Перекос к bid (управление запасами)
   * const skewed = unwrap(quote.withAdjustment(-0.01, -0.01));
   * // bid: 0.63, ask: 0.65
   * ```
   */
  public withAdjustment(bidAdjustment: number, askAdjustment: number): Result<Quote, InvalidQuoteError> {
    // Применить корректировку к цене
    const adjustPrice = (
      price: Price,
      adjustment: number,
      priceType: 'bid' | 'ask'
    ): Result<Price, InvalidQuoteError> => {
      const result = adjustment >= 0
        ? price.add(adjustment)
        : price.subtract(Math.abs(adjustment));

      if (!result.ok) {
        return Err(
          new InvalidQuoteError(
            (ctx) => `Failed to adjust ${ctx.priceType} price: ${ctx.error}`,
            {
              context: {
                priceType,
                originalPrice: price.value,
                adjustment,
                error: result.error.message
              }
            }
          )
        );
      }

      return Ok(result.value);
    };

    // Применить корректировку к bid если есть
    let newBid: Price | null = null;
    if (this.bid) {
      const bidResult = adjustPrice(this.bid, bidAdjustment, 'bid');
      if (!bidResult.ok) {
        return Err(bidResult.error);
      }
      newBid = bidResult.value;
    }

    // Применить корректировку к ask если есть
    let newAsk: Price | null = null;
    if (this.ask) {
      const askResult = adjustPrice(this.ask, askAdjustment, 'ask');
      if (!askResult.ok) {
        return Err(askResult.error);
      }
      newAsk = askResult.value;
    }

    // Quote.create возвращает Result, поэтому просто возвращаем его
    return Quote.create(newBid, newAsk, this.bidSize, this.askSize, new Date());
  }

  /**
   * Строковое представление
   *
   * @returns Читаемая строка
   *
   * @example
   * ```typescript
   * const quote = unwrap(Quote.create(...);
   * console.log(quote.toString());
   * // '0.64 (100) / 0.66 (100) [spread: 0.02]'
   * ```
   */
  public toString(): string {
    const bidStr = this.bid ? `${this.bid.value.toFixed(4)} (${this.bidSize.value})` : 'N/A';
    const askStr = this.ask ? `${this.ask.value.toFixed(4)} (${this.askSize.value})` : 'N/A';

    let spreadStr = '';
    if (this.isTwoSided()) {
      const spreadResult = this.getSpread();
      if (spreadResult.ok) {
        spreadStr = ` [spread: ${spreadResult.value.toFixed(4)}]`;
      }
    }

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
   * const quote1 = unwrap(Quote.create(...);
   * const quote2 = unwrap(Quote.create(...);
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

  /**
   * Сериализует котировку в JSON
   *
   * @returns JSON-представление котировки
   *
   * @remarks
   * Используется для передачи данных через API или сохранения в хранилище.
   * Цены конвертируются в числа, timestamp - в ISO строку.
   *
   * @example
   * ```typescript
   * const quote = unwrap(Quote.create(
   *   unwrap(Price.fromValue(0.64)),
   *   unwrap(Price.fromValue(0.66)),
   *   unwrap(Quantity.fromValue(100)),
   *   unwrap(Quantity.fromValue(100))
   * ));
   *
   * const json = quote.toJSON();
   * console.log(json);
   * // {
   * //   bid: 0.64,
   * //   ask: 0.66,
   * //   bidSize: 100,
   * //   askSize: 100,
   * //   timestamp: '2026-01-25T12:00:00.000Z'
   * // }
   * ```
   */
  public toJSON(): {
    bid: number | null;
    ask: number | null;
    bidSize: number;
    askSize: number;
    timestamp: string;
  } {
    return {
      bid: this.bid ? this.bid.value : null,
      ask: this.ask ? this.ask.value : null,
      bidSize: this.bidSize.value,
      askSize: this.askSize.value,
      timestamp: this.timestamp.toISOString()
    };
  }

  /**
   * Десериализует котировку из JSON
   *
   * @param json - JSON-объект с данными котировки
   * @returns Result с Quote или InvalidQuoteError
   *
   * @remarks
   * Используется для восстановления котировки из API или хранилища.
   * Все значения валидируются через соответствующие фабричные методы.
   *
   * @example
   * ```typescript
   * const json = {
   *   bid: 0.64,
   *   ask: 0.66,
   *   bidSize: 100,
   *   askSize: 100,
   *   timestamp: '2026-01-25T12:00:00.000Z'
   * };
   *
   * const result = Quote.fromJSON(json);
   * if (result.ok) {
   *   const quote = result.value;
   *   console.log(quote.toString());
   * }
   * ```
   */
  public static fromJSON(json: {
    bid: number | null;
    ask: number | null;
    bidSize: number;
    askSize: number;
    timestamp: string;
  }): Result<Quote, InvalidQuoteError> {
    // Создаём Price из чисел (или null)
    let bid: Price | null = null;
    let ask: Price | null = null;

    if (json.bid !== null) {
      const bidResult = Price.fromValue(json.bid);
      if (!bidResult.ok) {
        return Err(
          new InvalidQuoteError(`Invalid bid price: ${bidResult.error.message}`, {
            context: { bid: json.bid }
          })
        );
      }
      bid = bidResult.value;
    }

    if (json.ask !== null) {
      const askResult = Price.fromValue(json.ask);
      if (!askResult.ok) {
        return Err(
          new InvalidQuoteError(`Invalid ask price: ${askResult.error.message}`, {
            context: { ask: json.ask }
          })
        );
      }
      ask = askResult.value;
    }

    // Создаём Quantity из чисел (используем minSize=0 для десериализации)
    const bidSizeResult = Quantity.fromValue(json.bidSize, 0);
    if (!bidSizeResult.ok) {
      return Err(
        new InvalidQuoteError(`Invalid bid size: ${bidSizeResult.error.message}`, {
          context: { bidSize: json.bidSize }
        })
      );
    }

    const askSizeResult = Quantity.fromValue(json.askSize, 0);
    if (!askSizeResult.ok) {
      return Err(
        new InvalidQuoteError(`Invalid ask size: ${askSizeResult.error.message}`, {
          context: { askSize: json.askSize }
        })
      );
    }

    // Парсим timestamp
    const timestamp = new Date(json.timestamp);
    if (isNaN(timestamp.getTime())) {
      return Err(
        new InvalidQuoteError(`Invalid timestamp: ${json.timestamp}`, {
          context: { timestamp: json.timestamp }
        })
      );
    }

    // Создаём Quote через обычный фабричный метод
    return Quote.create(bid, ask, bidSizeResult.value, askSizeResult.value, timestamp);
  }
}
