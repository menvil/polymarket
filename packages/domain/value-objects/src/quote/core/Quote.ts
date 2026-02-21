import Decimal from 'decimal.js';
import type { MarketDataSourceId, InstrumentId } from '@polymarket/ids';
import { Price } from '../../price/core/Price.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { Spread } from '../../spread/core/Spread.js';
import { Ratio } from '../../ratio/core/Ratio.js';
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
 *    - spreadWidthOrZero() - вычисление ширины спреда
 *    - midOrNull() - вычисление средней цены
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
 * const spread = quote.spreadWidthOrZero(); // Decimal
 * const mid = quote.midOrNull(); // Decimal | null
 *
 * // ❌ В публичном коде - используй QuoteService:
 * const result = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');
 * if (!result.ok) {
 *   console.error(result.error);
 * }
 * ```
 */
export class Quote {
  /** Максимальный timestamp (год 2286) */
  private static readonly MAX_TIMESTAMP = new Decimal(9999999999999);

  /**
   * Helper: бросает ошибку timestamp в зависимости от контекста
   *
   * @internal
   * @param context - Контекст ошибки ('timestamp' или 'now')
   * @param timestampMsg - Сообщение для QuoteInvariantViolation
   * @param nowMsg - Сообщение для Error
   * @throws {QuoteInvariantViolation} Если context === 'timestamp'
   * @throws {Error} Если context === 'now'
   *
   * @remarks
   * Централизует логику бросания ошибок для validateTimestamp().
   * Убирает дублирование if (context === 'timestamp') ... else ... в каждой проверке.
   */
  private static throwTimestampError(
    context: 'timestamp' | 'now',
    timestampMsg: string,
    nowMsg: string
  ): never {
    if (context === 'timestamp') {
      throw new QuoteInvariantViolation(timestampMsg, 'INVALID_TIMESTAMP');
    } else {
      throw new Error(nowMsg);
    }
  }

  /**
   * Валидирует timestamp (Unix ms)
   *
   * @param timestamp - Timestamp для валидации (Decimal)
   * @param context - Контекст для сообщения об ошибке ('timestamp' или 'now')
   * @throws {QuoteInvariantViolation} Если timestamp невалидный
   * @throws {Error} Если timestamp для age() невалидный
   *
   * @remarks
   * Общая валидация для конструктора (timestamp котировки) и age() (now timestamp).
   * Разные типы ошибок для разных контекстов.
   *
   * Инварианты timestamp (Unix ms):
   * - Not NaN
   * - Finite
   * - Integer (целое число миллисекунд)
   * - >= 0 (Unix epoch начинается с 0)
   * - <= MAX_TIMESTAMP (год 2286)
   */
  private static validateTimestamp(
    timestamp: Decimal,
    context: 'timestamp' | 'now'
  ): void {
    // Инвариант: Not NaN
    if (timestamp.isNaN()) {
      Quote.throwTimestampError(
        context,
        `Timestamp must be finite, got ${timestamp.toString()}`,
        'Timestamp cannot be NaN'
      );
    }

    // Инвариант: Finite
    if (!timestamp.isFinite()) {
      Quote.throwTimestampError(
        context,
        `Timestamp must be finite, got ${timestamp.toString()}`,
        'Timestamp must be finite'
      );
    }

    // Инвариант: Integer (Unix ms - целое число)
    if (!timestamp.isInteger()) {
      Quote.throwTimestampError(
        context,
        `Timestamp must be integer milliseconds, got ${timestamp.toString()}`,
        'Timestamp must be integer (Unix ms)'
      );
    }

    // Инвариант: >= 0 (Unix epoch)
    if (timestamp.isNegative()) {
      Quote.throwTimestampError(
        context,
        `Timestamp must be non-negative, got ${timestamp.toString()}`,
        'Timestamp cannot be negative'
      );
    }

    // Инвариант: <= MAX_TIMESTAMP (разумный верхний предел)
    if (timestamp.greaterThan(Quote.MAX_TIMESTAMP)) {
      Quote.throwTimestampError(
        context,
        `Timestamp ${timestamp.toString()} exceeds maximum ${Quote.MAX_TIMESTAMP.toString()}`,
        `Timestamp ${timestamp.toString()} exceeds maximum ${Quote.MAX_TIMESTAMP.toString()}`
      );
    }
  }

  private constructor(
    private readonly _bid: Price | null,
    private readonly _ask: Price | null,
    private readonly _bidSize: Quantity,
    private readonly _askSize: Quantity,
    private readonly _timestampMs: Decimal,
    private readonly _sourceId: MarketDataSourceId,
    private readonly _instrumentId: InstrumentId
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
    Quote.validateTimestamp(_timestampMs, 'timestamp');
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
   * ВАЖНО: timestamp должен быть Decimal (Unix ms).
   * Конвертация Date/number/string → Decimal делается в QuoteService.
   *
   * @param bid - Цена покупки (может быть null)
   * @param ask - Цена продажи (может быть null)
   * @param bidSize - Объём на покупку
   * @param askSize - Объём на продажу
   * @param timestampMs - Временная метка в Unix ms (Decimal)
   * @param sourceId - Источник маркет-данных
   * @param instrumentId - ID инструмента
   * @returns Новый Quote объект
   * @throws {QuoteInvariantViolation} Если нарушены инварианты
   *
   * @example
   * ```typescript
   * // ✅ В Core и Facade
   * Quote.of(bid, ask, bidSize, askSize, new Decimal(Date.now()), sourceId, instrumentId);
   *
   * // ❌ В публичном коде - используй QuoteService
   * const result = QuoteService.create(0.48, 0.52, 100, 150, sourceId, instrumentId);
   * ```
   */
  public static of(
    bid: Price | null,
    ask: Price | null,
    bidSize: Quantity,
    askSize: Quantity,
    timestampMs: Decimal,
    sourceId: MarketDataSourceId,
    instrumentId: InstrumentId
  ): Quote {
    return new Quote(bid, ask, bidSize, askSize, timestampMs, sourceId, instrumentId);
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
   * Возвращает source ID маркет-данных
   *
   * @returns MarketDataSourceId
   *
   * @remarks
   * Идентифицирует источник данных (WebSocket, REST, Replay и т.д.)
   * Позволяет отследить откуда пришла котировка.
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * const sourceId = quote.sourceId();
   * console.log(sourceId); // 'POLYMARKET_WS'
   * ```
   */
  public sourceId(): MarketDataSourceId {
    return this._sourceId;
  }

  /**
   * Возвращает ID инструмента
   *
   * @returns InstrumentId
   *
   * @remarks
   * Venue-specific идентификатор инструмента:
   * - Polymarket: token_id (ERC1155 token ID)
   * - Kalshi: ticker (e.g., "INXD-23DEC31-T4120")
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   * const instrumentId = quote.instrumentId();
   * console.log(instrumentId); // '123456789' (Polymarket token_id)
   * ```
   */
  public instrumentId(): InstrumentId {
    return this._instrumentId;
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
   * @param nowMs - Текущее время в Unix ms (Decimal)
   * @returns Возраст котировки в миллисекундах как Decimal
   * @throws {Error} Если nowMs нарушает инварианты timestamp
   *
   * @remarks
   * Чистая математика: now - timestamp с использованием Decimal.
   * Полезно для проверок устаревания котировок.
   * Если now < timestamp, возвращает отрицательное значение (котировка из будущего).
   *
   * Инварианты timestamp (проверяются в Core):
   * - Not NaN
   * - Finite
   * - Integer (Unix ms - целое число)
   * - >= 0 (Unix epoch начинается с 0)
   *
   * @example
   * ```typescript
   * const quote = Quote.of(...);
   *
   * // Использование
   * const age = quote.age(new Decimal(Date.now()));
   *
   * // Проверка устаревания
   * if (age.greaterThan(5000)) {
   *   console.log('Quote is older than 5 seconds');
   * }
   * ```
   */
  public age(nowMs: Decimal): Decimal {
    // Валидация nowMs через общий метод
    Quote.validateTimestamp(nowMs, 'now');

    return nowMs.minus(this._timestampMs);
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
   * Строгое сравнение включая timestamp и metadata
   *
   * @remarks
   * Сравнивает bid, ask, sizes, timestamp, sourceId И instrumentId.
   * Используйте когда нужно проверить что это именно тот же самый снимок данных
   * из того же источника для того же инструмента.
   *
   * Для большинства случаев используйте equals() без timestamp/metadata.
   *
   * @param other - Другая котировка
   * @returns true если котировки полностью идентичны включая timestamp и metadata
   *
   * @example
   * ```typescript
   * const ts = Date.now();
   * const quote1 = Quote.of(bid, ask, bidSize, askSize, ts, 'SOURCE_A', 'BTC-USD');
   * const quote2 = Quote.of(bid, ask, bidSize, askSize, ts, 'SOURCE_A', 'BTC-USD');
   * const quote3 = Quote.of(bid, ask, bidSize, askSize, ts + 1000, 'SOURCE_A', 'BTC-USD');
   * const quote4 = Quote.of(bid, ask, bidSize, askSize, ts, 'SOURCE_B', 'BTC-USD');
   *
   * console.log(quote1.equalsWithTimestamp(quote2)); // true - полностью идентичны
   * console.log(quote1.equalsWithTimestamp(quote3)); // false - разное время
   * console.log(quote1.equalsWithTimestamp(quote4)); // false - разный источник
   * console.log(quote1.equals(quote3)); // true - одинаковые рыночные данные
   * ```
   */
  public equalsWithTimestamp(other: Quote): boolean {
    // Сначала проверяем рыночные данные
    if (!this.equals(other)) {
      return false;
    }

    // Затем проверяем timestamp (Decimal.equals для точного сравнения)
    if (!this._timestampMs.equals(other._timestampMs)) {
      return false;
    }

    // Затем проверяем metadata (sourceId и instrumentId)
    if (this._sourceId !== other._sourceId) {
      return false;
    }

    if (this._instrumentId !== other._instrumentId) {
      return false;
    }

    return true;
  }

  /**
   * Ширина spread или 0 если не two-sided
   *
   * @returns Ширина spread (Decimal) или 0
   *
   * @remarks
   * Удобный метод для получения spread без проверки на null.
   * Если котировка не two-sided, возвращает 0.
   *
   * Эквивалентно: `quote.spread()?.width() ?? Decimal.ZERO`
   *
   * @example
   * ```typescript
   * // Two-sided quote
   * const quote = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(100), Quantity.of(150), Date.now());
   * console.log(quote.spreadWidthOrZero().toNumber()); // 0.04
   *
   * // Bid-only quote
   * const bidOnly = Quote.of(Price.of(0.50), null, Quantity.of(100), Quantity.ZERO, Date.now());
   * console.log(bidOnly.spreadWidthOrZero().toNumber()); // 0
   * ```
   */
  public spreadWidthOrZero(): Decimal {
    return this.spread()?.width() ?? new Decimal(0);
  }

  /**
   * Mid price (средняя цена между bid и ask) или null
   *
   * @returns Decimal mid price или null если не two-sided
   *
   * @remarks
   * Mid price - это метрика, не рыночная сущность.
   * Возвращает Decimal, а не Price, чтобы избежать ложной типизации.
   *
   * Делегирует вычисление в Spread.mid() для устранения дублирования.
   * Если котировка не two-sided, возвращает null.
   *
   * Если нужен Price объект, вызывающий должен явно создать его:
   * ```typescript
   * const mid = quote.midOrNull();
   * if (mid !== null) {
   *   const priceResult = PriceService.create(mid);
   * }
   * ```
   *
   * Формула: (bid + ask) / 2 (делегируется в Spread.mid())
   *
   * @example
   * ```typescript
   * // Two-sided quote
   * const quote = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(100), Quantity.of(150), Date.now());
   * const mid = quote.midOrNull();
   * console.log(mid?.toNumber()); // 0.50
   *
   * // Bid-only quote
   * const bidOnly = Quote.of(Price.of(0.50), null, Quantity.of(100), Quantity.ZERO, Date.now());
   * console.log(bidOnly.midOrNull()); // null
   * ```
   */
  public midOrNull(): Decimal | null {
    const spread = this.spread();
    return spread ? spread.mid() : null;
  }

  /**
   * Дисбаланс размеров bid/ask
   *
   * @returns Decimal от -1 до 1:
   *   - `-1` = только ask (no bid)
   *   - `0` = идеальный баланс (bidSize === askSize)
   *   - `+1` = только bid (no ask)
   *
   * @remarks
   * Формула: (bidSize - askSize) / (bidSize + askSize)
   *
   * Если оба размера 0, возвращает 0 (нейтральный дисбаланс).
   *
   * Интерпретация:
   * - Положительный imbalance → больше bid ликвидности
   * - Отрицательный imbalance → больше ask ликвидности
   * - Близко к 0 → сбалансированная ликвидность
   *
   * @example
   * ```typescript
   * // Сбалансированная котировка
   * const balanced = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(100), Quantity.of(100), Date.now());
   * console.log(balanced.imbalance().toNumber()); // 0
   *
   * // Больше bid ликвидности
   * const bidHeavy = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(150), Quantity.of(50), Date.now());
   * console.log(bidHeavy.imbalance().toNumber()); // 0.5 (50% дисбаланс в сторону bid)
   *
   * // Больше ask ликвидности
   * const askHeavy = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(50), Quantity.of(150), Date.now());
   * console.log(askHeavy.imbalance().toNumber()); // -0.5 (50% дисбаланс в сторону ask)
   * ```
   */
  public imbalance(): Decimal {
    const bidSize = this._bidSize.value();
    const askSize = this._askSize.value();
    const total = bidSize.plus(askSize);

    // Если оба размера 0, возвращаем нейтральный дисбаланс
    if (total.isZero()) {
      return new Decimal(0);
    }

    return bidSize.minus(askSize).dividedBy(total);
  }

  /**
   * Spread в процентах от mid price (как дробь)
   *
   * @returns Ratio с дробным представлением процента, или null если не two-sided
   *
   * @remarks
   * **ВАЖНО:** Возвращает дробь (fraction), не проценты!
   * - Ratio хранит дробь: 0.08 означает 8%, не число 8
   * - Для отображения: умножьте на 100 (например, `ratio.toDecimal().times(100)`)
   *
   * Формула: spread.width / mid (БЕЗ умножения на 100)
   * Делегирует к Spread.widthRatio() для вычисления.
   *
   * Пример для bid 0.48, ask 0.52:
   * - mid = 0.50
   * - spread = 0.04
   * - результат = 0.04 / 0.50 = 0.08 (представляет 8%)
   *
   * @example
   * ```typescript
   * const quote = Quote.of(
   *   Price.of(new Decimal(0.48)),
   *   Price.of(new Decimal(0.52)),
   *   Quantity.of(new Decimal(100)),
   *   Quantity.of(new Decimal(150)),
   *   new Decimal(Date.now()),
   *   'POLYMARKET_WS' as MarketDataSourceId,
   *   'TEST_MARKET' as InstrumentId
   * );
   * const ratio = quote.spreadPercentage();
   * console.log(ratio?.toDecimal().toNumber()); // 0.08 (8% как дробь)
   *
   * // Для отображения в процентах:
   * const percent = ratio?.toDecimal().times(100).toNumber(); // 8.0
   * ```
   */
  public spreadPercentage(): Ratio | null {
    return this.spread()?.widthRatio() ?? null;
  }
}
