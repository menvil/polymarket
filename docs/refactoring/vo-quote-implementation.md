# Quote Value Object: Детальный план рефакторинга и имплементации

## Метаданные

- **Value Object:** Quote
- **Текущий файл:** `packages/domain/value-objects/src/Quote.ts` (633 lines)
- **Сложность:** High (nullable bid/ask, sizes, market crossing detection)
- **Зависимости:** `Price`, `Quantity`, `@polymarket/math`, `@polymarket/errors`, `@polymarket/result`
- **Приоритет:** 🔴 ВЫСОКИЙ (order book quotes, market making)

---

## Специфика Quote

### Характеристики

**Назначение:** Представляет котировку рынка (bid/ask pair) с размерами и временной меткой.

**Особенности:**
- Поддерживает **one-sided quotes** (bid или ask может быть `null`)
- Хранит размеры (bidSize, askSize) для каждой стороны
- Вычисляет spread и mid-price
- Определяет пересечение с order book
- Поддерживает adjustment операции

**Поля:**
- `bid: Price | null` - цена покупки
- `ask: Price | null` - цена продажи
- `bidSize: Quantity` - объём на покупку
- `askSize: Quantity` - объём на продажу
- `timestampMs: number` - время котировки (Unix ms)

**Инварианты:**

1. ✅ `bid <= ask` (если оба не null)
2. ✅ `bidSize >= 0`
3. ✅ `askSize >= 0`
4. ✅ Хотя бы одна сторона должна быть не-null (bid или ask)

**Бизнес-правила (контекстуальные):**

1. 🔶 `bidSize > 0` если `bid != null` (для валидных market maker quotes)
2. 🔶 `askSize > 0` если `ask != null` (для валидных market maker quotes)
3. 🔶 `spread >= minSpread` (для нормальных рынков)
4. 🔶 `spread <= maxSpread` (для проверки манипуляций)

---

## Проблемы текущей имплементации

### 1. Date mutability (CRITICAL)
```typescript
public readonly timestamp: Date  // ❌ Мутабельный объект
```

**Решение:** Хранить как `timestampMs: number`

### 2. Serialization в Core (HIGH)
```typescript
public toJSON() { /*...*/ }  // ❌ Технический concern в Core
public toString(): string { /*...*/ }  // ❌ Formatting в Core
```

**Решение:** Переместить в Adapters Layer

### 3. Отсутствие Rules Layer (MEDIUM)
Валидация размеров и логика side consistency не выделена в переиспользуемые rules.

### 4. Отсутствие Policy Layer (MEDIUM)
Нет специфичных политик для market making, crossing detection.

---

## Целевая архитектура

### Слои

#### Core Layer

```typescript
/**
 * Quote - котировка рынка с bid/ask и размерами
 *
 * Инварианты:
 * - bid <= ask (если оба не null)
 * - bidSize >= 0, askSize >= 0
 * - Хотя бы одна сторона (bid или ask) должна быть определена
 *
 * @example
 * ```typescript
 * // Two-sided quote
 * const quote = Quote.of(
 *   Price.of(new Decimal(0.48)),
 *   Price.of(new Decimal(0.52)),
 *   Quantity.of(new Decimal(100)),
 *   Quantity.of(new Decimal(150)),
 *   Date.now()
 * );
 *
 * // One-sided quote (bid only)
 * const bidOnly = Quote.of(
 *   Price.of(new Decimal(0.50)),
 *   null,
 *   Quantity.of(new Decimal(200)),
 *   Quantity.ZERO,
 *   Date.now()
 * );
 * ```
 */
export class Quote {
  private constructor(
    private readonly b: Price | null,
    private readonly a: Price | null,
    private readonly bSize: Quantity,
    private readonly aSize: Quantity,
    private readonly tsMs: number
  ) {
    // Инвариант: хотя бы одна сторона определена
    if (b === null && a === null) {
      throw new QuoteInvariantViolation(
        'At least one side (bid or ask) must be defined'
      );
    }

    // Инвариант: bid <= ask (если оба определены)
    if (b !== null && a !== null && b.value().greaterThan(a.value())) {
      throw new QuoteInvariantViolation(
        `Bid ${b.value()} cannot be greater than ask ${a.value()}`,
        { bidValue: b.value().toNumber(), askValue: a.value().toNumber() }
      );
    }

    // Инвариант: sizes >= 0 (Quantity уже гарантирует это)
    // Проверка для defensive programming
    if (bSize.value().isNegative()) {
      throw new QuoteInvariantViolation(
        'Bid size cannot be negative',
        { bidSize: bSize.value().toNumber() }
      );
    }

    if (aSize.value().isNegative()) {
      throw new QuoteInvariantViolation(
        'Ask size cannot be negative',
        { askSize: aSize.value().toNumber() }
      );
    }
  }

  /**
   * Создаёт Quote из компонентов
   *
   * @param bid - Цена покупки (может быть null)
   * @param ask - Цена продажи (может быть null)
   * @param bidSize - Объём на покупку
   * @param askSize - Объём на продажу
   * @param timestamp - Временная метка (Date или Unix ms)
   * @returns Новый Quote объект
   *
   * @throws {QuoteInvariantViolation} Если нарушены инварианты
   *
   * @example
   * ```typescript
   * const quote = Quote.of(
   *   Price.of(new Decimal(0.48)),
   *   Price.of(new Decimal(0.52)),
   *   Quantity.of(new Decimal(100)),
   *   Quantity.of(new Decimal(150)),
   *   Date.now()
   * );
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

  // Getters

  public bid(): Price | null {
    return this.b;
  }

  public ask(): Price | null {
    return this.a;
  }

  public bidSize(): Quantity {
    return this.bSize;
  }

  public askSize(): Quantity {
    return this.aSize;
  }

  public timestampMs(): number {
    return this.tsMs;
  }

  /**
   * Получает timestamp как Date объект
   *
   * @returns Date объект (новая копия)
   */
  public getTimestamp(): Date {
    return new Date(this.tsMs);
  }

  // Query methods

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
    return this.b !== null && this.a !== null;
  }

  /**
   * Проверяет, есть ли bid сторона
   *
   * @returns true если bid определён
   */
  public hasBid(): boolean {
    return this.b !== null;
  }

  /**
   * Проверяет, есть ли ask сторона
   *
   * @returns true если ask определён
   */
  public hasAsk(): boolean {
    return this.a !== null;
  }

  /**
   * Вычисляет ширину спреда
   *
   * @returns Decimal со значением spread или null если не two-sided
   *
   * @example
   * ```typescript
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
    // TypeScript теперь знает, что b и a не null
    return this.a!.value().minus(this.b!.value());
  }

  /**
   * Вычисляет mid-price
   *
   * @returns Price mid или null если не two-sided
   *
   * @example
   * ```typescript
   * const mid = quote.midPrice();
   * if (mid !== null) {
   *   console.log(`Mid: ${mid.value()}`);
   * }
   * ```
   */
  public midPrice(): Price | null {
    if (!this.isTwoSided()) {
      return null;
    }

    const midValue = this.b!.value()
      .plus(this.a!.value())
      .dividedBy(2);

    return Price.of(midValue);
  }

  /**
   * Вычисляет spread в процентах от mid
   *
   * @returns Decimal с процентами или null
   *
   * @example
   * ```typescript
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

    const mid = this.midPrice();
    if (mid === null) {
      return null;
    }

    const midValue = mid.value();
    if (midValue.equals(0)) {
      return new Decimal(0);
    }

    return width.dividedBy(midValue).times(100);
  }

  /**
   * Проверяет, пересекается ли quote с order book
   *
   * Пересечение происходит когда:
   * - Наш bid >= orderbook ask (мы готовы покупать по цене выше рынка)
   * - Наш ask <= orderbook bid (мы готовы продавать по цене ниже рынка)
   *
   * @param orderbookBid - Лучший bid в order book
   * @param orderbookAsk - Лучший ask в order book
   * @returns true если есть пересечение
   *
   * @example
   * ```typescript
   * const crosses = quote.crossesMarket(
   *   Price.of(new Decimal(0.50)),
   *   Price.of(new Decimal(0.51))
   * );
   * if (crosses) {
   *   console.log('Quote would cross the market!');
   * }
   * ```
   */
  public crossesMarket(
    orderbookBid: Price | null,
    orderbookAsk: Price | null
  ): boolean {
    // Проверяем пересечение bid стороны
    if (this.b !== null && orderbookAsk !== null) {
      if (this.b.value().greaterThanOrEqualTo(orderbookAsk.value())) {
        return true;
      }
    }

    // Проверяем пересечение ask стороны
    if (this.a !== null && orderbookBid !== null) {
      if (this.a.value().lessThanOrEqualTo(orderbookBid.value())) {
        return true;
      }
    }

    return false;
  }

  /**
   * Сравнивает с другой котировкой
   *
   * @param other - Другая котировка
   * @param epsilon - Порог для сравнения цен
   * @returns true если котировки идентичны
   *
   * @remarks
   * Сравнивает bid, ask, sizes и timestamp
   *
   * @example
   * ```typescript
   * if (quote1.equals(quote2, new Decimal(0.0001))) {
   *   console.log('Quotes are equal');
   * }
   * ```
   */
  public equals(other: Quote, epsilon: Decimal): boolean {
    // Сравниваем bid
    if (this.b === null && other.b !== null) return false;
    if (this.b !== null && other.b === null) return false;
    if (this.b !== null && other.b !== null) {
      if (!this.b.equals(other.b, epsilon)) return false;
    }

    // Сравниваем ask
    if (this.a === null && other.a !== null) return false;
    if (this.a !== null && other.a === null) return false;
    if (this.a !== null && other.a !== null) {
      if (!this.a.equals(other.a, epsilon)) return false;
    }

    // Сравниваем sizes
    if (!this.bSize.equals(other.bSize, epsilon)) return false;
    if (!this.aSize.equals(other.aSize, epsilon)) return false;

    // Сравниваем timestamp (с точностью до миллисекунды)
    return this.tsMs === other.tsMs;
  }
}
```

---

#### Rules Layer

**ValidateBidAsk.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Price } from '../core/Price.js';

/**
 * Проверяет, что bid <= ask
 *
 * @remarks
 * Используется для валидации двусторонних котировок
 *
 * @example
 * ```typescript
 * const result = ValidateBidAsk.check(bid, ask);
 * if (!result.ok) {
 *   console.error(result.error.message);
 * }
 * ```
 */
export class ValidateBidAsk {
  /**
   * Проверяет соотношение bid/ask
   *
   * @param bid - Цена покупки
   * @param ask - Цена продажи
   * @returns Result с void или InvalidQuoteError
   */
  public static check(
    bid: Price,
    ask: Price
  ): Result<void, InvalidQuoteError> {
    if (bid.value().greaterThan(ask.value())) {
      return Err(
        new InvalidQuoteError(
          `Bid ${bid.value()} cannot be greater than ask ${ask.value()}`,
          {
            bidValue: bid.value().toNumber(),
            askValue: ask.value().toNumber()
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**ValidateQuoteSizes.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Price } from '../core/Price.js';
import { Quantity } from '../core/Quantity.js';

/**
 * Проверяет консистентность размеров котировки
 *
 * @remarks
 * Правило: если цена определена, размер должен быть > 0
 *
 * @example
 * ```typescript
 * const result = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);
 * if (!result.ok) {
 *   console.error('Invalid sizes');
 * }
 * ```
 */
export class ValidateQuoteSizes {
  /**
   * Проверяет соответствие размеров ценам
   *
   * @param bid - Цена покупки (может быть null)
   * @param bidSize - Объём покупки
   * @param ask - Цена продажи (может быть null)
   * @param askSize - Объём продажи
   * @returns Result с void или InvalidQuoteError
   */
  public static check(
    bid: Price | null,
    bidSize: Quantity,
    ask: Price | null,
    askSize: Quantity
  ): Result<void, InvalidQuoteError> {
    // Если bid определён, bidSize должен быть положительным
    if (bid !== null && !bidSize.isPositive()) {
      return Err(
        new InvalidQuoteError(
          'Bid size must be positive when bid is defined',
          {
            bidValue: bid.value().toNumber(),
            bidSize: bidSize.value().toNumber()
          }
        )
      );
    }

    // Если ask определён, askSize должен быть положительным
    if (ask !== null && !askSize.isPositive()) {
      return Err(
        new InvalidQuoteError(
          'Ask size must be positive when ask is defined',
          {
            askValue: ask.value().toNumber(),
            askSize: askSize.value().toNumber()
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**ValidateMinSpread.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Decimal } from '@polymarket/math';

/**
 * Проверяет минимальную ширину спреда
 *
 * @remarks
 * Используется для предотвращения too tight spreads
 *
 * @example
 * ```typescript
 * const result = ValidateMinSpread.check(spread, new Decimal(0.001));
 * ```
 */
export class ValidateMinSpread {
  /**
   * Проверяет минимальный spread
   *
   * @param spread - Ширина спреда
   * @param minSpread - Минимально допустимый spread
   * @returns Result с void или InvalidQuoteError
   */
  public static check(
    spread: Decimal,
    minSpread: Decimal
  ): Result<void, InvalidQuoteError> {
    if (spread.lessThan(minSpread)) {
      return Err(
        new InvalidQuoteError(
          `Spread ${spread} is below minimum ${minSpread}`,
          {
            spread: spread.toNumber(),
            minSpread: minSpread.toNumber()
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**ValidateMaxSpread.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Decimal } from '@polymarket/math';

/**
 * Проверяет максимальную ширину спреда
 *
 * @remarks
 * Используется для обнаружения аномально широких спредов
 * (возможная манипуляция или ошибка)
 *
 * @example
 * ```typescript
 * const result = ValidateMaxSpread.check(spread, new Decimal(0.10));
 * ```
 */
export class ValidateMaxSpread {
  /**
   * Проверяет максимальный spread
   *
   * @param spread - Ширина спреда
   * @param maxSpread - Максимально допустимый spread
   * @returns Result с void или InvalidQuoteError
   */
  public static check(
    spread: Decimal,
    maxSpread: Decimal
  ): Result<void, InvalidQuoteError> {
    if (spread.greaterThan(maxSpread)) {
      return Err(
        new InvalidQuoteError(
          `Spread ${spread} exceeds maximum ${maxSpread}`,
          {
            spread: spread.toNumber(),
            maxSpread: maxSpread.toNumber()
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**ValidateMarketCrossing.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Price } from '../core/Price.js';

/**
 * Проверяет, что котировка не пересекает market
 *
 * @remarks
 * Пересечение - это когда:
 * - Наш bid >= orderbook ask
 * - Наш ask <= orderbook bid
 *
 * @example
 * ```typescript
 * const result = ValidateMarketCrossing.check(
 *   myBid, myAsk, orderbookBid, orderbookAsk
 * );
 * ```
 */
export class ValidateMarketCrossing {
  /**
   * Проверяет отсутствие market crossing
   *
   * @param quoteBid - Наш bid
   * @param quoteAsk - Наш ask
   * @param orderbookBid - Лучший bid в order book
   * @param orderbookAsk - Лучший ask в order book
   * @returns Result с void или InvalidQuoteError
   */
  public static check(
    quoteBid: Price | null,
    quoteAsk: Price | null,
    orderbookBid: Price | null,
    orderbookAsk: Price | null
  ): Result<void, InvalidQuoteError> {
    // Проверяем пересечение bid стороны
    if (quoteBid !== null && orderbookAsk !== null) {
      if (quoteBid.value().greaterThanOrEqualTo(orderbookAsk.value())) {
        return Err(
          new InvalidQuoteError(
            `Quote bid ${quoteBid.value()} would cross orderbook ask ${orderbookAsk.value()}`,
            {
              quoteBid: quoteBid.value().toNumber(),
              orderbookAsk: orderbookAsk.value().toNumber()
            }
          )
        );
      }
    }

    // Проверяем пересечение ask стороны
    if (quoteAsk !== null && orderbookBid !== null) {
      if (quoteAsk.value().lessThanOrEqualTo(orderbookBid.value())) {
        return Err(
          new InvalidQuoteError(
            `Quote ask ${quoteAsk.value()} would cross orderbook bid ${orderbookBid.value()}`,
            {
              quoteAsk: quoteAsk.value().toNumber(),
              orderbookBid: orderbookBid.value().toNumber()
            }
          )
        );
      }
    }

    return Ok(undefined);
  }
}
```

---

#### Policy Layer

**MarketMakingQuotePolicy.ts:**
```typescript
import { Result, Ok } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Decimal } from '@polymarket/math';
import { Price } from '../core/Price.js';
import { Quantity } from '../core/Quantity.js';
import { Quote } from '../core/Quote.js';
import { ValidateBidAsk } from '../rules/ValidateBidAsk.js';
import { ValidateQuoteSizes } from '../rules/ValidateQuoteSizes.js';
import { ValidateMinSpread } from '../rules/ValidateMinSpread.js';
import { ValidateMaxSpread } from '../rules/ValidateMaxSpread.js';

/**
 * Политика для market making котировок
 *
 * @remarks
 * Правила:
 * 1. Bid <= Ask
 * 2. Размеры должны быть положительными если цена определена
 * 3. Spread >= 0.001 (0.1%)
 * 4. Spread <= 0.05 (5%)
 *
 * @example
 * ```typescript
 * const result = MarketMakingQuotePolicy.validateForMarketMaking(
 *   bid, ask, bidSize, askSize
 * );
 * if (result.ok) {
 *   const quote = result.value;
 * }
 * ```
 */
export class MarketMakingQuotePolicy {
  private static readonly MIN_SPREAD = new Decimal(0.001); // 0.1%
  private static readonly MAX_SPREAD = new Decimal(0.05);  // 5%

  /**
   * Валидирует котировку для market making
   *
   * @param bid - Цена покупки
   * @param ask - Цена продажи
   * @param bidSize - Объём покупки
   * @param askSize - Объём продажи
   * @param timestamp - Временная метка (опционально)
   * @returns Result с Quote или InvalidQuoteError
   */
  public static validateForMarketMaking(
    bid: Price | null,
    ask: Price | null,
    bidSize: Quantity,
    askSize: Quantity,
    timestamp?: Date | number
  ): Result<Quote, InvalidQuoteError> {
    // Для market making нужна двусторонняя котировка
    if (bid === null || ask === null) {
      return Err(
        new InvalidQuoteError(
          'Market making requires two-sided quote',
          { hasBid: bid !== null, hasAsk: ask !== null }
        )
      );
    }

    // 1. Проверяем bid <= ask
    const bidAskResult = ValidateBidAsk.check(bid, ask);
    if (!bidAskResult.ok) {
      return Err(bidAskResult.error);
    }

    // 2. Проверяем размеры
    const sizesResult = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);
    if (!sizesResult.ok) {
      return Err(sizesResult.error);
    }

    // 3. Вычисляем spread
    const spread = ask.value().minus(bid.value());

    // 4. Проверяем минимальный spread
    const minSpreadResult = ValidateMinSpread.check(
      spread,
      MarketMakingQuotePolicy.MIN_SPREAD
    );
    if (!minSpreadResult.ok) {
      return Err(minSpreadResult.error);
    }

    // 5. Проверяем максимальный spread
    const maxSpreadResult = ValidateMaxSpread.check(
      spread,
      MarketMakingQuotePolicy.MAX_SPREAD
    );
    if (!maxSpreadResult.ok) {
      return Err(maxSpreadResult.error);
    }

    // Все проверки пройдены - создаём Quote
    const ts = timestamp ?? Date.now();
    return Ok(Quote.of(bid, ask, bidSize, askSize, ts));
  }
}
```

**AggressiveQuotePolicy.ts:**
```typescript
import { Result, Ok } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Price } from '../core/Price.js';
import { Quantity } from '../core/Quantity.js';
import { Quote } from '../core/Quote.js';
import { ValidateBidAsk } from '../rules/ValidateBidAsk.js';
import { ValidateQuoteSizes } from '../rules/ValidateQuoteSizes.js';
import { ValidateMarketCrossing } from '../rules/ValidateMarketCrossing.js';

/**
 * Политика для агрессивных котировок
 *
 * @remarks
 * Правила:
 * 1. Bid <= Ask
 * 2. Размеры должны быть положительными
 * 3. Не должно быть market crossing
 *
 * Агрессивные котировки могут быть односторонними
 * и иметь узкий spread (например, для тейкинга).
 *
 * @example
 * ```typescript
 * const result = AggressiveQuotePolicy.validateAggressiveQuote(
 *   bid, ask, bidSize, askSize, orderbookBid, orderbookAsk
 * );
 * ```
 */
export class AggressiveQuotePolicy {
  /**
   * Валидирует агрессивную котировку
   *
   * @param bid - Цена покупки
   * @param ask - Цена продажи
   * @param bidSize - Объём покупки
   * @param askSize - Объём продажи
   * @param orderbookBid - Лучший bid в order book
   * @param orderbookAsk - Лучший ask в order book
   * @param timestamp - Временная метка (опционально)
   * @returns Result с Quote или InvalidQuoteError
   */
  public static validateAggressiveQuote(
    bid: Price | null,
    ask: Price | null,
    bidSize: Quantity,
    askSize: Quantity,
    orderbookBid: Price | null,
    orderbookAsk: Price | null,
    timestamp?: Date | number
  ): Result<Quote, InvalidQuoteError> {
    // Хотя бы одна сторона должна быть определена
    if (bid === null && ask === null) {
      return Err(
        new InvalidQuoteError(
          'At least one side must be defined',
          {}
        )
      );
    }

    // Если обе стороны определены - проверяем bid <= ask
    if (bid !== null && ask !== null) {
      const bidAskResult = ValidateBidAsk.check(bid, ask);
      if (!bidAskResult.ok) {
        return Err(bidAskResult.error);
      }
    }

    // Проверяем размеры
    const sizesResult = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);
    if (!sizesResult.ok) {
      return Err(sizesResult.error);
    }

    // Проверяем отсутствие market crossing
    const crossingResult = ValidateMarketCrossing.check(
      bid,
      ask,
      orderbookBid,
      orderbookAsk
    );
    if (!crossingResult.ok) {
      return Err(crossingResult.error);
    }

    // Все проверки пройдены
    const ts = timestamp ?? Date.now();
    return Ok(Quote.of(bid, ask, bidSize, askSize, ts));
  }
}
```

---

#### Facade Layer

**QuoteService.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import {
  InvalidQuoteError,
  InvalidPriceError,
  InvalidQuantityError
} from '@polymarket/errors';
import { Decimal } from '@polymarket/math';
import { Price } from '../core/Price.js';
import { Quantity } from '../core/Quantity.js';
import { Quote } from '../core/Quote.js';

/**
 * Фасад для работы с котировками
 *
 * @remarks
 * Предоставляет высокоуровневые операции:
 * - Создание котировок из различных представлений
 * - Adjustment операции (shift, skew)
 * - Update операций (sizes, prices)
 *
 * @example
 * ```typescript
 * const result = QuoteService.create(
 *   new Decimal(0.48),
 *   new Decimal(0.52),
 *   new Decimal(100),
 *   new Decimal(150)
 * );
 * ```
 */
export class QuoteService {
  /**
   * Создаёт Quote из Decimal значений
   *
   * @param bidValue - Значение bid (может быть null)
   * @param askValue - Значение ask (может быть null)
   * @param bidSizeValue - Значение bid size
   * @param askSizeValue - Значение ask size
   * @param timestamp - Временная метка (опционально)
   * @returns Result с Quote или ошибкой
   *
   * @example
   * ```typescript
   * const result = QuoteService.create(
   *   new Decimal(0.50),
   *   new Decimal(0.51),
   *   new Decimal(100),
   *   new Decimal(200)
   * );
   * if (result.ok) {
   *   const quote = result.value;
   * }
   * ```
   */
  public static create(
    bidValue: Decimal | null,
    askValue: Decimal | null,
    bidSizeValue: Decimal,
    askSizeValue: Decimal,
    timestamp?: Date | number
  ): Result<Quote, InvalidPriceError | InvalidQuantityError | InvalidQuoteError> {
    // Создаём Price объекты
    let bid: Price | null = null;
    if (bidValue !== null) {
      try {
        bid = Price.of(bidValue);
      } catch (error) {
        return Err(
          new InvalidPriceError(
            `Invalid bid value: ${error.message}`,
            { value: bidValue.toNumber() }
          )
        );
      }
    }

    let ask: Price | null = null;
    if (askValue !== null) {
      try {
        ask = Price.of(askValue);
      } catch (error) {
        return Err(
          new InvalidPriceError(
            `Invalid ask value: ${error.message}`,
            { value: askValue.toNumber() }
          )
        );
      }
    }

    // Создаём Quantity объекты
    let bidSize: Quantity;
    try {
      bidSize = Quantity.of(bidSizeValue);
    } catch (error) {
      return Err(
        new InvalidQuantityError(
          `Invalid bid size: ${error.message}`,
          { value: bidSizeValue.toNumber() }
        )
      );
    }

    let askSize: Quantity;
    try {
      askSize = Quantity.of(askSizeValue);
    } catch (error) {
      return Err(
        new InvalidQuantityError(
          `Invalid ask size: ${error.message}`,
          { value: askSizeValue.toNumber() }
        )
      );
    }

    // Создаём Quote
    try {
      const ts = timestamp ?? Date.now();
      return Ok(Quote.of(bid, ask, bidSize, askSize, ts));
    } catch (error) {
      return Err(
        new InvalidQuoteError(
          `Failed to create quote: ${error.message}`,
          {}
        )
      );
    }
  }

  /**
   * Создаёт Quote из number значений
   *
   * @param bidValue - Значение bid (может быть null)
   * @param askValue - Значение ask (может быть null)
   * @param bidSizeValue - Значение bid size
   * @param askSizeValue - Значение ask size
   * @param timestamp - Временная метка (опционально)
   * @returns Result с Quote или ошибкой
   *
   * @example
   * ```typescript
   * const result = QuoteService.fromNumbers(0.50, 0.51, 100, 200);
   * ```
   */
  public static fromNumbers(
    bidValue: number | null,
    askValue: number | null,
    bidSizeValue: number,
    askSizeValue: number,
    timestamp?: Date | number
  ): Result<Quote, InvalidPriceError | InvalidQuantityError | InvalidQuoteError> {
    return QuoteService.create(
      bidValue !== null ? new Decimal(bidValue) : null,
      askValue !== null ? new Decimal(askValue) : null,
      new Decimal(bidSizeValue),
      new Decimal(askSizeValue),
      timestamp
    );
  }

  /**
   * Создаёт одностороннюю bid котировку
   *
   * @param bidValue - Значение bid
   * @param bidSizeValue - Значение bid size
   * @param timestamp - Временная метка (опционально)
   * @returns Result с Quote или ошибкой
   *
   * @example
   * ```typescript
   * const result = QuoteService.bidOnly(new Decimal(0.50), new Decimal(100));
   * ```
   */
  public static bidOnly(
    bidValue: Decimal,
    bidSizeValue: Decimal,
    timestamp?: Date | number
  ): Result<Quote, InvalidPriceError | InvalidQuantityError | InvalidQuoteError> {
    return QuoteService.create(
      bidValue,
      null,
      bidSizeValue,
      Quantity.ZERO.value(),
      timestamp
    );
  }

  /**
   * Создаёт одностороннюю ask котировку
   *
   * @param askValue - Значение ask
   * @param askSizeValue - Значение ask size
   * @param timestamp - Временная метка (опционально)
   * @returns Result с Quote или ошибкой
   *
   * @example
   * ```typescript
   * const result = QuoteService.askOnly(new Decimal(0.51), new Decimal(200));
   * ```
   */
  public static askOnly(
    askValue: Decimal,
    askSizeValue: Decimal,
    timestamp?: Date | number
  ): Result<Quote, InvalidPriceError | InvalidQuantityError | InvalidQuoteError> {
    return QuoteService.create(
      null,
      askValue,
      Quantity.ZERO.value(),
      askSizeValue,
      timestamp
    );
  }

  /**
   * Сдвигает котировку на указанную величину
   *
   * Shift - это параллельный сдвиг bid и ask на одинаковую величину.
   * Spread остаётся неизменным.
   *
   * @param quote - Исходная котировка
   * @param shiftAmount - Величина сдвига (может быть отрицательной)
   * @returns Result с новой Quote или ошибкой
   *
   * @example
   * ```typescript
   * // Сдвиг вверх на 0.01
   * const result = QuoteService.shift(quote, new Decimal(0.01));
   *
   * // Сдвиг вниз
   * const result = QuoteService.shift(quote, new Decimal(-0.01));
   * ```
   */
  public static shift(
    quote: Quote,
    shiftAmount: Decimal
  ): Result<Quote, InvalidPriceError | InvalidQuoteError> {
    let newBid: Price | null = null;
    if (quote.bid() !== null) {
      const newBidValue = quote.bid()!.value().plus(shiftAmount);
      try {
        newBid = Price.of(newBidValue);
      } catch (error) {
        return Err(
          new InvalidPriceError(
            `Invalid bid after shift: ${error.message}`,
            { value: newBidValue.toNumber(), shift: shiftAmount.toNumber() }
          )
        );
      }
    }

    let newAsk: Price | null = null;
    if (quote.ask() !== null) {
      const newAskValue = quote.ask()!.value().plus(shiftAmount);
      try {
        newAsk = Price.of(newAskValue);
      } catch (error) {
        return Err(
          new InvalidPriceError(
            `Invalid ask after shift: ${error.message}`,
            { value: newAskValue.toNumber(), shift: shiftAmount.toNumber() }
          )
        );
      }
    }

    try {
      return Ok(
        Quote.of(
          newBid,
          newAsk,
          quote.bidSize(),
          quote.askSize(),
          Date.now()
        )
      );
    } catch (error) {
      return Err(
        new InvalidQuoteError(
          `Failed to shift quote: ${error.message}`,
          {}
        )
      );
    }
  }

  /**
   * Применяет skew к котировке
   *
   * Skew - это асимметричное изменение bid и ask.
   * Позволяет наклонить котировку в одну сторону.
   *
   * @param quote - Исходная котировка
   * @param bidAdjustment - Adjustment для bid
   * @param askAdjustment - Adjustment для ask
   * @returns Result с новой Quote или ошибкой
   *
   * @example
   * ```typescript
   * // Сдвинуть bid вниз на 0.01, ask оставить
   * const result = QuoteService.skew(
   *   quote,
   *   new Decimal(-0.01),
   *   new Decimal(0)
   * );
   * ```
   */
  public static skew(
    quote: Quote,
    bidAdjustment: Decimal,
    askAdjustment: Decimal
  ): Result<Quote, InvalidPriceError | InvalidQuoteError> {
    let newBid: Price | null = null;
    if (quote.bid() !== null) {
      const newBidValue = quote.bid()!.value().plus(bidAdjustment);
      try {
        newBid = Price.of(newBidValue);
      } catch (error) {
        return Err(
          new InvalidPriceError(
            `Invalid bid after skew: ${error.message}`,
            { value: newBidValue.toNumber(), adjustment: bidAdjustment.toNumber() }
          )
        );
      }
    }

    let newAsk: Price | null = null;
    if (quote.ask() !== null) {
      const newAskValue = quote.ask()!.value().plus(askAdjustment);
      try {
        newAsk = Price.of(newAskValue);
      } catch (error) {
        return Err(
          new InvalidPriceError(
            `Invalid ask after skew: ${error.message}`,
            { value: newAskValue.toNumber(), adjustment: askAdjustment.toNumber() }
          )
        );
      }
    }

    try {
      return Ok(
        Quote.of(
          newBid,
          newAsk,
          quote.bidSize(),
          quote.askSize(),
          Date.now()
        )
      );
    } catch (error) {
      return Err(
        new InvalidQuoteError(
          `Failed to skew quote: ${error.message}`,
          {}
        )
      );
    }
  }

  /**
   * Обновляет размеры котировки
   *
   * @param quote - Исходная котировка
   * @param newBidSize - Новый bid size
   * @param newAskSize - Новый ask size
   * @returns Result с новой Quote или ошибкой
   *
   * @example
   * ```typescript
   * const result = QuoteService.updateSizes(
   *   quote,
   *   Quantity.of(new Decimal(200)),
   *   Quantity.of(new Decimal(300))
   * );
   * ```
   */
  public static updateSizes(
    quote: Quote,
    newBidSize: Quantity,
    newAskSize: Quantity
  ): Result<Quote, InvalidQuoteError> {
    try {
      return Ok(
        Quote.of(
          quote.bid(),
          quote.ask(),
          newBidSize,
          newAskSize,
          Date.now()
        )
      );
    } catch (error) {
      return Err(
        new InvalidQuoteError(
          `Failed to update sizes: ${error.message}`,
          {}
        )
      );
    }
  }

  /**
   * Получает spread width или 0 если односторонняя котировка
   *
   * @param quote - Котировка
   * @returns Decimal со значением spread
   *
   * @example
   * ```typescript
   * const spread = QuoteService.getSpreadOrZero(quote);
   * console.log(`Spread: ${spread.toString()}`);
   * ```
   */
  public static getSpreadOrZero(quote: Quote): Decimal {
    const spread = quote.spreadWidth();
    return spread ?? new Decimal(0);
  }

  /**
   * Получает mid price или null если односторонняя котировка
   *
   * @param quote - Котировка
   * @returns Price mid или null
   *
   * @example
   * ```typescript
   * const mid = QuoteService.getMidOrNull(quote);
   * if (mid !== null) {
   *   console.log(`Mid: ${mid.value()}`);
   * }
   * ```
   */
  public static getMidOrNull(quote: Quote): Price | null {
    return quote.midPrice();
  }
}
```

---

#### Adapters Layer

**QuoteSerializer.ts:**
```typescript
import { Quote } from '../core/Quote.js';
import { Price } from '../core/Price.js';
import { Quantity } from '../core/Quantity.js';
import { Decimal } from '@polymarket/math';

/**
 * Интерфейс для JSON представления Quote
 */
export interface QuoteJSON {
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  timestamp: number;
}

/**
 * Serializer для Quote
 *
 * @remarks
 * Конвертирует Quote в/из JSON представления
 *
 * @example
 * ```typescript
 * const json = QuoteSerializer.toJSON(quote);
 * const quote = QuoteSerializer.fromJSON(json);
 * ```
 */
export class QuoteSerializer {
  /**
   * Конвертирует Quote в JSON
   *
   * @param quote - Quote объект
   * @returns JSON представление
   *
   * @example
   * ```typescript
   * const json = QuoteSerializer.toJSON(quote);
   * // { bid: 0.50, ask: 0.51, bidSize: 100, askSize: 200, timestamp: 1234567890 }
   * ```
   */
  public static toJSON(quote: Quote): QuoteJSON {
    return {
      bid: quote.bid() !== null ? quote.bid()!.value().toNumber() : null,
      ask: quote.ask() !== null ? quote.ask()!.value().toNumber() : null,
      bidSize: quote.bidSize().value().toNumber(),
      askSize: quote.askSize().value().toNumber(),
      timestamp: quote.timestampMs()
    };
  }

  /**
   * Создаёт Quote из JSON
   *
   * @param json - JSON представление
   * @returns Quote объект
   * @throws {QuoteInvariantViolation} Если JSON невалиден
   *
   * @example
   * ```typescript
   * const quote = QuoteSerializer.fromJSON({
   *   bid: 0.50,
   *   ask: 0.51,
   *   bidSize: 100,
   *   askSize: 200,
   *   timestamp: Date.now()
   * });
   * ```
   */
  public static fromJSON(json: QuoteJSON): Quote {
    const bid = json.bid !== null ? Price.of(new Decimal(json.bid)) : null;
    const ask = json.ask !== null ? Price.of(new Decimal(json.ask)) : null;
    const bidSize = Quantity.of(new Decimal(json.bidSize));
    const askSize = Quantity.of(new Decimal(json.askSize));

    return Quote.of(bid, ask, bidSize, askSize, json.timestamp);
  }
}
```

**QuoteFormatter.ts:**
```typescript
import { Quote } from '../core/Quote.js';

/**
 * Форматтер для Quote
 *
 * @remarks
 * Конвертирует Quote в человекочитаемые строки
 *
 * @example
 * ```typescript
 * const str = QuoteFormatter.toString(quote);
 * // "Quote[0.50 x 100 @ 0.51 x 200]"
 * ```
 */
export class QuoteFormatter {
  /**
   * Конвертирует Quote в строку
   *
   * @param quote - Quote объект
   * @returns Строковое представление
   *
   * @example
   * ```typescript
   * const str = QuoteFormatter.toString(quote);
   * console.log(str);
   * // "Quote[0.50 x 100 @ 0.51 x 200] (2024-01-28)"
   * ```
   */
  public static toString(quote: Quote): string {
    const bidStr = quote.bid() !== null
      ? `${quote.bid()!.value().toFixed(4)} x ${quote.bidSize().value().toFixed(0)}`
      : 'N/A';

    const askStr = quote.ask() !== null
      ? `${quote.ask()!.value().toFixed(4)} x ${quote.askSize().value().toFixed(0)}`
      : 'N/A';

    const date = new Date(quote.timestampMs()).toISOString().split('T')[0];

    return `Quote[${bidStr} @ ${askStr}] (${date})`;
  }

  /**
   * Форматирует Quote в market notation
   *
   * @param quote - Quote объект
   * @returns Строка в формате "bid/ask"
   *
   * @example
   * ```typescript
   * const str = QuoteFormatter.toMarketNotation(quote);
   * // "0.5000/0.5100"
   * ```
   */
  public static toMarketNotation(quote: Quote): string {
    const bidStr = quote.bid() !== null
      ? quote.bid()!.value().toFixed(4)
      : 'N/A';

    const askStr = quote.ask() !== null
      ? quote.ask()!.value().toFixed(4)
      : 'N/A';

    return `${bidStr}/${askStr}`;
  }

  /**
   * Форматирует Quote с spread информацией
   *
   * @param quote - Quote объект
   * @returns Строка с spread
   *
   * @example
   * ```typescript
   * const str = QuoteFormatter.toStringWithSpread(quote);
   * // "Quote[0.5000/0.5100] spread: 0.0100 (2.00%)"
   * ```
   */
  public static toStringWithSpread(quote: Quote): string {
    const marketNotation = QuoteFormatter.toMarketNotation(quote);

    const spreadWidth = quote.spreadWidth();
    const spreadPct = quote.spreadPercentage();

    if (spreadWidth === null || spreadPct === null) {
      return `Quote[${marketNotation}] (one-sided)`;
    }

    return `Quote[${marketNotation}] spread: ${spreadWidth.toFixed(4)} (${spreadPct.toFixed(2)}%)`;
  }
}
```

---

## Детальный план по фазам

| Фаза | Описание | Время |
|------|----------|-------|
| 0 | Подготовка структуры директорий | 10 мин |
| 1 | Core Layer (Quote class) | 40 мин |
| 2 | Rules Layer (5 rules) | 45 мин |
| 3 | Policy Layer (2 policies) | 35 мин |
| 4 | Facade Layer (QuoteService) | 50 мин |
| 5 | Adapters Layer (Serializer, Formatter) | 20 мин |
| 6 | Index exports | 10 мин |
| 7 | Unit тесты | 60 мин |
| 8 | Integration тесты | 30 мин |
| 9 | Package.json exports | 5 мин |
| **Итого** | | **~4.5 часа** |

---

## План тестирования

### Unit тесты

**Core Layer (Quote.test.ts):**
- ✅ `of()` с валидными параметрами (two-sided)
- ✅ `of()` с валидными параметрами (bid-only)
- ✅ `of()` с валидными параметрами (ask-only)
- ✅ `of()` throw когда обе стороны null
- ✅ `of()` throw когда bid > ask
- ✅ `of()` throw когда bidSize < 0
- ✅ `of()` throw когда askSize < 0
- ✅ `isTwoSided()` возвращает true/false
- ✅ `hasBid()` и `hasAsk()` работают корректно
- ✅ `spreadWidth()` вычисляет правильно
- ✅ `spreadWidth()` возвращает null для one-sided
- ✅ `midPrice()` вычисляет правильно
- ✅ `midPrice()` возвращает null для one-sided
- ✅ `spreadPercentage()` вычисляет правильно
- ✅ `crossesMarket()` определяет crossing
- ✅ `crossesMarket()` возвращает false когда нет crossing
- ✅ `equals()` сравнивает корректно
- ✅ `getTimestamp()` возвращает новую копию Date
- ✅ Timestamp immutability (изменение Date не влияет на Quote)

**Итого Core:** ~20 тестов

**Rules Layer:**
- ValidateBidAsk: 4 теста
- ValidateQuoteSizes: 6 тестов
- ValidateMinSpread: 3 теста
- ValidateMaxSpread: 3 теста
- ValidateMarketCrossing: 6 тестов

**Итого Rules:** ~22 теста

**Policy Layer:**
- MarketMakingQuotePolicy: 8 тестов
- AggressiveQuotePolicy: 8 тестов

**Итого Policy:** ~16 тестов

**Facade Layer (QuoteService.test.ts):**
- `create()`: 6 тестов
- `fromNumbers()`: 4 теста
- `bidOnly()`: 3 теста
- `askOnly()`: 3 теста
- `shift()`: 6 тестов
- `skew()`: 6 тестов
- `updateSizes()`: 3 теста
- `getSpreadOrZero()`: 2 теста
- `getMidOrNull()`: 2 теста

**Итого Facade:** ~35 тестов

**Adapters Layer:**
- QuoteSerializer: 6 тестов
- QuoteFormatter: 6 тестов

**Итого Adapters:** ~12 тестов

### Integration тесты

**QuoteIntegration.test.ts:**
1. Полный флоу: create → shift → update sizes
2. Market making policy validation
3. Aggressive quote validation
4. Serialization round-trip
5. Formatting различных типов котировок
6. Market crossing detection
7. Spread calculation chain
8. One-sided quote operations

**Итого Integration:** ~15 тестов

### Итоговая статистика

| Слой | Unit | Integration |
|------|------|-------------|
| Core | 20 | - |
| Rules | 22 | - |
| Policy | 16 | - |
| Facade | 35 | - |
| Adapters | 12 | - |
| Integration | - | 15 |
| **ВСЕГО** | **105** | **15** |
| **TOTAL** | **120 тестов** | |

---

## Миграция

### API Changes

**До:**
```typescript
// Создание Quote
const quote = Quote.create(bid, ask, bidSize, askSize);

// Timestamp
const ts = quote.timestamp; // Date (мутабельный!)
ts.setFullYear(2050); // ❌ МУТАЦИЯ

// Serialization
const json = quote.toJSON();
const str = quote.toString();
```

**После:**
```typescript
// Создание Quote
const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());

// Timestamp
const tsMs = quote.timestampMs(); // number (immutable)
const ts = quote.getTimestamp(); // Date (новая копия каждый раз)

// Serialization (через Adapter)
const json = QuoteSerializer.toJSON(quote);
const str = QuoteFormatter.toString(quote);
```

### Breaking Changes

1. **Constructor → private**
   - Используйте `Quote.of()` вместо `new Quote()`

2. **timestamp: Date → timestampMs: number**
   - Используйте `quote.timestampMs()` для получения Unix ms
   - Используйте `quote.getTimestamp()` для получения Date объекта

3. **toJSON() → QuoteSerializer.toJSON()**
   - Переместили в Adapters layer

4. **toString() → QuoteFormatter.toString()**
   - Переместили в Adapters layer

5. **create() → of()**
   - Renamed для консистентности с другими VOs

---

## Примеры использования

### 1. Создание двусторонней котировки

```typescript
import { Quote, QuoteService } from '@polymarket/value-objects';
import { Price } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';
import { Decimal } from '@polymarket/math';

// Вариант 1: через Core
const bid = Price.of(new Decimal(0.48));
const ask = Price.of(new Decimal(0.52));
const bidSize = Quantity.of(new Decimal(100));
const askSize = Quantity.of(new Decimal(150));

const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());

console.log(quote.isTwoSided()); // true
console.log(quote.spreadWidth()?.toString()); // "0.04"

// Вариант 2: через Facade
const result = QuoteService.fromNumbers(0.48, 0.52, 100, 150);
if (result.ok) {
  const quote = result.value;
}
```

### 2. Односторонняя котировка

```typescript
// Bid-only quote
const bidOnlyResult = QuoteService.bidOnly(
  new Decimal(0.50),
  new Decimal(100)
);

if (bidOnlyResult.ok) {
  const quote = bidOnlyResult.value;
  console.log(quote.isTwoSided()); // false
  console.log(quote.hasBid()); // true
  console.log(quote.hasAsk()); // false
}

// Ask-only quote
const askOnlyResult = QuoteService.askOnly(
  new Decimal(0.51),
  new Decimal(200)
);
```

### 3. Market making validation

```typescript
import { MarketMakingQuotePolicy } from '@polymarket/value-objects';

const result = MarketMakingQuotePolicy.validateForMarketMaking(
  Price.of(new Decimal(0.49)),
  Price.of(new Decimal(0.51)),
  Quantity.of(new Decimal(100)),
  Quantity.of(new Decimal(100))
);

if (result.ok) {
  const quote = result.value;
  console.log('Valid market making quote');
} else {
  console.error(result.error.message);
  // "Spread 0.02 exceeds maximum 0.05"
}
```

### 4. Shift и skew операции

```typescript
// Shift - параллельный сдвиг
const shiftResult = QuoteService.shift(quote, new Decimal(0.01));
// bid: 0.48 → 0.49, ask: 0.52 → 0.53 (spread не изменился)

// Skew - асимметричное изменение
const skewResult = QuoteService.skew(
  quote,
  new Decimal(-0.01), // bid вниз
  new Decimal(0.01)   // ask вверх
);
// bid: 0.48 → 0.47, ask: 0.52 → 0.53 (spread расширился)
```

### 5. Market crossing detection

```typescript
const myQuote = Quote.of(
  Price.of(new Decimal(0.51)), // мой bid
  Price.of(new Decimal(0.52)), // мой ask
  Quantity.of(new Decimal(100)),
  Quantity.of(new Decimal(100)),
  Date.now()
);

const orderbookBid = Price.of(new Decimal(0.50));
const orderbookAsk = Price.of(new Decimal(0.51));

const crosses = myQuote.crossesMarket(orderbookBid, orderbookAsk);
console.log(crosses); // true (мой bid >= orderbook ask)
```

### 6. Serialization

```typescript
import { QuoteSerializer, QuoteFormatter } from '@polymarket/value-objects';

// JSON serialization
const json = QuoteSerializer.toJSON(quote);
console.log(json);
// { bid: 0.48, ask: 0.52, bidSize: 100, askSize: 150, timestamp: 1706468400000 }

// Deserialization
const restoredQuote = QuoteSerializer.fromJSON(json);

// Formatting
const str = QuoteFormatter.toString(quote);
console.log(str);
// "Quote[0.4800 x 100 @ 0.5200 x 150] (2024-01-28)"

const marketNotation = QuoteFormatter.toMarketNotation(quote);
console.log(marketNotation);
// "0.4800/0.5200"

const withSpread = QuoteFormatter.toStringWithSpread(quote);
console.log(withSpread);
// "Quote[0.4800/0.5200] spread: 0.0400 (8.33%)"
```

---

## Зависимости и интеграция

### Package Dependencies

```json
{
  "dependencies": {
    "@polymarket/math": "workspace:*",
    "@polymarket/errors": "workspace:*",
    "@polymarket/result": "workspace:*"
  }
}
```

### Package Exports

**packages/domain/value-objects/package.json:**
```json
{
  "exports": {
    "./Quote": {
      "import": "./dist/Quote/index.js",
      "types": "./dist/Quote/index.d.ts"
    },
    "./QuoteService": {
      "import": "./dist/Quote/facade/QuoteService.js",
      "types": "./dist/Quote/facade/QuoteService.d.ts"
    },
    "./QuoteSerializer": {
      "import": "./dist/Quote/adapters/QuoteSerializer.js",
      "types": "./dist/Quote/adapters/QuoteSerializer.d.ts"
    },
    "./QuoteFormatter": {
      "import": "./dist/Quote/adapters/QuoteFormatter.js",
      "types": "./dist/Quote/adapters/QuoteFormatter.d.ts"
    },
    "./MarketMakingQuotePolicy": {
      "import": "./dist/Quote/policy/MarketMakingQuotePolicy.js",
      "types": "./dist/Quote/policy/MarketMakingQuotePolicy.d.ts"
    }
  }
}
```

### Использование из других пакетов

```typescript
// В packages/application/trading-engine
import { Quote, QuoteService } from '@polymarket/value-objects/Quote';
import { MarketMakingQuotePolicy } from '@polymarket/value-objects/MarketMakingQuotePolicy';
import { QuoteSerializer } from '@polymarket/value-objects/QuoteSerializer';
```

---

## Дополнительные заметки

### Почему timestamp → timestampMs?

**Проблема Date mutability:**
```typescript
const quote = Quote.of(bid, ask, bidSize, askSize, new Date());
quote.timestamp.setFullYear(2050); // ❌ МУТАЦИЯ!
```

**Решение:**
- Хранить как `number` (Unix ms)
- Getter `getTimestamp()` возвращает `new Date(timestampMs)` - новую копию
- Immutability гарантирована

### Почему nullable bid/ask?

**Реальность рынков:**
- One-sided markets распространены (только bid или только ask)
- Market maker может временно убрать одну сторону
- Важно поддерживать partial liquidity

**Альтернативы (отвергнуты):**
- Использовать Price.ZERO - неявно, создаёт ложные данные
- Два отдельных класса (BidQuote, AskQuote) - избыточно

### Почему serialization в Adapters?

**Разделение concerns:**
- Core layer - бизнес-логика и инварианты
- Adapters layer - technical concerns (JSON, string formatting)

**Преимущества:**
- Core остаётся чистым (нет зависимости от JSON libraries)
- Легко добавить другие форматы (XML, Protobuf)
- Тестировать проще (Core не зависит от serialization)

---

**Конец детального плана для Quote**
