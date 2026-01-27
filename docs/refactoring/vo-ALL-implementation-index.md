# Value Objects: Индекс планов рефакторинга

## Статус создания планов

| # | Value Object | Статус | Файл | Размер | Сложность |
|---|--------------|--------|------|--------|-----------|
| 1 | **Price** | ✅ Готов | [`vo-price-implementation.md`](./vo-price-implementation.md) | 492 lines | Medium |
| 2 | **Quantity** | 📝 Создать | `vo-quantity-implementation.md` | 659 lines | High |
| 3 | **Money** | 📝 Создать | `vo-money-implementation.md` | 888 lines | High |
| 4 | **Percentage** | 📝 Создать | `vo-percentage-implementation.md` | 936 lines | Medium |
| 5 | **Spread** | 📝 Создать | `vo-spread-implementation.md` | 719 lines | Medium |
| 6 | **Quote** | 📝 Создать | `vo-quote-implementation.md` | 633 lines | Medium |
| 7 | **Balance** | 📝 Создать | `vo-balance-implementation.md` | 565 lines | Medium |

---

## Краткая спецификация каждого VO

### 1. Price ✅
- **Диапазон:** `[0.0001, 0.9999]`
- **Tick Size:** `0.0001`
- **Операции:** complement, average, multiply, divide, округление
- **Правила:** ValidateTickSize, ValidateSpread
- **Политики:** MarketPricePolicy

---

### 2. Quantity (BASE UNIT)
- **Диапазон:** `>= 0` (non-negative)
- **MIN_SIZE:** `0.001` (minimum tradeable quantity)
- **Операции:** add, subtract, multiply, divide, округление
- **Правила:**
  - ValidateMinSize (qty >= minSize)
  - ValidateNonNegative (qty >= 0)
  - ValidateDivisor (divisor > 0, finite)
- **Политики:**
  - OrderQuantityPolicy (проверка для ордеров)
  - PositionQuantityPolicy (проверка для позиций)
- **Особенности:**
  - Самый базовый VO
  - Используется везде (ордера, позиции, портфель)
  - Требует поддержку FIFO для лотов

**Пример Core:**
```typescript
class Quantity {
  private constructor(private readonly v: Decimal) {
    if (!v.isFinite()) throw new QuantityInvariantViolation('must be finite');
    if (v.isNegative()) throw new QuantityInvariantViolation('cannot be negative');
  }

  public static of(value: Decimal): Quantity {
    return new Quantity(value);
  }

  public value(): Decimal { return this.v; }
  public equals(other: Quantity, epsilon: Decimal): boolean {
    return this.v.minus(other.v).abs().lessThan(epsilon);
  }
  public isZero(epsilon: Decimal): boolean {
    return this.v.abs().lessThan(epsilon);
  }
}
```

**Пример Rules:**
```typescript
class ValidateMinSize {
  public static check(quantity: Decimal, minSize: Decimal): Result<void, InvalidQuantityError> {
    if (quantity.lessThan(minSize)) {
      return Err(new InvalidQuantityError(`Quantity ${quantity} is less than minSize ${minSize}`));
    }
    return Ok(undefined);
  }
}
```

---

### 3. Money (CURRENCY-AWARE)
- **Диапазон:** любое число (может быть отрицательным для долгов)
- **Currency:** USD, USDC
- **Операции:** add, subtract, multiply, divide (с проверкой currency)
- **Правила:**
  - ValidateCurrency (currency совпадает при операциях)
  - ValidateAmount (amount finite)
  - ValidateNonNegative (для некоторых операций)
- **Политики:**
  - PaymentPolicy (проверка для платежей)
  - FeeCalculationPolicy (расчет комиссий)
- **Особенности:**
  - Два поля: amount + currency
  - Операции требуют совпадения currency
  - Используется для cash, fees, PnL

**Пример Core:**
```typescript
class Money {
  private constructor(
    private readonly amt: Decimal,
    private readonly cur: Currency
  ) {
    if (!amt.isFinite()) throw new MoneyInvariantViolation('amount must be finite');
  }

  public static of(amount: Decimal, currency: Currency): Money {
    return new Money(amount, currency);
  }

  public amount(): Decimal { return this.amt; }
  public currency(): Currency { return this.cur; }

  public equals(other: Money, epsilon: Decimal): boolean {
    return this.cur === other.cur &&
           this.amt.minus(other.amt).abs().lessThan(epsilon);
  }

  public hasSameCurrency(other: Money): boolean {
    return this.cur === other.cur;
  }
}
```

**Пример Rules:**
```typescript
class ValidateCurrency {
  public static check(money1: Money, money2: Money): Result<void, CurrencyMismatchError> {
    if (!money1.hasSameCurrency(money2)) {
      return Err(new CurrencyMismatchError(
        `Currency mismatch: ${money1.currency()} vs ${money2.currency()}`
      ));
    }
    return Ok(undefined);
  }
}
```

---

### 4. Percentage
- **Диапазон:** `[0, 100]`
- **Basis Points:** поддержка (1 bp = 0.01%)
- **Операции:** toFraction, fromFraction, multiply, divide
- **Правила:**
  - ValidateRange (0 <= pct <= 100)
  - ValidateBasisPoints (корректные bp)
- **Политики:**
  - FeePercentagePolicy (проверка для комиссий)
- **Особенности:**
  - Конвертация: percentage ↔ fraction ↔ basis points
  - 100% = 1.0 = 10000 bp

**Пример Core:**
```typescript
class Percentage {
  private static readonly MIN = new Decimal(0);
  private static readonly MAX = new Decimal(100);

  private constructor(private readonly v: Decimal) {
    if (v.lessThan(Percentage.MIN) || v.greaterThan(Percentage.MAX)) {
      throw new PercentageInvariantViolation('must be in [0, 100]');
    }
  }

  public toFraction(): Decimal {
    return this.v.dividedBy(100);
  }

  public toBasisPoints(): Decimal {
    return this.v.times(100);
  }
}
```

---

### 5. Spread
- **Диапазон:** `>= 0` (bid-ask spread)
- **Операции:** calculate from bid/ask, validate
- **Правила:**
  - ValidateMinSpread (spread >= минимум)
  - ValidateBidAsk (ask >= bid)
- **Политики:**
  - TradingSpreadPolicy (проверка для торговли)
- **Особенности:**
  - Вычисляется из Price
  - Используется для валидации quote

**Пример Core:**
```typescript
class Spread {
  private constructor(private readonly v: Decimal) {
    if (!v.isFinite()) throw new SpreadInvariantViolation('must be finite');
    if (v.isNegative()) throw new SpreadInvariantViolation('cannot be negative');
  }

  public static fromPrices(bid: Price, ask: Price): Spread {
    const spreadValue = ask.value().minus(bid.value());
    return new Spread(spreadValue);
  }

  public toPercentage(referencePrice: Price): Decimal {
    return this.v.dividedBy(referencePrice.value()).times(100);
  }
}
```

---

### 6. Quote
- **Поля:** bid (Price), ask (Price)
- **Операции:** calculateSpread, calculateMid, validate
- **Правила:**
  - ValidateBidAsk (ask >= bid)
  - ValidateMinSpread (spread валидный)
- **Политики:**
  - OrderBookQuotePolicy (проверка для order book)
- **Особенности:**
  - Композит из двух Price
  - Вычисляет spread и mid автоматически

**Пример Core:**
```typescript
class Quote {
  private constructor(
    private readonly bidPrice: Price,
    private readonly askPrice: Price
  ) {
    // Инвариант: ask >= bid
    if (askPrice.value().lessThan(bidPrice.value())) {
      throw new QuoteInvariantViolation('ask must be >= bid');
    }
  }

  public static of(bid: Price, ask: Price): Quote {
    return new Quote(bid, ask);
  }

  public bid(): Price { return this.bidPrice; }
  public ask(): Price { return this.askPrice; }

  public spread(): Decimal {
    return this.askPrice.value().minus(this.bidPrice.value());
  }

  public mid(): Decimal {
    return this.askPrice.value().plus(this.bidPrice.value()).dividedBy(2);
  }
}
```

---

### 7. Balance
- **Поля:** available (Money), reserved (Money)
- **Операции:** reserve, release, update
- **Правила:**
  - ValidateNonNegative (available >= 0)
  - ValidateReserved (reserved <= total)
- **Политики:**
  - CashManagementPolicy (управление кэшем)
- **Особенности:**
  - Трекинг available vs reserved cash
  - Используется в Portfolio

**Пример Core:**
```typescript
class Balance {
  private constructor(
    private readonly avail: Money,
    private readonly res: Money
  ) {
    // Инвариант: available >= 0
    if (avail.amount().isNegative()) {
      throw new BalanceInvariantViolation('available cannot be negative');
    }

    // Инвариант: reserved >= 0
    if (res.amount().isNegative()) {
      throw new BalanceInvariantViolation('reserved cannot be negative');
    }

    // Инвариант: same currency
    if (!avail.hasSameCurrency(res)) {
      throw new BalanceInvariantViolation('available and reserved must have same currency');
    }
  }

  public available(): Money { return this.avail; }
  public reserved(): Money { return this.res; }

  public total(): Money {
    // Используем MoneyService.add()
    return MoneyService.add(this.avail, this.res);
  }
}
```

---

## Общая структура для всех VOs

### Директории
```
packages/domain/value-objects/src/{vo}/
 ├─ core/              ← Core VO (инварианты)
 ├─ rules/             ← Атомарные правила
 ├─ policy/            ← Комбинации правил
 ├─ facade/            ← {VO}Service (главный API)
 ├─ adapters/          ← Serialization & Formatting
 └─ index.ts           ← Экспорты
```

### Слои ответственности

| Слой | Ответственность | Ошибки |
|------|-----------------|--------|
| **Core** | Инварианты существования | `throw` |
| **Math** | Чистая математика | `throw` (на NaN/Infinity/0) |
| **Rules** | Атомарные правила | `Result.Err` |
| **Policy** | Комбинации правил | `Result.Err` |
| **Facade** | Оркестрация | `Result.Err` |
| **Adapters** | Сериализация | `Result.Err` |

---

## Приоритет создания планов

### 🔴 Высокий приоритет (используются везде)
1. ✅ **Price** - готов
2. **Quantity** - базовый unit
3. **Money** - для cash/fees

### 🟡 Средний приоритет
4. **Percentage** - для комиссий
5. **Spread** - для торговли

### 🟢 Низкий приоритет (специфичные)
6. **Quote** - для order book
7. **Balance** - для Portfolio

---

## Следующие шаги

1. **Создать детальные планы:**
   - Quantity (базовый, ~4 часа работы)
   - Money (~3 часа)
   - Percentage (~2.5 часа)
   - Остальные по мере необходимости

2. **Для каждого плана включить:**
   - ✅ Полная спецификация (инварианты, правила, политики)
   - ✅ Детальный код для всех слоёв
   - ✅ План тестирования (unit + integration)
   - ✅ План документации
   - ✅ Миграционная стратегия
   - ✅ Timeline с оценками времени

3. **После создания планов:**
   - Разбить каждый на атомарные задачи (как для Math)
   - Создать task lists для отслеживания
   - Начать реализацию

---

## Общая статистика

| Метрика | Значение |
|---------|----------|
| **Всего VOs** | 7 |
| **Планов готово** | 1 (Price) |
| **Планов осталось** | 6 |
| **Общий размер кода** | ~5000 lines |
| **Ожидаемое время** | ~20-25 часов |
| **Ожидаемых тестов** | ~600+ |

---

**Примечание:** Этот индекс будет обновляться по мере создания планов.
