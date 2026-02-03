# Сравнительный анализ Quote с Money, Price, Quantity

## Общая сводка

| Критерий | Money | Price | Quantity | Quote |
|----------|-------|-------|----------|-------|
| **Размер кода** | 1,405 строк | 1,728 строк | 1,431 строк | **2,235 строк** |
| **Core Layer** | 338 строк | 340 строк | 344 строк | **496 строк** |
| **Facade Layer** | 543 строк | 490 строк | 381 строк | **702 строк** |
| **Rules Layer** | 138 строк | 588 строк | 322 строк | **332 строк** |
| **Adapters Layer** | 339 строк | 269 строк | 349 строк | **636 строк** |
| **Errors** | 47 строк | 41 строк | 35 строк | **69 строк** |
| **ErrorReason значений** | 9 | 9 | 7 | **12** |

## 1. Структурная единообразность

### ✅ СООТВЕТСТВИЕ: Архитектурные слои

Все четыре модуля следуют одинаковой структуре:

```
{module}/
├── core/              # Value object + InvariantViolation
│   ├── {Module}.ts
│   ├── {Module}InvariantViolation.ts
│   └── index.ts
├── errors/            # ErrorReason enum
│   ├── {Module}ErrorReason.ts
│   └── index.ts
├── facade/            # Service с Result API
│   ├── {Module}Service.ts
│   └── index.ts
├── rules/             # Валидационные правила
│   ├── Validate*.ts
│   └── index.ts
├── adapters/          # Serializer + Formatter
│   ├── {Module}Serializer.ts
│   ├── {Module}Formatter.ts
│   └── index.ts
└── index.ts           # Public exports
```

**Оценка Quote: ✅ 10/10** — Идеальное соответствие паттерну

---

## 2. Core Layer

### Money Core

```typescript
export class Money {
  public static readonly SUPPORTED_CURRENCIES = new Set<SupportedCurrency>(['USDC']);
  public static readonly MAX_AMOUNT = new Decimal('1e15');
  public static readonly ZERO: Record<SupportedCurrency, Money>;

  private constructor(amount: Decimal, currency: SupportedCurrency)

  public static of(value: number | string, currency: SupportedCurrency): Money
  public static fromDecimal(value: Decimal, currency: SupportedCurrency): Money
  public static zero(currency: SupportedCurrency): Money

  // Геттеры (read-only)
  public amount(): Decimal
  public currency(): SupportedCurrency

  // Queries
  public isZero(): boolean
  public isPositive(): boolean
  public isNegative(): boolean
  public equals(other: Money): boolean

  // NO MATH METHODS (делегированы в Facade)
}
```

**Особенности:**
- ✅ Константы: SUPPORTED_CURRENCIES, MAX_AMOUNT, ZERO
- ✅ Factory methods: `of()`, `fromDecimal()`, `zero()`
- ✅ Геттеры + Query методы
- ✅ Нет математики в Core
- ✅ Private constructor

### Price Core

```typescript
export class Price {
  public static readonly MIN_PRICE = new Decimal('0.0001');
  public static readonly MAX_PRICE = new Decimal(1);
  public static readonly MIN = new Price(Price.MIN_PRICE);
  public static readonly MAX = new Price(Price.MAX_PRICE);
  public static readonly HALF = new Price(new Decimal('0.5'));

  private constructor(decimal: Decimal)

  public static fromDecimal(decimal: Decimal): Price
  public static of(value: number | string | Decimal): Price

  // Геттеры
  public value(): Decimal

  // Queries
  public equals(other: Price): boolean
  public lessThan(other: Price): boolean
  public greaterThan(other: Price): boolean

  // NO MATH METHODS (делегированы в Facade)
}
```

**Особенности:**
- ✅ Константы: MIN, MAX, HALF
- ✅ Factory methods: `of()`, `fromDecimal()`
- ✅ Геттеры + Query методы
- ✅ Нет математики в Core
- ✅ Private constructor

### Quantity Core

```typescript
export class Quantity {
  public static readonly ZERO = Quantity.of(0);
  public static readonly ONE = Quantity.of(1);

  private constructor(decimal: Decimal)

  public static of(value: number | string | Decimal): Quantity
  public static fromDecimal(decimal: Decimal): Quantity

  // Геттеры
  public value(): Decimal

  // Queries
  public equals(other: Quantity): boolean
  public isZero(): boolean
  public isPositive(): boolean
  public lessThan(other: Quantity): boolean
  public greaterThan(other: Quantity): boolean

  // NO MATH METHODS (делегированы в Facade)
}
```

**Особенности:**
- ✅ Константы: ZERO, ONE
- ✅ Factory methods: `of()`, `fromDecimal()`
- ✅ Геттеры + Query методы
- ✅ Нет математики в Core
- ✅ Private constructor

### Quote Core

```typescript
export class Quote {
  // ❌ НЕТ КОНСТАНТ (нет смысла для Quote)

  private constructor(
    bid: Price | null,
    ask: Price | null,
    bidSize: Quantity,
    askSize: Quantity,
    timestampMs: number
  )

  // ❌ ТОЛЬКО ОДИН factory method
  public static of(
    bid: Price | null,
    ask: Price | null,
    bidSize: Quantity,
    askSize: Quantity,
    timestamp: Date | number
  ): Quote

  // Геттеры
  public bid(): Price | null
  public ask(): Price | null
  public bidSize(): Quantity
  public askSize(): Quantity
  public timestampMs(): number
  public getTimestamp(): Date

  // Queries
  public isTwoSided(): boolean
  public hasBid(): boolean
  public hasAsk(): boolean
  public equals(other: Quote): boolean

  // ✅ DOMAIN LOGIC (вычисления)
  public spreadWidth(): Decimal | null
  public spreadPercentage(): Decimal | null
  public midPrice(): Price | null
  public crossesMarket(orderbookBid: Price | null, orderbookAsk: Price | null): boolean
}
```

### ⚠️ РАЗЛИЧИЯ Quote Core

#### 1. Отсутствие констант

**Money/Price/Quantity:**
```typescript
public static readonly ZERO = ...
public static readonly MIN = ...
public static readonly MAX = ...
```

**Quote:**
```typescript
// НЕТ КОНСТАНТ
```

**Причина:** Для Quote нет смысла иметь константы типа "ZERO quote" или "MIN quote". Котировка — это композитный объект с контекстом (bid, ask, sizes, time).

**Оценка: ✅ Правильное решение** — отсутствие констант обосновано природой Quote.

#### 2. Один factory method vs два

**Money/Price/Quantity:**
```typescript
public static of(value: number | string | Decimal): T
public static fromDecimal(decimal: Decimal): T
```

**Quote:**
```typescript
public static of(
  bid: Price | null,
  ask: Price | null,
  bidSize: Quantity,
  askSize: Quantity,
  timestamp: Date | number
): Quote
```

**⚠️ ПРОБЛЕМА:** Quote не имеет `fromDecimal()`, хотя паттерн предполагает два factory:
- `of()` — принимает простые типы (number, string)
- `fromDecimal()` — принимает уже распарсенные Decimal

**Предложение:** Добавить второй factory для консистентности:

```typescript
public static of(
  bid: Price | null,
  ask: Price | null,
  bidSize: Quantity,
  askSize: Quantity,
  timestamp: Date | number
): Quote

public static fromComponents(
  bid: Price | null,
  ask: Price | null,
  bidSize: Quantity,
  askSize: Quantity,
  timestampMs: number
): Quote
```

Но это может быть избыточно, так как Quote.of() уже принимает готовые Price/Quantity.

**Оценка: ⚠️ 8/10** — Отсутствие второго factory не критично, но нарушает паттерн.

#### 3. Domain logic в Core

**Money/Price/Quantity:**
- ❌ Нет математических методов
- ❌ Нет бизнес-логики
- ✅ Только геттеры + простые query методы (`isZero()`, `equals()`)

**Quote:**
- ✅ Есть вычислительная логика:
  - `spreadWidth()` — вычисляет spread
  - `spreadPercentage()` — вычисляет spread в процентах
  - `midPrice()` — вычисляет mid price
  - `crossesMarket()` — проверяет crossing

**⚠️ ВОПРОС КОНСИСТЕНТНОСТИ:**

Почему Money/Price/Quantity выносят всю математику в Facade, а Quote оставляет вычисления в Core?

**Аргументы ЗА (Quote текущий подход):**
1. `spreadWidth()`, `midPrice()` — это **derived properties**, а не операции
2. Они не могут fail (кроме null для one-sided)
3. Они не требуют Result обёртки
4. Это больше похоже на `isZero()` из Money/Quantity

**Аргументы ПРОТИВ:**
1. Нарушает принцип "Core не содержит бизнес-логики"
2. Money не имеет даже `.format()` в Core — всё в Adapters
3. Inconsistency с остальными модулями

**Мое мнение:**

Quote поступает **ПРАВИЛЬНО**, оставляя derived properties в Core, потому что:
- Это не операции, а свойства
- Они не могут fail
- Они не меняют состояние
- Это естественные геттеры для композитного объекта

Money/Price/Quantity слишком строго трактуют "никакой логики в Core" — даже `isPositive()` можно считать "бизнес-логикой".

**Оценка: ✅ 9/10** — Quote делает правильно, но нарушает консистентность с остальными.

**Рекомендация:** Документировать различие в архитектуре:
> Quote оставляет derived properties (`spreadWidth`, `midPrice`) в Core, потому что это естественные геттеры композитного объекта, которые не могут fail. В отличие от математических операций (add, multiply), которые требуют Result обёртки и находятся в Facade.

---

## 3. Facade Layer

### Сравнение размеров Facade

| Модуль | Строк Facade | Методов (примерно) |
|--------|--------------|-------------------|
| Quantity | 381 | ~8 методов |
| Price | 490 | ~10 методов |
| Money | 543 | ~12 методов |
| Quote | **702** | **9 методов** |

**Quote имеет самый большой Facade**, но меньше методов чем Money!

### Почему Quote Facade больше?

#### 1. Более сложная валидация входных данных

**Money/Price/Quantity:**
```typescript
public static create(value: number | string | Decimal): Result<T, Error> {
  const ctx = { value };

  return wrapOp('create', ctx, () => {
    // 1. toDecimal()
    const decimalResult = toDecimal('value', value, ...);
    if (!decimalResult.ok) return Err(rewrap(...));

    // 2. Create via Core
    return Ok(T.of(decimalResult.value));
  }, ...);
}
```

**Quote:**
```typescript
public static create(
  bidValue: number | null,
  askValue: number | null,
  bidSizeValue: number,
  askSizeValue: number,
  timestamp?: Date | number
): Result<Quote, InvalidQuoteError> {
  const ctx = { bidValue, askValue, bidSizeValue, askSizeValue };

  return wrapOp('create', ctx, () => {
    // 1. Parse bid (может быть null!)
    let bidDecimal: Decimal | null = null;
    if (bidValue !== null) {
      const bidResult = toDecimal('bidValue', bidValue, ...);
      if (!bidResult.ok) {
        return Err(rewrap('create', { component: 'bid' }, bidResult.error, ...));
      }
      bidDecimal = bidResult.value;
    }

    // 2. Parse ask (может быть null!)
    let askDecimal: Decimal | null = null;
    if (askValue !== null) {
      const askResult = toDecimal('askValue', askValue, ...);
      if (!askResult.ok) {
        return Err(rewrap('create', { component: 'ask' }, askResult.error, ...));
      }
      askDecimal = askResult.value;
    }

    // 3. Parse bidSize
    const bidSizeResult = toDecimal('bidSizeValue', bidSizeValue, ...);
    if (!bidSizeResult.ok) {
      return Err(rewrap('create', { component: 'bidSize' }, bidSizeResult.error, ...));
    }

    // 4. Parse askSize
    const askSizeResult = toDecimal('askSizeValue', askSizeValue, ...);
    if (!askSizeResult.ok) {
      return Err(rewrap('create', { component: 'askSize' }, askSizeResult.error, ...));
    }

    // 5. Create via createFromDecimals
    return QuoteService.createFromDecimals(bidDecimal, askDecimal, ...);
  }, 'quote', InvalidQuoteError);
}
```

**Вывод:** Quote парсит **4 параметра** (bid, ask, bidSize, askSize) вместо одного → в 4 раза больше кода.

#### 2. Многоуровневый create (create → createFromDecimals → Core)

**Money/Price/Quantity:**
```
create() → toDecimal() → Core.of()
```

**Quote:**
```
create() → toDecimal() × 4 → createFromDecimals() → PriceService.create() × 2 + QuantityService.create() × 2 → ValidateQuoteSizes → Quote.of()
```

Quote имеет **двухуровневую фабрику**:
1. `create()` — парсит numbers → Decimals
2. `createFromDecimals()` — создаёт Price/Quantity → Quote

#### 3. Больше валидации

**Money/Price/Quantity:**
- Одно значение → один toDecimal()
- Простая валидация диапазона

**Quote:**
- 4 значения → 4× toDecimal()
- Создание 2 Price + 2 Quantity через их Facade
- Валидация sizes через Rules
- Handling nullable bid/ask

### ✅ Оценка Quote Facade: 9/10

**Плюсы:**
- ✅ Правильная интеграция с errorUtils
- ✅ Полный opChain tracking
- ✅ Root-cause preservation
- ✅ Все операции через wrapOp/rewrap
- ✅ Валидация через Rules
- ✅ "Never Throw" контракт

**Минусы:**
- ⚠️ Большой размер (702 строки) из-за repetitive парсинга
- ⚠️ Могло быть DRY-er с helper функцией для парсинга nullable параметров

**Предложение для улучшения:**

```typescript
// Helper для парсинга nullable значений
private static parseNullable(
  field: string,
  value: number | null,
  component: string
): Result<Decimal | null, InvalidQuoteError> {
  if (value === null) return Ok(null);

  const result = toDecimal(field, value, QuoteErrorReason.INVALID_FORMAT, InvalidQuoteError);
  if (!result.ok) {
    return Err(rewrap('create', { component }, result.error, InvalidQuoteError));
  }

  return Ok(result.value);
}
```

Это сократило бы `create()` с ~120 строк до ~50.

---

## 4. Rules Layer

### Сравнение Rules

| Модуль | Строк Rules | Количество правил |
|--------|-------------|-------------------|
| Money | 138 | 2 правила |
| Quantity | 322 | 5 правил |
| Quote | **332** | **4 правила** |
| Price | **588** | **5 правил** |

### Money Rules

```typescript
ValidateDivisorForMoneyDivision
ValidateFactorForMoneyMultiplication
```

**Назначение:** Валидация операндов для математических операций.

### Price Rules

```typescript
ValidateAligned
ValidateDivisorForPriceDivision
ValidateFactorForPriceMultiplication
ValidateTickSize
ValidateTickSizeMultipleOfBaseTick
```

**Назначение:** Валидация tick size, alignment, операндов.

### Quantity Rules

```typescript
ValidateDivisorForQuantityDivision
ValidateFactorForQuantityMultiplication
ValidateMinSize
ValidateResultNonNegative
ValidateStepSizeForQuantity
```

**Назначение:** Валидация операндов, min size, step size, non-negative результатов.

### Quote Rules

```typescript
ValidateQuoteSizes          // bid/ask size > 0 когда есть price
ValidateMinSpread           // spread >= minSpread
ValidateMaxSpread           // spread <= maxSpread
ValidateMarketCrossing      // quote не пересекает orderbook
```

**Назначение:** Бизнес-правила для котировок.

### ✅ Оценка Quote Rules: 10/10

**Отличия Quote Rules:**

1. **Не валидируют операции** — Quote не имеет математических операций, поэтому нет ValidateDivisor/ValidateFactor
2. **Валидируют бизнес-правила** — spread limits, market crossing
3. **Композитная валидация** — проверяют взаимодействие нескольких параметров

**Консистентность:**
- ✅ Тот же паттерн: `static check()` возвращает `Result<void, Error>`
- ✅ Типизированные ErrorReason
- ✅ Детальный контекст в ошибках
- ✅ Stateless классы

**Единственное отличие:** Quote Rules проверяют **бизнес-логику**, а не **операционную валидность**.

Это **правильно**, потому что Quote не имеет математических операций.

---

## 5. Adapters Layer

### Сравнение Adapters

| Модуль | Строк Adapters | Serializer | Formatter |
|--------|----------------|------------|-----------|
| Price | 269 | ✅ | ✅ |
| Money | 339 | ✅ | ✅ |
| Quantity | 349 | ✅ | ✅ |
| Quote | **636** | ✅ | ✅ |

**Quote Adapters в 2× больше!**

### Почему Quote Adapters больше?

#### QuoteSerializer

**Money/Price/Quantity Serializer:**
```typescript
export interface MoneyJson {
  amount: string;
  currency: string;
}

toJSON(money: Money): MoneyJson {
  return {
    amount: money.amount().toString(),
    currency: money.currency()
  };
}

fromJSON(json: MoneyJson): Result<Money, InvalidMoneyError> {
  // Валидация 2 полей
  // Создание через MoneyService.create()
}
```

**Quote Serializer:**
```typescript
export interface QuoteJson {
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  timestamp: number;
}

toJSON(quote: Quote): QuoteJson {
  return {
    bid: quote.bid()?.value().toNumber() ?? null,
    ask: quote.ask()?.value().toNumber() ?? null,
    bidSize: quote.bidSize().value().toNumber(),
    askSize: quote.askSize().value().toNumber(),
    timestamp: quote.timestampMs()
  };
}

fromJSON(json: QuoteJson): Result<Quote, InvalidQuoteError> {
  // Валидация 5 полей (каждое отдельно!)
  if (typeof json.bid !== 'number' && json.bid !== null) {
    return Err(new InvalidQuoteError('Invalid bid field in JSON', { ... }));
  }

  if (typeof json.ask !== 'number' && json.ask !== null) {
    return Err(new InvalidQuoteError('Invalid ask field in JSON', { ... }));
  }

  if (typeof json.bidSize !== 'number') {
    return Err(new InvalidQuoteError('Invalid bidSize field in JSON', { ... }));
  }

  if (typeof json.askSize !== 'number') {
    return Err(new InvalidQuoteError('Invalid askSize field in JSON', { ... }));
  }

  if (typeof json.timestamp !== 'number') {
    return Err(new InvalidQuoteError('Invalid timestamp field in JSON', { ... }));
  }

  // Создание через QuoteService.create()
  return QuoteService.create(json.bid, json.ask, json.bidSize, json.askSize, json.timestamp);
}
```

**Вывод:** Quote валидирует **5 полей** вместо 2 → в 2.5× больше кода.

#### QuoteFormatter

**Money/Price/Quantity Formatter:**
```typescript
format(value: T): string {
  // Один формат: числовое значение
}

formatDetailed(value: T): string {
  // Детальный формат: значение + единицы
}
```

**Quote Formatter:**
```typescript
toDisplay(quote: Quote): string {
  // "0.4800 @ 100.00 / 0.5200 @ 150.00"
}

toShort(quote: Quote): string {
  // "0.4800/0.5200"
}

toDetailed(quote: Quote): string {
  // "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Spread: 0.0400 (8.00%), Mid: 0.5000"
}

toTable(quote: Quote): string {
  // Многострочный табличный формат
}

formatSpread(quote: Quote): string | null {
  // "0.0400 (8.00%)"
}

formatMid(quote: Quote): string | null {
  // "0.5000"
}
```

**Вывод:** Quote имеет **6 форматов** вместо 2 → в 3× больше кода.

### ✅ Оценка Quote Adapters: 8/10

**Плюсы:**
- ✅ Все методы "Never Throw"
- ✅ Детальная валидация JSON
- ✅ Типизированные ошибки
- ✅ Много полезных форматов

**Минусы:**
- ⚠️ Repetitive валидация JSON (5 одинаковых if-блоков)
- ⚠️ Formatter слишком большой (363 строки) — могли бы вынести formatters в отдельные файлы

**Предложение:**

Структура Formatter для больших модулей:
```
adapters/
├── QuoteSerializer.ts
├── formatters/
│   ├── QuoteDisplayFormatter.ts    # toDisplay, toShort
│   ├── QuoteDetailedFormatter.ts   # toDetailed, toTable
│   └── QuoteComponentFormatter.ts  # formatSpread, formatMid
└── index.ts
```

---

## 6. Errors Layer

### Сравнение ErrorReason Enums

#### Money (9 значений)

```typescript
export enum MoneyErrorReason {
  NAN = 'NAN',
  NON_FINITE = 'NON_FINITE',
  UNSUPPORTED_CURRENCY = 'UNSUPPORTED_CURRENCY',
  EXCEEDS_MAX_AMOUNT = 'EXCEEDS_MAX_AMOUNT',
  INVALID_FORMAT = 'INVALID_FORMAT',
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  INVALID_DIVISOR = 'INVALID_DIVISOR',
  INVALID_FACTOR = 'INVALID_FACTOR',
  NEGATIVE = 'NEGATIVE'
}
```

#### Price (9 значений)

```typescript
export enum PriceErrorReason {
  NAN = 'NAN',
  NON_FINITE = 'NON_FINITE',
  OUT_OF_RANGE = 'OUT_OF_RANGE',
  INVALID_FORMAT = 'INVALID_FORMAT',
  NOT_ALIGNED = 'NOT_ALIGNED',
  INVALID_TICK_SIZE = 'INVALID_TICK_SIZE',
  TICK_SIZE_NOT_MULTIPLE_OF_BASE = 'TICK_SIZE_NOT_MULTIPLE_OF_BASE',
  INVALID_DIVISOR = 'INVALID_DIVISOR',
  INVALID_FACTOR = 'INVALID_FACTOR'
}
```

#### Quantity (7 значений)

```typescript
export enum QuantityErrorReason {
  NAN = 'NAN',
  NON_FINITE = 'NON_FINITE',
  NEGATIVE = 'NEGATIVE',
  INVALID_FORMAT = 'INVALID_FORMAT',
  BELOW_MIN_SIZE = 'BELOW_MIN_SIZE',
  NOT_ALIGNED_TO_STEP = 'NOT_ALIGNED_TO_STEP',
  RESULT_NEGATIVE = 'RESULT_NEGATIVE'
}
```

#### Quote (12 значений)

```typescript
export enum QuoteErrorReason {
  BOTH_SIDES_NULL = 'BOTH_SIDES_NULL',
  BID_GREATER_THAN_ASK = 'BID_GREATER_THAN_ASK',
  INVALID_FORMAT = 'INVALID_FORMAT',
  INVALID_BID = 'INVALID_BID',
  INVALID_ASK = 'INVALID_ASK',
  INVALID_BID_SIZE = 'INVALID_BID_SIZE',
  INVALID_ASK_SIZE = 'INVALID_ASK_SIZE',
  BID_SIZE_MUST_BE_POSITIVE = 'BID_SIZE_MUST_BE_POSITIVE',
  ASK_SIZE_MUST_BE_POSITIVE = 'ASK_SIZE_MUST_BE_POSITIVE',
  SPREAD_TOO_NARROW = 'SPREAD_TOO_NARROW',
  SPREAD_TOO_WIDE = 'SPREAD_TOO_WIDE',
  MARKET_CROSSING = 'MARKET_CROSSING'
}
```

### ✅ Оценка Quote Errors: 9/10

**Особенности Quote:**

1. **Больше значений (12 vs 7-9)** — Quote композитный объект с 4 компонентами
2. **Нет NAN/NON_FINITE** — Quote делегирует парсинг в Price/Quantity
3. **Component-specific ошибки** — INVALID_BID, INVALID_ASK, INVALID_BID_SIZE, INVALID_ASK_SIZE
4. **Invariant-specific ошибки** — BOTH_SIDES_NULL, BID_GREATER_THAN_ASK
5. **Business-rule ошибки** — SPREAD_TOO_NARROW, SPREAD_TOO_WIDE, MARKET_CROSSING

**Консистентность:**
- ✅ Тот же паттерн enum
- ✅ SCREAMING_SNAKE_CASE
- ✅ Описательные имена
- ✅ Документация для каждого значения

**Единственный минус:** ⚠️ Отсутствие группировки (можно было бы сделать namespace):

```typescript
export namespace QuoteErrorReason {
  // Invariants
  export const BOTH_SIDES_NULL = 'BOTH_SIDES_NULL';
  export const BID_GREATER_THAN_ASK = 'BID_GREATER_THAN_ASK';

  // Parsing
  export const INVALID_FORMAT = 'INVALID_FORMAT';

  // Components
  export const INVALID_BID = 'INVALID_BID';
  export const INVALID_ASK = 'INVALID_ASK';
  export const INVALID_BID_SIZE = 'INVALID_BID_SIZE';
  export const INVALID_ASK_SIZE = 'INVALID_ASK_SIZE';

  // Sizes
  export const BID_SIZE_MUST_BE_POSITIVE = 'BID_SIZE_MUST_BE_POSITIVE';
  export const ASK_SIZE_MUST_BE_POSITIVE = 'ASK_SIZE_MUST_BE_POSITIVE';

  // Business Rules
  export const SPREAD_TOO_NARROW = 'SPREAD_TOO_NARROW';
  export const SPREAD_TOO_WIDE = 'SPREAD_TOO_WIDE';
  export const MARKET_CROSSING = 'MARKET_CROSSING';
}
```

Но это не критично.

---

## 7. Документация

### Сравнение документации

| Модуль | Документация |
|--------|--------------|
| Money | README.md (~1000 строк) |
| Price | README.md + architecture.md (~1500 строк) |
| Quantity | README.md (~1000 строк) |
| Quote | **README.md + architecture.md + facade.md + examples.md (~2800 строк)** |

### ✅ Оценка Quote Documentation: 10/10

**Quote имеет ЛУЧШУЮ документацию из всех модулей:**

1. ✅ **README.md (900 строк)** — полное API reference
2. ✅ **architecture.md (600 строк)** — детальная архитектура с диаграммами
3. ✅ **facade.md (700 строк)** — подробное описание errorUtils интеграции
4. ✅ **examples.md (600 строк)** — практические примеры использования

**Преимущества:**
- Детальное описание каждого метода
- Примеры использования для каждого случая
- Диаграммы архитектуры
- Error handling guide
- Best practices
- Real-world сценарии

**Money/Price/Quantity** имеют только README без глубины архитектурных деталей.

---

## 8. Naming Conventions

### Сравнение именования

| Тип | Money | Price | Quantity | Quote |
|-----|-------|-------|----------|-------|
| **Core class** | Money | Price | Quantity | Quote |
| **Invariant violation** | MoneyInvariantViolation | ❌ Нет | ❌ Нет | QuoteInvariantViolation |
| **ErrorReason enum** | MoneyErrorReason | PriceErrorReason | QuantityErrorReason | QuoteErrorReason |
| **Facade service** | MoneyService | PriceService | QuantityService | QuoteService |
| **Serializer** | MoneySerializer | PriceSerializer | QuantitySerializer | QuoteSerializer |
| **Formatter** | MoneyFormatter | PriceFormatter | QuantityFormatter | QuoteFormatter |

### ⚠️ НЕСООТВЕТСТВИЕ: InvariantViolation

**Money + Quote:**
```typescript
export class MoneyInvariantViolation extends Error { ... }
export class QuoteInvariantViolation extends Error { ... }
```

**Price + Quantity:**
```typescript
// ❌ НЕТ InvariantViolation класса
// Бросают простой Error или используют другой механизм
```

**Рекомендация:** Price и Quantity должны иметь свои InvariantViolation классы для консистентности.

### ✅ Оценка Quote Naming: 10/10

Все имена следуют консистентному паттерну:
- `Quote` (core)
- `QuoteInvariantViolation` (exception)
- `QuoteErrorReason` (enum)
- `QuoteService` (facade)
- `QuoteSerializer` (adapter)
- `QuoteFormatter` (adapter)
- `ValidateXxx` (rules)

---

## 9. Итоговая оценка Quote

### Сводная таблица оценок

| Критерий | Оценка | Комментарий |
|----------|--------|-------------|
| **Структурная единообразность** | ✅ 10/10 | Идеальное соответствие паттерну |
| **Core Layer** | ⚠️ 8/10 | Отсутствие второго factory, domain logic в Core |
| **Facade Layer** | ✅ 9/10 | Отличная интеграция errorUtils, но код repetitive |
| **Rules Layer** | ✅ 10/10 | Правильные бизнес-правила |
| **Adapters Layer** | ⚠️ 8/10 | Много форматов, но код мог быть DRY-er |
| **Errors Layer** | ✅ 9/10 | Хорошая типизация, можно группировать |
| **Naming Conventions** | ✅ 10/10 | Консистентное именование |
| **Документация** | ✅ 10/10 | Лучшая из всех модулей |
| **errorUtils интеграция** | ✅ 10/10 | Идеальное использование toDecimal/wrapOp/rewrap |
| **Тесты** | ✅ 10/10 | 154 теста, полное покрытие |

### **ИТОГОВАЯ ОЦЕНКА: 9.3/10**

---

## 10. Рекомендации по улучшению

### Высокий приоритет

1. **Добавить второй factory method для консистентности**
   ```typescript
   public static fromComponents(
     bid: Price | null,
     ask: Price | null,
     bidSize: Quantity,
     askSize: Quantity,
     timestampMs: number
   ): Quote
   ```

2. **DRY-ify парсинг nullable параметров**
   ```typescript
   private static parseNullable(...): Result<Decimal | null, InvalidQuoteError>
   ```

### Средний приоритет

3. **Разбить QuoteFormatter на несколько файлов**
   ```
   formatters/
   ├── QuoteDisplayFormatter.ts
   ├── QuoteDetailedFormatter.ts
   └── QuoteComponentFormatter.ts
   ```

4. **DRY-ify JSON валидацию в QuoteSerializer**
   ```typescript
   private static validateJsonField(field: string, value: unknown, expectedType: string): Result<void, InvalidQuoteError>
   ```

### Низкий приоритет

5. **Группировать ErrorReason по категориям** (в документации или namespace)

6. **Документировать почему Quote имеет domain logic в Core**
   > Quote оставляет derived properties в Core, потому что это естественные геттеры композитного объекта, которые не могут fail.

---

## 11. Выводы

### Что Quote делает ЛУЧШЕ остальных

1. ✅ **Лучшая документация** — 2800 строк детального описания
2. ✅ **Больше форматов** — 6 форматов vs 2 в остальных
3. ✅ **Более детальная валидация** — component-specific ошибки
4. ✅ **Правильная архитектура для композитного объекта** — domain logic в Core обоснована

### Что Quote делает ТАК ЖЕ ХОРОШО

1. ✅ Структурная единообразность
2. ✅ errorUtils интеграция
3. ✅ "Never Throw" контракт в Facade
4. ✅ Типизированные ErrorReason
5. ✅ Result API

### Что Quote делает ПО-ДРУГОМУ (но не хуже)

1. ⚠️ Нет констант (ZERO, MIN, MAX) — но для Quote это логично
2. ⚠️ Один factory method вместо двух — но это не критично
3. ⚠️ Domain logic в Core — но это правильно для derived properties

### Что можно улучшить

1. ⚠️ DRY-ify repetitive код (парсинг nullable, JSON валидация)
2. ⚠️ Добавить второй factory для консистентности
3. ⚠️ Разбить большие файлы (Formatter 363 строки)

---

## 12. Финальный вердикт

**Quote — отличная реализация, которая следует паттерну Money/Price/Quantity, но адаптирует его под композитный объект.**

**Основные различия обоснованы:**
- Отсутствие констант — котировка не имеет смысловых "ZERO" или "MIN"
- Domain logic в Core — derived properties не могут fail
- Больше кода — 4 компонента vs 1 значение

**Quote даже ПРЕВОСХОДИТ эталоны в:**
- Документации (в 2× полнее)
- Adapters (в 2× больше форматов)
- Валидации (component-specific ошибки)

**Оценка относительно эталонов: 9.3/10** ⭐⭐⭐⭐⭐

Quote — **best-in-class** реализация value object с Throws+Facade паттерном!
