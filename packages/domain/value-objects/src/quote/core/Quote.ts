import Decimal from 'decimal.js';
import { Price } from '../../price/core/Price.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { Spread } from '../../spread/core/Spread.js';
import { QuoteInvariantViolation } from './QuoteInvariantViolation.js';

/**
 * Core Quote Value Object
 *
 * @remarks
 * Представляет котировку рынка (bid/ask pair) с размерами и временной меткой.
 *
 * Содержит:
 * 1. **Инварианты существования** (проверки при создании):
 *    - Хотя бы одна сторона определена (bid или ask)
 *    - bid <= ask (если оба определены)
 *    - Sizes >= 0 (гарантирует Quantity)
 *    - Структурная согласованность: bid=null → bidSize=0, ask=null → askSize=0
 *    - Валидный timestamp (finite, integer, >= 0, <= MAX)
 *
 * 2. **Чистую математику** (query методы, вычисления):
 *    - spreadWidth() - вычисление ширины спреда
 *    - mid() - вычисление средней цены
 *    - spreadPercentage() - вычисление процента спреда
 *    - equals() - сравнение рыночных данных
 *
 * НЕ содержит:
 * - Бизнес-правила про размеры (используй Rules)
 * - Валидацию spread границ (используй Rules)
 * - Market crossing detection бизнес-логику (используй Rules)
 *
 * Внутреннее представление: композиция Price + Quantity + timestamp (Decimal).
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
 * // Query methods (чистая математика)
 * console.log(quote.isTwoSided()); // true
 * const spread = quote.spreadWidth(); // Decimal | null
 * const mid = quote.mid(); // Decimal | null
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
    private readonly _timestampMs: Decimal
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

    // Инвариант 4: структурная согласованность price/size
    // Если bid=null, то bidSize должен быть 0 (нельзя иметь размер без цены)
    if (_bid === null && !_bidSize.value().equals(0)) {
      throw new QuoteInvariantViolation(
        `Bid size must be 0 when bid is null, got ${_bidSize.value().toString()}`,
        'INCONSISTENT_BID_SIZE'
      );
    }

    // Если ask=null, то askSize должен быть 0 (нельзя иметь размер без цены)
    if (_ask === null && !_askSize.value().equals(0)) {
      throw new QuoteInvariantViolation(
        `Ask size must be 0 when ask is null, got ${_askSize.value().toString()}`,
        'INCONSISTENT_ASK_SIZE'
      );
    }

    // Инвариант 5: timestamp должен быть валидным Unix ms
    if (!_timestampMs.isFinite() || _timestampMs.isNaN()) {
      throw new QuoteInvariantViolation(
        `Timestamp must be finite, got ${_timestampMs.toString()}`,
        'INVALID_TIMESTAMP'
      );
    }

    if (!_timestampMs.isInteger()) {
      throw new QuoteInvariantViolation(
        `Timestamp must be integer milliseconds, got ${_timestampMs.toString()}`,
        'INVALID_TIMESTAMP'
      );
    }

    if (_timestampMs.isNegative()) {
      throw new QuoteInvariantViolation(
        `Timestamp must be non-negative, got ${_timestampMs.toString()}`,
        'INVALID_TIMESTAMP'
      );
    }

    // Разумный верхний предел (год 2286)
    const MAX_TIMESTAMP = new Decimal(9999999999999);
    if (_timestampMs.greaterThan(MAX_TIMESTAMP)) {
      throw new QuoteInvariantViolation(
        `Timestamp ${_timestampMs.toString()} exceeds maximum ${MAX_TIMESTAMP.toString()}`,
        'INVALID_TIMESTAMP'
      );
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
   * @param timestamp - Временная метка (Date, Unix ms number, или Decimal)
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
    timestamp: Date | number | Decimal
  ): Quote {
    let timestampMs: Decimal;

    if (timestamp instanceof Date) {
      timestampMs = new Decimal(timestamp.getTime());
    } else if (timestamp instanceof Decimal) {
      timestampMs = timestamp;
    } else {
      timestampMs = new Decimal(timestamp);
    }

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
   * @returns Decimal (Unix ms)
   *
   * @remarks
   * Возвращает Decimal для единообразия с внутренним представлением.
   * Для преобразования в number используйте `.toNumber()`.
   * Для создания Date используйте `getTimestamp()` или `new Date(timestampMs().toNumber())`.
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * const tsMs = quote.timestampMs();  // Decimal
   * console.log(new Date(tsMs.toNumber()).toISOString());
   * ```
   */
  public timestampMs(): Decimal {
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
    return new Date(this._timestampMs.toNumber());
  }

  /**
   * Вычисляет возраст котировки в миллисекундах
   *
   * @param now - Текущее время в Unix ms (обычно Date.now())
   * @returns Возраст котировки в миллисекундах как Decimal
   *
   * @remarks
   * Чистая математика: now - timestamp с использованием Decimal.
   * Полезно для проверок устаревания котировок.
   * Если now < timestamp, возвращает отрицательное значение.
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * const ageMs = quote.age(Date.now());  // Decimal
   *
   * if (ageMs.greaterThan(5000)) {
   *   console.log('Quote is older than 5 seconds');
   * }
   *
   * // Использование в Rules:
   * const MAX_AGE_MS = 10000; // 10 секунд
   * if (quote.age(Date.now()).greaterThan(MAX_AGE_MS)) {
   *   // Quote устарела
   * }
   * ```
   */
  public age(now: number): Decimal {
    return new Decimal(now).minus(this._timestampMs);
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
   * Создает объект Spread из bid и ask
   *
   * @returns Spread объект или null если не two-sided
   *
   * @remarks
   * Делегирует создание Spread.of() для двусторонних котировок.
   * Возвращает null для односторонних котировок (bid-only или ask-only).
   *
   * @example
   * ```typescript
   * const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());
   * const spread = quote.spread();
   * if (spread !== null) {
   *   console.log(`Width: ${spread.width().toString()}`);
   *   console.log(`Mid: ${spread.mid().toString()}`);
   * }
   * ```
   */
  public spread(): Spread | null {
    if (!this.isTwoSided()) {
      return null;
    }
    // SAFETY: isTwoSided() гарантирует что bid и ask не null
    return Spread.of(this._bid!, this._ask!);
  }

  /**
   * Вычисляет ширину спреда
   *
   * @returns Decimal со значением spread или null если не two-sided
   *
   * @remarks
   * Делегирует вычисление объекту Spread.
   *
   * @example
   * ```typescript
   * const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());
   * const width = quote.spreadWidth();
   * if (width !== null) {
   *   console.log(`Spread: ${width.toString()}`);
   * }
   * ```
   */
  public spreadWidth(): Decimal | null {
    const s = this.spread();
    return s !== null ? s.width() : null;
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
   * Делегирует вычисление объекту Spread.
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
    const s = this.spread();
    return s !== null ? s.mid() : null;
  }

  /**
   * Вычисляет spread в процентах от mid
   *
   * @returns Decimal с процентами или null
   *
   * @remarks
   * Делегирует вычисление объекту Spread.
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
    const s = this.spread();
    return s !== null ? s.widthPercentage() : null;
  }

  /**
   * Сравнивает рыночные данные с другой котировкой
   *
   * @remarks
   * СТРОГОЕ равенство без epsilon.
   * Сравнивает bid, ask и sizes БЕЗ timestamp.
   *
   * Timestamp не включён, так как:
   * - Market data приходит с различной точностью timestamp
   * - Разные источники/адаптеры используют локальное время
   * - Семантически важно "одинаковые рыночные условия", а не "один снимок"
   *
   * Для строгого сравнения включая timestamp используйте equalsWithTimestamp().
   * Консистентно с Price.equals() и Spread.equals() которые не сравнивают метаданные.
   *
   * @param other - Другая котировка
   * @returns true если котировки имеют одинаковые рыночные данные
   *
   * @example
   * ```typescript
   * const quote1 = Quote.of(bid, ask, bidSize, askSize, Date.now());
   * const quote2 = Quote.of(bid, ask, bidSize, askSize, Date.now() + 100);
   *
   * // true - одинаковые рыночные условия, разное время
   * console.log(quote1.equals(quote2));
   *
   * // false - это разные снимки данных
   * console.log(quote1.equalsWithTimestamp(quote2));
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

    // Timestamp НЕ сравниваем (см. документацию)
    return true;
  }

  /**
   * Строгое сравнение включая timestamp
   *
   * @remarks
   * Сравнивает bid, ask, sizes И timestamp.
   * Используйте когда нужно проверить что это именно тот же самый снимок данных.
   *
   * Для большинства случаев используйте equals() без timestamp.
   *
   * @param other - Другая котировка
   * @returns true если котировки полностью идентичны включая timestamp
   *
   * @example
   * ```typescript
   * const ts = Date.now();
   * const quote1 = Quote.of(bid, ask, bidSize, askSize, ts);
   * const quote2 = Quote.of(bid, ask, bidSize, askSize, ts);
   * const quote3 = Quote.of(bid, ask, bidSize, askSize, ts + 1000);
   *
   * console.log(quote1.equalsWithTimestamp(quote2)); // true
   * console.log(quote1.equalsWithTimestamp(quote3)); // false - разное время
   * console.log(quote1.equals(quote3)); // true - одинаковые рыночные данные
   * ```
   */
  public equalsWithTimestamp(other: Quote): boolean {
    // Сначала проверяем рыночные данные
    if (!this.equals(other)) {
      return false;
    }

    // Затем проверяем timestamp (Decimal.equals для точного сравнения)
    return this._timestampMs.equals(other._timestampMs);
  }
}
