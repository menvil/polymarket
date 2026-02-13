# Анализ Quote Value Object

**Дата:** 2026-02-04
**Сравнение с эталонными VO:** Balance, Money, Price, Quantity

---

## 📊 Executive Summary

| Критерий | Оценка | Комментарий |
|----------|--------|-------------|
| **Архитектура** | ✅ Отлично | Четкое разделение слоёв Core/Facade/Rules/Adapters |
| **Error Handling** | ⚠️ Хорошо | Использует wrapOp, но есть inconsistency |
| **Immutability** | ✅ Отлично | Полная иммутабельность, private fields |
| **Тесты** | ✅ Отлично | 154 теста, хорошее покрытие |
| **Документация** | ⚠️ Средне | TSDoc хороший, но нет файлов в docs/quote/ |
| **Консистентность** | ⚠️ Проблемы | Отличия от паттернов Balance/Money |

**Общая оценка:** 7.5/10 - Хорошая реализация с несколькими архитектурными inconsistencies.

---

## ✅ Что сделано ХОРОШО

### 1. Архитектура слоёв - ОТЛИЧНО

```text
src/quote/
├── core/           ✅ Quote.ts + QuoteInvariantViolation
├── facade/         ✅ QuoteService.ts
├── rules/          ✅ 4 правила валидации
├── adapters/       ✅ Serializer + Formatter
├── errors/         ✅ QuoteErrorReason enum
└── index.ts        ✅ Exports
```

**Сравнение с Balance:**

- ✅ Идентичная структура директорий
- ✅ Четкое разделение ответственности
- ✅ Core не зависит от Facade

### 2. Core Layer - ОТЛИЧНО

#### Инварианты (Quote.ts)

```typescript
// ✅ ХОРОШО: Минимальные, чёткие инварианты
1. Хотя бы одна сторона определена (bid или ask)
2. bid <= ask (если оба определены)
3. sizes >= 0 (гарантирует Quantity)
```

**Сравнение с Balance:**

```typescript
// Balance инварианты:
1. available >= 0
2. reserved >= 0
3. Единая валюта

// Quote инварианты:
1. Хотя бы одна сторона (bid или ask)
2. bid <= ask
3. sizes >= 0
```

✅ **Оценка:** Оба VO имеют минимальные, необходимые инварианты.

#### Иммутабельность - ОТЛИЧНО

```typescript
// ✅ ХОРОШО: Private readonly поля
private constructor(
  private readonly b: Price | null,      // ✅
  private readonly a: Price | null,      // ✅
  private readonly bSize: Quantity,      // ✅
  private readonly aSize: Quantity,      // ✅
  private readonly tsMs: number          // ✅
) {}
```

**Сравнение с Balance:**

```typescript
// Balance - аналогично
private readonly _available: Money;  // ✅
private readonly _reserved: Money;   // ✅
```

✅ **Консистентность:** Оба используют `private readonly`.

**❌ ПРОБЛЕМА:** Naming inconsistency

- Balance: `_available`, `_reserved` (с underscore)
- Quote: `b`, `a`, `bSize`, `aSize` (без underscore, сокращения)

**Рекомендация:**

```typescript
// Должно быть (как в Balance):
private readonly _bid: Price | null;
private readonly _ask: Price | null;
private readonly _bidSize: Quantity;
private readonly _askSize: Quantity;
private readonly _timestampMs: number;
```

#### Query Methods - ОТЛИЧНО

```typescript
// ✅ ХОРОШО: Богатый API для queries
isTwoSided(): boolean
hasBid(): boolean
hasAsk(): boolean
spreadWidth(): Decimal | null
midPrice(): Price | null
spreadPercentage(): Decimal | null
crossesMarket(...)): boolean
equals(other: Quote): boolean
```

**Сравнение с Balance:**

```typescript
// Balance queries:
total(): Money
isZero(): boolean
hasReserved(): boolean
reservedPercentage(): Decimal
hasSameCurrency(other): boolean
```

✅ **Оценка:** Quote имеет более богатый набор query methods, что соответствует доменной сложности.

### 3. Facade Layer - ХОРОШО (с замечаниями)

#### ✅ ХОРОШО: Использование wrapOp

```typescript
public static create(...): Result<Quote, InvalidQuoteError> {
  return wrapOp('create', ctx, () => {
    // ... логика
  }, 'quote', InvalidQuoteError);
}
```

**Сравнение с Balance:**

```typescript
public static create(...): Result<Balance, InvalidBalanceError> {
  return wrapOp('create', ctx, () => {
    // ... логика
  }, 'balance', InvalidBalanceError);
}
```

✅ **Консистентность:** Оба используют wrapOp framework.

#### ⚠️ ПРОБЛЕМА: Inconsistent operation names

```typescript
// Quote:
createFromDecimals() - op: 'creates'  ❌ Почему 'creates' а не 'createFromDecimals'?
create() - op: 'create'               ✅ OK
bidOnly() - op: 'bidOnly'             ✅ OK
askOnly() - op: 'askOnly'             ✅ OK
shift() - op: 'shift'                 ✅ OK
skew() - op: 'skew'                   ✅ OK
updateSizes() - op: 'updateSizes'     ✅ OK
```

**Balance для сравнения:**

```typescript
// Balance - всегда op === method name
create() - op: 'create'                          ✅
reserve() - op: 'reserve'                        ✅
unfreezeReserved() - op: 'unfreezeReserved'      ✅
consumeReserved() - op: 'consumeReserved'        ✅
updateAvailable() - op: 'updateAvailable'        ✅
```

**Рекомендация:** Изменить `'creates'` → `'createFromDecimals'` для консистентности.

#### ⚠️ ПРОБЛЕМА: Дублирование error handling логики

```typescript
// В createFromDecimals() - ручная обработка каждого компонента:
const bidResult = PriceService.create(bidValue);
if (isErr(bidResult)) {
  return Err(rewrap('creates', { component: 'bid' },
    new InvalidQuoteError('Invalid bid price', {
      context: {
        reason: QuoteErrorReason.INVALID_BID,
        cause: bidResult.error
      }
    }),
    InvalidQuoteError
  ));
}
// ... repeat для ask, bidSize, askSize
```

**Balance для сравнения:**

```typescript
// Balance - helper методы для DRY:
private static subtractMoney(a: Money, b: Money): Result<Money, InvalidBalanceError> {
  const result = MoneyService.subtract(a, b);
  if (isErr(result)) {
    return Err(rewrap('subtractMoney', {}, result.error, InvalidBalanceError));
  }
  return Ok(result.value);
}
```

**Рекомендация:** Создать helper методы:

```typescript
private static createPrice(
  value: Decimal | null,
  field: 'bid' | 'ask',
  op: string
): Result<Price | null, InvalidQuoteError> {
  if (value === null) return Ok(null);

  const result = PriceService.create(value);
  if (isErr(result)) {
    const reason = field === 'bid'
      ? QuoteErrorReason.INVALID_BID
      : QuoteErrorReason.INVALID_ASK;
    return Err(rewrap(op, { component: field },
      new InvalidQuoteError(`Invalid ${field} price`, {
        context: { reason, cause: result.error }
      }), InvalidQuoteError));
  }
  return Ok(result.value);
}
```

#### ⚠️ ПРОБЛЕМА: Timestamp handling inconsistency

```typescript
// В методах shift/skew/updateSizes:
timestamp: Date.now()  // ❌ Всегда новый timestamp

// Но в create/createFromDecimals:
timestamp?: Date | number  // ✅ Опциональный, можно передать свой
```

**Вопрос:** Почему shift/skew/updateSizes не принимают timestamp как параметр?

**Сравнение с Balance:**
Balance не имеет timestamp, поэтому проблемы нет.

**Рекомендация:** Либо везде принимать опциональный timestamp, либо везде использовать Date.now().

### 4. Rules Layer - ОТЛИЧНО

```text
rules/
├── ValidateMarketCrossing.ts  ✅ Проверка пересечения с рынком
├── ValidateMaxSpread.ts       ✅ Максимальный spread
├── ValidateMinSpread.ts       ✅ Минимальный spread
└── ValidateQuoteSizes.ts      ✅ Позитивность размеров
```

**Сравнение с Balance:**

```text
rules/
├── ValidateCurrencyMatch.ts   ✅ Совпадение валют
├── ValidateReleaseAmount.ts   ✅ Валидация суммы освобождения
└── ValidateReserveAmount.ts   ✅ Валидация суммы резервирования
```

✅ **Оценка:** Оба VO имеют чистые, изолированные Rules без побочных эффектов.

#### ✅ ХОРОШО: Структура Rule

```typescript
export class ValidateMinSpread {
  public static check(
    quote: Quote,
    minSpread: Decimal
  ): Result<void, InvalidQuoteError> {
    // ... validation logic
  }
}
```

**Идентично Balance:**

```typescript
export class ValidateReserveAmount {
  public static check(
    amount: Money,
    available: Money
  ): Result<void, InvalidBalanceError> {
    // ... validation logic
  }
}
```

✅ **Консистентность:** Одинаковая структура Rules.

### 5. Adapters Layer - ОТЛИЧНО

#### QuoteSerializer - хорошая реализация

```typescript
toJSON(quote: Quote): QuoteJSON {
  return {
    bid: quote.bid()?.value().toString() ?? null,
    ask: quote.ask()?.value().toString() ?? null,
    bidSize: quote.bidSize().value().toString(),
    askSize: quote.askSize().value().toString(),
    timestamp: quote.timestampMs()
  };
}
```

✅ **ХОРОШО:**

- Использует `.toString()` для Decimal (сохранение точности)
- Обрабатывает nullable bid/ask
- Timestamp как number (Unix ms)

**Сравнение с BalanceSerializer:**

```typescript
toJSON(balance: Balance): BalanceJSON {
  return {
    available: MoneySerializer.toJSON(balance.available()),
    reserved: MoneySerializer.toJSON(balance.reserved())
  };
}
```

✅ **Консистентность:** Оба используют string для Decimal значений.

#### QuoteFormatter - хорошая реализация

```typescript
format(quote: Quote): string {
  const bid = quote.bid();
  const ask = quote.ask();

  if (bid && ask) {
    return `${bid.value().toFixed(4)} / ${ask.value().toFixed(4)}`;
  }
  // ... one-sided logic
}
```

✅ **ХОРОШО:** Понятный формат для двусторонних и односторонних котировок.

### 6. Error Handling - ХОРОШО

#### QuoteErrorReason - полный набор

```typescript
enum QuoteErrorReason {
  // Core инварианты
  BOTH_SIDES_NULL
  BID_GREATER_THAN_ASK

  // Парсинг
  INVALID_FORMAT

  // Компоненты
  INVALID_BID
  INVALID_ASK
  INVALID_BID_SIZE
  INVALID_ASK_SIZE

  // Бизнес-правила
  BID_SIZE_MUST_BE_POSITIVE
  ASK_SIZE_MUST_BE_POSITIVE
  SPREAD_TOO_NARROW
  SPREAD_TOO_WIDE
  MARKET_CROSSING
}
```

**Сравнение с BalanceErrorReason:**

```typescript
enum BalanceErrorReason {
  NEGATIVE_AVAILABLE
  NEGATIVE_RESERVED
  INSUFFICIENT_FUNDS
  INSUFFICIENT_RESERVED
  CURRENCY_MISMATCH
  INVALID_FORMAT
}
```

✅ **Оценка:** Quote имеет более детальную типизацию ошибок, что соответствует сложности домена.

### 7. Тесты - ОТЛИЧНО

```text
154 тестов passed
8 test файлов

__tests__/unit/quote/
├── Quote.test.ts                   ✅ Core layer
├── QuoteService.test.ts            ✅ Facade layer
├── QuoteSerializer.test.ts         ✅ Adapter
├── QuoteFormatter.test.ts          ✅ Adapter
├── ValidateMarketCrossing.test.ts  ✅ Rule
├── ValidateMaxSpread.test.ts       ✅ Rule
├── ValidateMinSpread.test.ts       ✅ Rule
└── ValidateQuoteSizes.test.ts      ✅ Rule
```

**Сравнение с Balance:**

```text
141 тестов passed
8 test файлов (7 unit + 1 integration)
```

✅ **Консистентность:** Похожая структура и покрытие.

**❌ ПРОБЛЕМА:** Отсутствует integration test для Quote.

**Рекомендация:** Добавить `QuoteWorkflow.integration.test.ts` с реальными сценариями.

---

## ⚠️ Что сделано НЕ ОЧЕНЬ / Проблемы

### 1. Naming Inconsistency - ПРОБЛЕМА

| Аспект | Balance | Quote | Консистентность |
|--------|---------|-------|-----------------|
| Private fields | `_available`, `_reserved` | `b`, `a`, `bSize`, `aSize` | ❌ Разные стили |
| Operation names | method name === op | `'creates'` vs `'createFromDecimals'` | ❌ Inconsistent |
| Helper methods | `subtractMoney()`, `addMoney()` | Нет helpers | ❌ Дублирование |

**Рекомендации:**

1. **Переименовать private fields:**

```typescript
// Было:
private readonly b: Price | null;
private readonly a: Price | null;
private readonly bSize: Quantity;
private readonly aSize: Quantity;
private readonly tsMs: number;

// Должно быть (как Balance):
private readonly _bid: Price | null;
private readonly _ask: Price | null;
private readonly _bidSize: Quantity;
private readonly _askSize: Quantity;
private readonly _timestampMs: number;
```

1. **Исправить operation name:**

```typescript
// Было:
return wrapOp('creates', ctx, () => { ... }

// Должно быть:
return wrapOp('createFromDecimals', ctx, () => { ... }
```

1. **Добавить helper methods:**

```typescript
private static createPrice(value: Decimal | null, field: 'bid' | 'ask', op: string)
private static createQuantity(value: Decimal, field: 'bidSize' | 'askSize', op: string)
```

### 2. Timestamp Handling - ПРОБЛЕМА

```typescript
// create/createFromDecimals:
timestamp?: Date | number  // ✅ Можно передать свой

// shift/skew/updateSizes:
timestamp: Date.now()      // ❌ Всегда новый
```

**Вопросы:**

1. Почему shift/skew не принимают timestamp?
2. Нужен ли timestamp вообще в Quote? (Price, Money, Quantity его не имеют)
3. Если нужен - должен ли он обновляться при операциях?

**Рекомендации:**

**Вариант A:** Timestamp - часть state, обновляется при операциях

```typescript
public static shift(
  quote: Quote,
  shiftAmount: Decimal,
  timestamp?: Date | number  // ✅ Опциональный
): Result<Quote, InvalidQuoteError> {
  const ts = timestamp ?? Date.now();
  // ...
}
```

**Вариант B:** Timestamp - read-only, не изменяется

```typescript
// shift/skew/updateSizes сохраняют оригинальный timestamp:
return QuoteService.createFromDecimals(
  newBidDecimal,
  newAskDecimal,
  quote.bidSize().value(),
  quote.askSize().value(),
  quote.timestampMs()  // ✅ Сохраняем оригинальный
);
```

**Вариант C:** Удалить timestamp из Quote

- Price, Money, Quantity не имеют timestamp
- Timestamp можно хранить на уровень выше (в QuoteBook, QuoteHistory)

**Рекомендуемый вариант:** **B** - сохранять оригинальный timestamp при операциях, если пользователь не передал новый явно.

### 3. Отсутствие документации - ПРОБЛЕМА

```bash
$ ls docs/quote/
# Пусто! ❌
```

**Balance для сравнения:**

```bash
$ ls docs/balance/
README.md           ✅
architecture.md     ✅
examples.md         ✅
facade.md           ✅
```

**Рекомендация:** Создать полную документацию:

- `docs/quote/README.md` - обзор и quick start
- `docs/quote/architecture.md` - архитектурные решения
- `docs/quote/facade.md` - API reference
- `docs/quote/examples.md` - примеры использования
- `docs/quote/core.md` - детали Core layer (опционально)

### 4. Отсутствие Integration тестов - ПРОБЛЕМА

Balance имеет:

```text
__tests__/integration/balance/
└── BalanceWorkflow.integration.test.ts  ✅ 24 теста
```

Quote не имеет integration тестов! ❌

**Рекомендация:** Добавить `QuoteWorkflow.integration.test.ts`:

```typescript
describe('Quote Integration Tests', () => {
  describe('Market making workflow', () => {
    it('создание → shift → skew → update sizes', () => {
      // ... реалистичный сценарий
    });
  });

  describe('Serialization round-trip', () => {
    it('toJSON → fromJSON сохраняет quote', () => {
      // ...
    });
  });

  describe('Rules integration', () => {
    it('validateMinSpread + validateMaxSpread + validateMarketCrossing', () => {
      // ...
    });
  });
});
```

### 5. Rules не интегрированы в QuoteService - ВОПРОС

```typescript
// QuoteService НЕ вызывает Rules автоматически
const quote = QuoteService.create(0.48, 0.52, 100, 150);
// ✅ OK - даже если spread нарушает min/max

// Пользователь должен вызывать Rules вручную:
const spreadCheck = ValidateMinSpread.check(quote.value, minSpread);
```

**Сравнение с Balance:**

```typescript
// BalanceService ИСПОЛЬЗУЕТ Rules внутри:
public static reserve(balance: Balance, amount: Money) {
  return wrapOp('reserve', ctx, () => {
    // Валидация через Rule
    const currencyCheck = ValidateCurrencyMatch.check(amount, balance.currency());
    if (isErr(currencyCheck)) return Err(rewrap(...));

    const reserveCheck = ValidateReserveAmount.check(amount, balance.available());
    if (isErr(reserveCheck)) return Err(rewrap(...));

    // ... создание
  });
}
```

**Вопрос:** Должен ли QuoteService вызывать Rules автоматически в create()?

**Варианты:**

**A. Не вызывать (текущая реализация)**

- ✅ Гибкость - пользователь решает какие правила применять
- ❌ Можно создать невалидные Quote (spread нарушает min/max)

**B. Вызывать опционально**

```typescript
public static create(
  bidValue: number | null,
  askValue: number | null,
  bidSizeValue: number,
  askSizeValue: number,
  options?: {
    minSpread?: Decimal;
    maxSpread?: Decimal;
    orderbookBid?: Price;
    orderbookAsk?: Price;
  }
): Result<Quote, InvalidQuoteError>
```

**C. Создать отдельный validated метод**

```typescript
public static createValidated(
  bidValue: number | null,
  askValue: number | null,
  bidSizeValue: number,
  askSizeValue: number,
  constraints: QuoteConstraints
): Result<Quote, InvalidQuoteError> {
  // create + validate все Rules
}
```

**Рекомендация:** Вариант **C** - добавить `createValidated()` для строгой валидации, оставив `create()` без Rules для гибкости.

---

## 🔍 Детальные архитектурные различия

### Quote vs Balance: Композиция VO

**Quote:**

```typescript
class Quote {
  private readonly b: Price | null;        // VO композиция
  private readonly a: Price | null;        // VO композиция
  private readonly bSize: Quantity;        // VO композиция
  private readonly aSize: Quantity;        // VO композиция
  private readonly tsMs: number;           // primitive
}
```

**Balance:**

```typescript
class Balance {
  private readonly _available: Money;      // VO композиция
  private readonly _reserved: Money;       // VO композиция
}
```

✅ **Оценка:** Оба правильно используют композицию VO, не примитивы.

### Quote vs Price/Quantity: Nullable fields

**Quote:**

```typescript
private readonly b: Price | null;  // ✅ Nullable для one-sided quotes
private readonly a: Price | null;  // ✅ Nullable для one-sided quotes
```

**Price/Money/Quantity:**

```typescript
private readonly _value: Decimal;  // ❌ Не nullable
```

✅ **Оценка:** Quote правильно использует nullable для опциональных сторон.

**Но:** Это создаёт сложность в API:

```typescript
quote.bid()?.value().toString() ?? null  // Need ?. operator
quote.bidSize().value().toString()       // No ?. needed
```

**Альтернативный дизайн (не рекомендуется):**

```typescript
// Вместо null использовать ZERO constants
private readonly b: Price;  // Price.ZERO если нет bid
private readonly a: Price;  // Price.ZERO если нет ask

// Тогда:
quote.isTwoSided() {
  return !this.b.equals(Price.ZERO) && !this.a.equals(Price.ZERO);
}
```

**Вывод:** Nullable правильно отражает семантику "отсутствия" стороны.

---

## 📝 Рекомендации по приоритетам

### 🔴 Высокий приоритет (архитектурная консистентность)

1. **Переименовать private fields** (`b` → `_bid`, etc.)
   - Влияние: консистентность с Balance/Money/Price/Quantity
   - Усилия: низкие (find & replace)
   - Breaking change: нет (private fields)

2. **Исправить operation name** (`'creates'` → `'createFromDecimals'`)
   - Влияние: консистентность error context
   - Усилия: низкие
   - Breaking change: да (error.context.op)

3. **Добавить helper methods** для DRY
   - Влияние: читаемость, maintainability
   - Усилия: средние
   - Breaking change: нет

### 🟡 Средний приоритет (улучшение качества)

1. **Добавить документацию** (docs/quote/)
   - Влияние: onboarding, понимание API
   - Усилия: средние
   - Breaking change: нет

2. **Добавить integration тесты**
   - Влияние: confidence в real-world scenarios
   - Усилия: средние
   - Breaking change: нет

3. **Решить вопрос с timestamp**
   - Влияние: API clarity
   - Усилия: низкие
   - Breaking change: да (API методов)

### 🟢 Низкий приоритет (опциональные улучшения)

1. **Добавить createValidated()**
   - Влияние: удобство для strict validation
   - Усилия: средние
   - Breaking change: нет (новый метод)

2. **Добавить больше query methods**
   - Влияние: удобство API
   - Усилия: низкие
   - Breaking change: нет

---

## 📊 Итоговая оценка по категориям

| Категория | Оценка | Детали |
|-----------|--------|--------|
| **Архитектура слоёв** | 9/10 | Отлично, minor naming issues |
| **Core layer** | 9/10 | Отлично, чёткие инварианты |
| **Facade layer** | 7/10 | Хорошо, но inconsistency в naming/helpers |
| **Rules layer** | 9/10 | Отлично, чистые функции |
| **Adapters** | 9/10 | Отлично, правильная сериализация |
| **Error handling** | 8/10 | Хорошо, wrapOp используется, но inconsistency |
| **Immutability** | 10/10 | Отлично, полная иммутабельность |
| **Тесты** | 8/10 | Хорошо, но нет integration |
| **Документация** | 4/10 | TSDoc хороший, но нет docs/quote/ |
| **Консистентность** | 6/10 | Есть отличия от паттернов других VO |

**Средняя оценка:** **7.9/10**

---

## 🎯 Action Items

### Критичные (до production)

- [ ] Переименовать private fields (`b` → `_bid`, etc.)
- [ ] Исправить operation name (`'creates'` → `'createFromDecimals'`)
- [ ] Добавить helper methods для DRY
- [ ] Создать базовую документацию (README.md, facade.md)

### Важные (следующий спринт)

- [ ] Добавить integration тесты
- [ ] Создать полную документацию (architecture.md, examples.md)
- [ ] Решить вопрос с timestamp handling
- [ ] Добавить `createValidated()` метод

### Опциональные (backlog)

- [ ] Расширить query methods если нужно
- [ ] Добавить больше примеров в examples.md
- [ ] Создать visual diagrams в architecture.md

---

## ✅ Заключение

**Quote Value Object** - это **хорошо спроектированная и реализованная** абстракция, которая следует архитектурным паттернам проекта.

**Сильные стороны:**

- ✅ Чёткое разделение слоёв
- ✅ Правильные инварианты
- ✅ Хорошее использование wrapOp
- ✅ Полная иммутабельность
- ✅ Comprehensive тесты (154)

**Основные проблемы:**

- ⚠️ Naming inconsistency с другими VO
- ⚠️ Отсутствие helper methods (дублирование кода)
- ⚠️ Нет документации в docs/quote/
- ⚠️ Нет integration тестов
- ⚠️ Неясность с timestamp handling

**Рекомендация:** После исправления critical issues (naming, helpers, docs) Quote будет на уровне **9/10** - эталонный VO наравне с Balance.

**Estimated effort:** 8-12 часов для всех critical + important improvements.
