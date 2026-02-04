import Decimal from 'decimal.js';
import { Price } from '../../price/core/Price.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { QuoteInvariantViolation } from './QuoteInvariantViolation.js';

/**
 * Core Quote Value Object
 *
 * @remarks
 * Представляет котировку рынка (bid/ask pair) с размерами и временной меткой.
 *
 * Содержит ТОЛЬКО инварианты существования:
 * - Хотя бы одна сторона определена (bid или ask)
 * - bid <= ask (если оба определены)
 * - Sizes >= 0 (гарантирует Quantity)
 *
 * НЕ содержит:
 * - Бизнес-правила про размеры (используй Rules)
 * - Валидацию spread (используй Rules)
 * - Market crossing detection бизнес-логику (используй Rules)
 *
 * Внутреннее представление: композиция Price + Quantity + timestamp.
 *
 * @example
 * ```typescript
 * // ✅ В Core и Facade (throws)
 * const quote = Quote.of(
 *   Price.of(0.48),
 *   Price.of(0.52),
 *   Quantity.of(100),
 *   Quantity.of(150),
 *   Date.now()
 * );
 *
 * // One-sided quote
 * const bidOnly = Quote.of(
 *   Price.of(0.50),
 *   null,
 *   Quantity.of(100),
 *   Quantity.ZERO,
 *   Date.now()
 * );
 *
 * // Query methods
 * console.log(quote.isTwoSided()); // true
 * const spread = quote.spreadWidth(); // Decimal | null
 * const mid = quote.midPrice(); // Price | null
 *
 * // ❌ В публичном коде - используй QuoteService:
 * const result = QuoteService.create(0.48, 0.52, 100, 150);
 * if (!result.ok) {
 *   console.error(result.error);
 * }
 * ```
 */
export class Quote {
  private constructor(
    private readonly _bid: Price | null,
    private readonly _ask: Price | null,
    private readonly _bidSize: Quantity,
    private readonly _askSize: Quantity,
    private readonly _timestampMs: number
  ) {
    // Инвариант 1: хотя бы одна сторона определена
    if (_bid === null && _ask === null) {
      throw new QuoteInvariantViolation(
        'At least one side (bid or ask) must be defined',
        'BOTH_SIDES_NULL'
      );
    }

    // Инвариант 2: bid <= ask (если оба определены)
    if (_bid !== null && _ask !== null && _bid.value().greaterThan(_ask.value())) {
      throw new QuoteInvariantViolation(
        `Bid ${_bid.value()} cannot be greater than ask ${_ask.value()}`,
        'BID_GREATER_THAN_ASK'
      );
    }

    // Инвариант 3: sizes >= 0
    // Quantity уже гарантирует non-negative, но проверяем для defensive programming
    if (_bidSize.value().isNegative() || _askSize.value().isNegative()) {
      // Это не должно случиться, но если случится - это баг в Quantity
      throw new Error('Internal error: Quantity should guarantee non-negative values');
    }
  }

  /**
   * Создаёт Quote из компонентов
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Бросает QuoteInvariantViolation при нарушении инвариантов.
   * Для публичного API используйте QuoteService.create().
   *
   * @param bid - Цена покупки (может быть null)
   * @param ask - Цена продажи (может быть null)
   * @param bidSize - Объём на покупку
   * @param askSize - Объём на продажу
   * @param timestamp - Временная метка (Date или Unix ms)
   * @returns Новый Quote объект
   * @throws {QuoteInvariantViolation} Если нарушены инварианты
   *
   * @example
   * ```typescript
   * // ✅ В Core и Facade
   * const quote = Quote.of(
   *   Price.of(0.48),
   *   Price.of(0.52),
   *   Quantity.of(100),
   *   Quantity.of(150),
   *   Date.now()
   * );
   *
   * // ❌ В публичном коде - используй QuoteService
   * const result = QuoteService.create(0.48, 0.52, 100, 150);
   * ```
   */
  public static of(
    bid: Price | null,
    ask: Price | null,
    bidSize: Quantity,
    askSize: Quantity,
    timestamp: Date | number
  ): Quote {
    const timestampMs = timestamp instanceof Date ? timestamp.getTime() : timestamp;
    return new Quote(bid, ask, bidSize, askSize, timestampMs);
  }

  /**
   * Возвращает bid цену
   *
   * @returns Price или null
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * const bid = quote.bid();
   * if (bid !== null) {
   *   console.log(bid.value().toString());
   * }
   * ```
   */
  public bid(): Price | null {
    return this._bid;
  }

  /**
   * Возвращает ask цену
   *
   * @returns Price или null
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * const ask = quote.ask();
   * if (ask !== null) {
   *   console.log(ask.value().toString());
   * }
   * ```
   */
  public ask(): Price | null {
    return this._ask;
  }

  /**
   * Возвращает bid размер
   *
   * @returns Quantity
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * console.log(quote.bidSize().value().toNumber());
   * ```
   */
  public bidSize(): Quantity {
    return this._bidSize;
  }

  /**
   * Возвращает ask размер
   *
   * @returns Quantity
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * console.log(quote.askSize().value().toNumber());
   * ```
   */
  public askSize(): Quantity {
    return this._askSize;
  }

  /**
   * Возвращает timestamp в Unix ms
   *
   * @returns number (Unix ms)
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * const tsMs = quote.timestampMs();
   * console.log(new Date(tsMs).toISOString());
   * ```
   */
  public timestampMs(): number {
    return this._timestampMs;
  }

  /**
   * Получает timestamp как Date объект
   *
   * @remarks
   * Каждый вызов создаёт новый Date объект (immutability).
   *
   * @returns Date объект (новая копия)
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * const date = quote.getTimestamp();
   * date.setFullYear(2050); // ✅ OK - не влияет на Quote
   * ```
   */
  public getTimestamp(): Date {
    return new Date(this._timestampMs);
  }

  /**
   * Проверяет, является ли котировка двусторонней
   *
   * @returns true если есть и bid, и ask
   *
   * @example
   * ```typescript
   * const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());
   * if (quote.isTwoSided()) {
   *   console.log('Both sides available');
   * }
   * ```
   */
  public isTwoSided(): boolean {
    return this._bid !== null && this._ask !== null;
  }

  /**
   * Проверяет, есть ли bid сторона
   *
   * @returns true если bid определён
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * if (quote.hasBid()) {
   *   console.log('Bid:', quote.bid()!.value());
   * }
   * ```
   */
  public hasBid(): boolean {
    return this._bid !== null;
  }

  /**
   * Проверяет, есть ли ask сторона
   *
   * @returns true если ask определён
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * if (quote.hasAsk()) {
   *   console.log('Ask:', quote.ask()!.value());
   * }
   * ```
   */
  public hasAsk(): boolean {
    return this._ask !== null;
  }

  /**
   * Вычисляет ширину спреда
   *
   * @returns Decimal со значением spread или null если не two-sided
   *
   * @example
   * ```typescript
   * const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());
   * const spread = quote.spreadWidth();
   * if (spread !== null) {
   *   console.log(`Spread: ${spread.toString()}`);
   * }
   * ```
   */
  public spreadWidth(): Decimal | null {
    if (!this.isTwoSided()) {
      return null;
    }
    return this._ask!.value().minus(this._bid!.value());
  }

  /**
   * Вычисляет mid (среднее между bid и ask)
   *
   * @returns Decimal mid или null если не two-sided
   *
   * @remarks
   * Возвращает Decimal вместо Price для соблюдения контракта
   * "Core не бросает кроме инвариантов".
   * Для получения Price используйте QuoteService.getMidPrice().
   *
   * @example
   * ```typescript
   * const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());
   * const mid = quote.mid();
   * if (mid !== null) {
   *   console.log(`Mid: ${mid.toString()}`);
   * }
   * ```
   */
  public mid(): Decimal | null {
    if (!this.isTwoSided()) {
      return null;
    }

    return this._bid!.value()
      .plus(this._ask!.value())
      .dividedBy(2);
  }

  /**
   * Вычисляет spread в процентах от mid
   *
   * @returns Decimal с процентами или null
   *
   * @example
   * ```typescript
   * const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());
   * const spreadPct = quote.spreadPercentage();
   * if (spreadPct !== null) {
   *   console.log(`Spread: ${spreadPct.toFixed(2)}%`);
   * }
   * ```
   */
  public spreadPercentage(): Decimal | null {
    const width = this.spreadWidth();
    if (width === null) {
      return null;
    }

    const midValue = this.mid();
    if (midValue === null) {
      return null;
    }

    if (midValue.equals(0)) {
      return new Decimal(0);
    }

    return width.dividedBy(midValue).times(100);
  }

  /**
   * Сравнивает с другой котировкой
   *
   * @remarks
   * СТРОГОЕ равенство без epsilon.
   * Сравнивает bid, ask, sizes и timestamp.
   *
   * @param other - Другая котировка
   * @returns true если котировки идентичны
   *
   * @example
   * ```typescript
   * const quote1 = Quote.of(...);
   * const quote2 = Quote.of(...);
   * if (quote1.equals(quote2)) {
   *   console.log('Quotes are equal');
   * }
   * ```
   */
  public equals(other: Quote): boolean {
    // Сравниваем bid
    if (this._bid === null && other._bid !== null) return false;
    if (this._bid !== null && other._bid === null) return false;
    if (this._bid !== null && other._bid !== null) {
      if (!this._bid.equals(other._bid)) return false;
    }

    // Сравниваем ask
    if (this._ask === null && other._ask !== null) return false;
    if (this._ask !== null && other._ask === null) return false;
    if (this._ask !== null && other._ask !== null) {
      if (!this._ask.equals(other._ask)) return false;
    }

    // Сравниваем sizes
    if (!this._bidSize.equals(other._bidSize)) return false;
    if (!this._askSize.equals(other._askSize)) return false;

    // Сравниваем timestamp (с точностью до миллисекунды)
    return this._timestampMs === other._timestampMs;
  }
}
