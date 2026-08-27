# Архитектура Spread Value Object

> Подробное описание архитектурных решений и паттернов

## Содержание

1. [Обзор архитектуры](#обзор-архитектуры)
2. [Паттерн Throws+Facade](#паттерн-throwsfacade)
3. [4-слойная архитектура](#4-слойная-архитектура)
4. [Разделение ответственности](#разделение-ответственности)
5. [Потоки данных](#потоки-данных)
6. [Архитектурные решения](#архитектурные-решения)
7. [Polymarket-специфичные решения](#polymarket-специфичные-решения)

---

## Обзор архитектуры

Spread модуль построен на принципах **Domain-Driven Design** с чётким разделением слоёв по ответственности.

### Ключевые принципы

1. **Иммутабельность** — все операции создают новые экземпляры
2. **Explicit Error Handling** — все ошибки явные через `Result<T, E>`
3. **Single Responsibility** — каждый класс делает одну вещь
4. **Dependency Inversion** — высокоуровневые слои не зависят от низкоуровневых
5. **Open/Closed** — легко расширять, не меняя существующий код
6. **Polymarket-aligned** — соответствие семантике рынков предсказаний

---

## Паттерн Throws+Facade

### Концепция

**Core кидает типизированные исключения** → **Facade ловит и возвращает Result<T, E>**

### Зачем?

1. **Core остаётся чистым** — не знает про `Result<T, E>`, только про domain logic
2. **Facade контролирует errors** — единственная точка, где исключения становятся `Result`
3. **Type safety** — невозможно забыть обработать ошибку
4. **Explicit contracts** — видно какие ошибки могут произойти

### Схема

```text
User Code
    ↓ calls
┌─────────────────────────────────┐
│  Facade Layer (SpreadService)   │
│  - Catches exceptions           │
│  - Returns Result<T, E>         │
└─────────────────────────────────┘
    ↓ calls
┌─────────────────────────────────┐
│  Core Layer (Spread)            │
│  - Throws SpreadInvariant...    │
│  - Pure domain logic            │
└─────────────────────────────────┘
```

### Пример потока

```typescript
// User Code
const result = SpreadService.fromValues(0.60, 0.50);
// result.ok === false
// result.error.context.reason === SpreadErrorReason.BID_GREATER_THAN_ASK

// Что происходит внутри:

// 1. Facade: SpreadService.fromValues()
const bidResult = OutcomePriceService.create(0.60);
const askResult = OutcomePriceService.create(0.50);

if (bidResult.ok && askResult.ok) {
  try {
    const spread = Spread.of(bidResult.value, askResult.value);
    return Ok(spread);
  } catch (error) {
    // 2. Core: Spread.of() бросил SpreadInvariantViolation
    if (error instanceof SpreadInvariantViolation) {
      // 3. Facade: оборачивает в InvalidSpreadError и Result
      return Err(new InvalidSpreadError(...));
    }
  }
}
```

---

## 4-слойная архитектура

### Диаграмма слоёв

```text
┌─────────────────────────────────────────────────────┐
│                  User Code                          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 4: Adapters                                  │
│  - SpreadSerializer (JSON/DTO conversion)           │
│  - SpreadFormatter (display formatting)             │
│  Роль: Внешняя интеграция                           │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 3: Facade (Public API)                       │
│  - SpreadService                                    │
│  Роль: Result<T, E> контракты                       │
│  - create(), fromValues(), zero()                   │
│  - tighten(), widen(), shift()                      │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 2: Rules (Business Validations)              │
│  - ValidateBidAsk                                   │
│  - ValidateMinWidth / ValidateMaxWidth              │
│  Роль: Бизнес-правила валидации                     │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 1: Core (Domain Logic)                       │
│  - Spread (immutable value object)                  │
│  - SpreadInvariantViolation (typed exception)       │
│  Роль: Чистая доменная логика                       │
└─────────────────────────────────────────────────────┘
```

### Layer 1: Core

**Файлы:**

- `Spread.ts` (~240 строк)
- `SpreadInvariantViolation.ts`
- `SpreadErrorReason.ts`

**Ответственность:**

- Хранение bid/ask как OutcomePrice объектов
- Инвариант: `bid ≤ ask`
- Чистые вычисления (width, midpoint, widthRatio)
- Throwing typed exceptions

**Пример:**

```typescript
class Spread {
  private constructor(
    private readonly _bid: OutcomePrice,
    private readonly _ask: OutcomePrice
  ) {
    // Инвариант: bid <= ask
    if (_bid.value().greaterThan(_ask.value())) {
      throw new SpreadInvariantViolation(
        `bid ${_bid.value()} cannot be greater than ask ${_ask.value()}`,
        SpreadErrorReason.BID_GREATER_THAN_ASK
      );
    }
  }

  static of(bid: OutcomePrice, ask: OutcomePrice): Spread {
    return new Spread(bid, ask);
  }

  width(): Decimal {
    return this._ask.value().minus(this._bid.value());
  }
}
```

### Layer 2: Rules

**Файлы:**

- `ValidateBidAsk.ts`
- `ValidateMinWidth.ts`
- `ValidateMaxWidth.ts`

**Ответственность:**

- Бизнес-правила валидации
- Возвращают `Result<void, InvalidSpreadError>`
- Расширяемые правила

**Пример:**

```typescript
export class ValidateBidAsk {
  static check(bid: OutcomePrice, ask: OutcomePrice): Result<void, InvalidSpreadError> {
    if (bid.value().greaterThan(ask.value())) {
      return Err(
        new InvalidSpreadError(
          `bid ${bid.value()} cannot be greater than ask ${ask.value()}`,
          {
            context: {
              bid: bid.value().toString(),
              ask: ask.value().toString(),
              reason: SpreadErrorReason.BID_GREATER_THAN_ASK
            }
          }
        )
      );
    }
    return Ok(undefined);
  }
}
```

### Layer 3: Facade

**Файлы:**

- `SpreadService.ts` (~420 строк)

**Ответственность:**

- Единственный публичный API
- Never Throw Contract
- Перехват исключений → Result<T, E>
- Использование централизованных errorUtils

**Интеграция с errorUtils:**

```typescript
import {
  toCause,
  toDecimal,
  rewrap,
  unexpectedError
} from '../../shared/facade/errorUtils.js';

// Пример использования toDecimal
const amountResult = toDecimal<InvalidSpreadError>(
  'amount',
  amount,
  SpreadErrorReason.INVALID_AMOUNT,
  InvalidSpreadError
);
if (!amountResult.ok) {
  return Err(rewrap('tighten', { spread: ... }, amountResult.error, InvalidSpreadError));
}

// Пример rewrap для переупаковки ошибок
const validationResult = ValidateBidAsk.check(bid, ask);
if (!validationResult.ok) {
  return Err(rewrap('create', { bid: ..., ask: ... }, validationResult.error, InvalidSpreadError));
}
```

### Layer 4: Adapters

**Файлы:**

- `SpreadSerializer.ts` — JSON/DTO конвертация
- `SpreadFormatter.ts` — форматирование

**Ответственность:**

- Сериализация/десериализация
- Форматирование для UI
- Внешняя интеграция

---

## Разделение ответственности

### Кто что делает

| Слой | Знает о | Не знает о | Пример |
| ------ | --------- | ------------ | -------- |
| **Core** | OutcomePrice, Decimal, инварианты | Result, errors, валидации | `Spread.of()` throws |
| **Rules** | OutcomePrice, валидации | Core создание | `ValidateBidAsk.check()` |
| **Facade** | Core, Rules, errorUtils | UI, сериализация | `SpreadService.create()` |
| **Adapters** | Facade, форматы данных | Core, Rules | `SpreadSerializer.toJSON()` |

### Зависимости

```text
Adapters → Facade → Rules → Core
   ↓         ↓       ↓        ↓
  DTO     Result   Valid   Domain
```

**Правило:** Нижние слои никогда не зависят от верхних

---

## Потоки данных

### Создание Spread

```text
User: SpreadService.fromValues(0.48, 0.52)
  ↓
Facade: toDecimal(0.48) → OutcomePrice.create()
  ↓
Facade: toDecimal(0.52) → OutcomePrice.create()
  ↓
Facade: ValidateBidAsk.check(bid, ask)
  ↓ (если Ok)
Core: Spread.of(bid, ask)
  ↓ (проверяет инвариант)
Facade: Ok(spread)
  ↓
User: result.value (Spread)
```

### Операция tighten

```text
User: SpreadService.tighten(spread, 0.01)
  ↓
Facade: toDecimal(0.01) → amountDecimal
  ↓
Facade: validate amount (finite, non-negative)
  ↓
Facade: calculate new bid = spread.bid() + amount
  ↓
Facade: calculate new ask = spread.ask() - amount
  ↓
Facade: OutcomePriceService.create(newBid)
  ↓
Facade: OutcomePriceService.create(newAsk)
  ↓
Core: Spread.of(newBid, newAsk)
  ↓
Facade: Ok(newSpread)
  ↓
User: result.value (tighter Spread)
```

### Обработка ошибки

```text
User: SpreadService.fromValues(0.60, 0.50)  // bid > ask
  ↓
Facade: создаёт OutcomePrice объекты
  ↓
Facade: ValidateBidAsk.check(0.60, 0.50)
  ↓
Rules: bid > ask → Err(InvalidSpreadError)
  ↓
Facade: rewrap error с op='fromValues'
  ↓
User: result.ok === false
  ↓
User: result.error.context.reason === BID_GREATER_THAN_ASK
```

---

## Архитектурные решения

### 1. Почему Spread хранит OutcomePrice, а не Decimal?

**Решение:** `private readonly _bid: OutcomePrice, _ask: OutcomePrice`

**Альтернатива:** `private readonly _bid: Decimal, _ask: Decimal`

**Обоснование:**

- ✅ OutcomePrice уже гарантирует диапазон [0.0001, 0.9999]
- ✅ Переиспользование валидации OutcomePrice
- ✅ Семантическая корректность (bid/ask — это цены, не числа)
- ✅ Type safety на уровне системы типов

### 2. Почему tighten/widen симметричны?

**Решение:**

- `tighten(spread, amount)` → bid+amount, ask-amount
- `widen(spread, amount)` → bid-amount, ask+amount

**Обоснование:**

- ✅ Сохраняют midpoint (середину спреда)
- ✅ Интуитивно понятны для трейдеров
- ✅ Полезны для маркет-мейкинга

**Пример:**

```typescript
// Исходный спред: 0.48-0.52, mid=0.50
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const spread = spreadResult.value;

  // Сужение на 0.01
  SpreadService.tighten(spread, 0.01);  // → 0.49-0.51, mid=0.50 (сохранён!)

  // Расширение на 0.02
  SpreadService.widen(spread, 0.02);    // → 0.46-0.54, mid=0.50 (сохранён!)
}
```

### 3. Почему shift не называется move?

**Решение:** `shift(spread, amount)` — сдвигает обе цены на amount

**Обоснование:**

- ✅ "Shift" — устоявшийся термин в финансах
- ✅ Сохраняет width (ширину спреда)
- ✅ Отличается от "move" (который может подразумевать асимметричное движение)

### 4. Почему нет методов setBid/setAsk?

**Решение:** Spread иммутабелен, нет сеттеров

**Обоснование:**

- ✅ Value Object должен быть иммутабельным
- ✅ Любое изменение → новый Spread через SpreadService
- ✅ Предотвращает invalid states

**Пример:**

```typescript
// ❌ НЕТ: spread.setBid(newBid)

// ✅ ДА: создаём новый Spread
const newSpreadResult = SpreadService.create(newBid, spread.ask());
```

### 5. Почему zero(price) возвращает Spread, а не Result?

**Решение:** `zero(price: OutcomePrice): Spread` — не возвращает Result

**Обоснование:**

- ✅ Принимает валидный OutcomePrice → не может провалиться
- ✅ Инвариант bid ≤ ask автоматически выполнен (bid === ask)
- ✅ Упрощает использование в сценариях, где нужен zero-width spread

---

## Polymarket-специфичные решения

### 1. Интеграция с OutcomePrice

Spread **зависит** от OutcomePrice:

- Bid и Ask — это OutcomePrice объекты
- Валидация диапазона делегирована OutcomePrice
- Операции используют OutcomePriceService для создания новых OutcomePrice

**Почему не наоборот?**

- OutcomePrice — более базовый концепт (одна цена)
- Spread — композитный концепт (пара цен)
- OutcomePrice используется самостоятельно, Spread зависит от OutcomePrice

### 2. Работа с базовым тиком

Spread не форсирует alignment к базовому тику (0.0001):

- Bid и Ask могут быть любыми валидными OutcomePrice
- Если нужен alignment, используйте OutcomePriceService.roundToMarketTick()

**Обоснование:**

- Разделение ответственности
- Spread не знает про тики, это знает OutcomePrice
- Flexibility для разных контекстов

### 3. Width как Ratio

`widthRatio(): Ratio` возвращает относительную ширину как дробь от midpoint:

```typescript
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const spread = spreadResult.value;
  spread.widthRatio().toDecimal().toNumber();  // 0.08 (= 0.04 / 0.50 = 8%)

  // Для отображения в процентах:
  spread.widthRatio().toDecimal().times(100).toFixed(2);  // "8.00"

  // Для basis points:
  spread.widthRatio().toDecimal().times(10000).toNumber();  // 800
}
```

**Обоснование:**

- Возвращает `Ratio` для единообразия с другими VO (Fee, Discount)
- `Ratio` семантически точнее: дробь 0.08, а не "8 процентов"
- Для отображения вызывающий код явно конвертирует: `times(100)`
- Удобно для сравнения спредов на разных ценовых уровнях

### 4. Нулевая ширина (zero-width spread)

Разрешены спреды с bid === ask:

```typescript
const zeroWidthResult = SpreadService.fromValues(0.50, 0.50);  // Ok
if (zeroWidthResult.ok) {
  zeroWidthResult.value.isZeroWidth();  // true
}
```

**Обоснование:**

- Математически корректно (bid ≤ ask включает равенство)
- Полезно для моделирования perfect liquidity
- Упрощает тестирование и граничные случаи

### 5. Строгие сравнения (Strict Equality)

Spread использует **строгие** сравнения без epsilon:

```typescript
const result1 = SpreadService.fromValues(0.48, 0.52);
const result2 = SpreadService.fromValues(0.48, 0.52);
const result3 = SpreadService.fromValues(0.48000001, 0.52);

if (result1.ok && result2.ok && result3.ok) {
  const spread1 = result1.value;
  const spread2 = result2.value;
  const spread3 = result3.value;

  // Строгое сравнение через equals()
  spread1.equals(spread2);  // true — точное совпадение

  // Приближенное совпадение НЕ равно
  spread1.equals(spread3);  // false — не точное совпадение
}
```

**Обоснование:**

- **Предсказуемость** — поведение однозначное, без сюрпризов
- **Детерминированность** — одинаковый результат всегда
- **Type-safety** — `Decimal.equals()` гарантирует точное сравнение
- **Нет магических чисел** — не нужно выбирать epsilon
- **Соответствие финансам** — в финансах важна точность до последнего знака

**Когда это важно:**

```typescript
// Проверка идентичности спредов в тестах
expect(result.value.width().toNumber()).toBe(0.04);  // Строго!

// Валидация результатов операций
const tightened = SpreadService.tighten(spread, 0.01).value;
const expected = SpreadService.fromValues(0.49, 0.51).value;
tightened.equals(expected);  // true — точное совпадение после операции
```

**Альтернативы (если нужно приближенное сравнение):**

Если действительно нужно сравнение с tolerance, используйте кастомную логику:

```typescript
function approximatelyEqual(s1: Spread, s2: Spread, epsilon: number): boolean {
  const bidDiff = s1.bid().value().minus(s2.bid().value()).abs();
  const askDiff = s1.ask().value().minus(s2.ask().value()).abs();
  return bidDiff.lessThanOrEqualTo(epsilon) && askDiff.lessThanOrEqualTo(epsilon);
}
```

Но в 99% случаев строгое сравнение — правильный выбор.

---

## Расширяемость

### Добавление новых валидаций

Создайте новый Rule:

```typescript
// src/spread/rules/ValidateMinimumLiquidity.ts
export class ValidateMinimumLiquidity {
  static check(
    spread: Spread,
    minWidthBps: number
  ): Result<void, InvalidSpreadError> {
    const widthBps = spread.widthRatio().toDecimal().times(10000).toNumber();
    
    if (widthBps < minWidthBps) {
      return Err(
        new InvalidSpreadError(
          `Spread width ${widthBps} bps is below minimum ${minWidthBps} bps`,
          {
            context: {
              widthBps,
              minWidthBps,
              reason: SpreadErrorReason.WIDTH_TOO_SMALL
            }
          }
        )
      );
    }
    
    return Ok(undefined);
  }
}
```

Используйте в Facade:

```typescript
export class SpreadService {
  static createWithMinLiquidity(
    bid: OutcomePrice,
    ask: OutcomePrice,
    minWidthBps: number
  ): Result<Spread, InvalidSpreadError> {
    const spreadResult = this.create(bid, ask);
    if (!spreadResult.ok) return spreadResult;
    
    const validationResult = ValidateMinimumLiquidity.check(
      spreadResult.value,
      minWidthBps
    );
    
    if (!validationResult.ok) {
      return Err(validationResult.error);
    }
    
    return spreadResult;
  }
}
```

### Добавление новых операций

Добавьте метод в SpreadService:

```typescript
export class SpreadService {
  /**
   * Инвертирует спред (меняет bid и ask местами для противоположной стороны рынка)
   */
  static invert(spread: Spread): Result<Spread, InvalidSpreadError> {
    try {
      // Вычисляем комплементы
      const newBidResult = OutcomePriceService.complement(spread.ask());
      const newAskResult = OutcomePriceService.complement(spread.bid());
      
      if (!newBidResult.ok) {
        return Err(rewrap('invert', { spread: ... }, newBidResult.error, InvalidSpreadError));
      }
      
      if (!newAskResult.ok) {
        return Err(rewrap('invert', { spread: ... }, newAskResult.error, InvalidSpreadError));
      }
      
      return this.create(newBidResult.value, newAskResult.value);
    } catch (error) {
      return Err(unexpectedError('invert', { spread: ... }, error, 'spread', InvalidSpreadError));
    }
  }
}
```

---

## Дальнейшее чтение

- [Core Layer](./core.md) — детали Spread класса и инвариантов
- [Facade API](./facade.md) — полное описание SpreadService
- [Примеры](./examples.md) — реальные use cases
- [Адаптеры](./adapters.md) — сериализация и форматирование
