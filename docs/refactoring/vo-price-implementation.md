# Price Value Object: План рефакторинга и имплементации

## Метаданные

- **Value Object:** Price
- **Текущий файл:** `packages/domain/value-objects/src/Price.ts` (492 lines)
- **Сложность:** Medium (диапазон [0.0001, 0.9999], округление до тиков)
- **Зависимости:** `@polymarket/math`, `@polymarket/errors`, `@polymarket/result`

---

## Оглавление

1. [Специфика Price](#специфика-price)
2. [Целевая архитектура](#целевая-архитектура)
3. [Детальный план по фазам](#детальный-план-по-фазам)
4. [План тестирования](#план-тестирования)
5. [План документации](#план-документации)
6. [Миграция](#миграция)

---

## Архитектурные правила (критические)

**ВАЖНО:** Эти правила обязательны к соблюдению во всех фазах:

1. ✅ **Core не делает approximate-equality.** В Core только строгое равенство `equals()` по Decimal. Approx сравнение — в Facade/Math/Utils под другим именем (например, `approximatelyEquals`).

2. ✅ **Rules работают с Price, НО правила, валидирующие ПАРАМЕТРЫ рынка, работают с `number | string | Decimal`.**
   - Правила для доменных объектов (ValidateSpread, ValidateAligned) принимают Price
   - Правила для параметров рынка (ValidateTickSize для tickSize/minSpread) принимают `number | string | Decimal` и возвращают нормализованный Decimal

3. ✅ **`roundToMarketTick()` не требует "уже кратно тика".** Это функция округления, а не валидации. Для проверки alignment используем отдельный метод `ensureAlignedToMarketTick()`.

4. ✅ **Исключения остаются внутри Core. Всё наружу — Result.**
   - Core бросает исключения при нарушении инвариантов
   - **ВСЕ публичные методы Facade и Rules возвращают `Result<T, E>`**
   - **Никаких `Price.of()` в публичных методах — только через `create()`**
   - **Никаких `Price.of()` в примерах/тестах вне Core — только `expectOk(PriceService.create(...))`**
   - **Парсинг входных `number | string` делается в одном месте:**
     - `ValidateTickSize` парсит `tickSize` и возвращает `Result<Decimal, E>`
     - `ValidateSpread` парсит `minSpread` внутри
     - `PriceService.multiply/divide` парсит `factor/divisor` внутри
     - Остальные функции используют готовые `Decimal` из Result.value

5. ✅ **Никаких магических чисел типа 0.9998.** Только вычисления из констант: `Price.maxValue().minus(Price.minValue())`.

6. ✅ **Никаких epsilon в проверках alignment.** Для проверки кратности используем `price.mod(tickSize).isZero()` — строго, без приближений. Epsilon только в `approximatelyEquals()` для явных approximate-сравнений (с защитой от epsilon <= 0).

---

## Ключевые улучшения после финальной итерации

**1. ValidateTickSize возвращает Result<Decimal, ...>**
- Избегаем двойного парсинга tickSize
- ValidateAligned и PriceService.roundToMarketTick() получают готовый Decimal из Result.value
- Единый источник парсинга и валидации

**2. ValidateSpread со стандартизированными ошибками**
- Консистентность с ValidateTickSize
- ВСЕ ошибки содержат field + reason:
  - minSpread: "parse_error" | "is_nan" | "not_finite" | "negative"
  - ask: "ask_lt_bid"
  - spread: "lt_min_spread"

**3. Price.minValue()/maxValue() для доступа к Decimal**
- Избегаем создания Price-объектов в ValidateTickSize
- Оптимизация: не гоняем инварианты конструктора
- Везде заменено Price.max().value() → Price.maxValue()

**4. PriceService.approximatelyEquals() с защитой**
- Защита от epsilon <= 0 (возвращает false вместо исключения)
- Явное правило: epsilon должен быть > 0

**5. Все примеры вне Core используют expectOk(PriceService.create())**
- Никаких Price.of() в публичных примерах (включая JSDoc)
- Соблюдение правила "всё наружу — Result"

**6. Правила переписаны корректно**
- Правило 4: "Парсинг в одном месте" вместо "везде try/catch"
- Правило 5: Price.maxValue().minus(Price.minValue())

**7. Тест-план с проверяемыми контрактами**
- Убраны непроверяемые "нет двойного парсинга", "не создаются Price-объекты"
- Убраны магические числа (0.9998) - вычисляется maxAllowed динамически
- Добавлены: "error context содержит maxAllowed/minPrice/maxPrice", "tickSize == maxAllowed → Ok"

**8. Типизация стандартизированных ошибок**
- rules/types.ts с ErrorContext и *ErrorReason unions
- Все ошибки типобезопасны (reason: SpreadErrorReason | TickSizeErrorReason | AlignedErrorReason)
- Тесты проверяют наличие field + reason во всех Err

**9. Технические оптимизации**
- ValidateAligned: убран избыточный .abs() после mod()
- Core constants: точная формулировка про Decimal sharing как иммутабельных значений

---

## Специфика Price

### Характеристики

**Назначение:** Представляет цену на рынках предсказаний Polymarket.

**Доменное ограничение:**
> Price — доменный тип для Polymarket-like рынков с диапазоном [MIN, MAX].
> Для универсальной вероятности [0, 1] будет отдельный тип `Probability` (пока не делаем).

**Диапазон:** `[0.0001, 0.9999]`
- MIN_PRICE = 0.0001 (0.01%)
- MAX_PRICE = 0.9999 (99.99%)

**Tick Size:** `0.0001` (1 базисный пункт)

**Константы:**
```typescript
Price.min()   // 0.0001
Price.max()   // 0.9999
Price.half()  // 0.5
```

### Текущие операции (что будет удалено/изменено)

**Методы, которые будут УДАЛЕНЫ из Core:**
- ❌ `toTick(tickSize)` → переносится в `PriceService.roundToMarketTick()`
- ❌ `floor()`, `ceil()`, `round()` → используй функции из `@polymarket/math`
- ❌ `lessThan()`, `greaterThan()` → используй `price1.value().lessThan(price2.value())`
- ❌ `complement()`, `average()`, `multiply()`, `divide()` → переносятся в `PriceService`

**Что останется в Core:**
- ✅ `of(value)` - создание Price (ТОЛЬКО внутри Core!)
- ✅ `value()` - получение Decimal
- ✅ `toNumber()` - получение number
- ✅ `equals(other)` - строгое равенство (без epsilon!)
- ✅ `isMin()`, `isMax()` - проверка границ

**Важно для примеров и тестов:**
Во всех примерах и тестах ВОКРУГ Core (Rules, Facade, Adapters) использовать:
```typescript
const price = expectOk(PriceService.create(0.5));
```
Вместо:
```typescript
const price = Price.of(0.5); // ❌ Нельзя использовать вне Core!
```

`expectOk()` - вспомогательная функция для тестов:
```typescript
function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`Expected Ok, got Err: ${result.error}`);
  return result.value;
}
```

**Новые операции в PriceService:**
1. **Создание:**
   - `create(value)` → `Result<Price, InvalidPriceError>`

2. **Математика (ВСЕ возвращают Result!):**
   - `complement(price)` → `Result<Price, InvalidPriceError>`
   - `average(price1, price2)` → `Result<Price, InvalidPriceError>`
   - `multiply(price, factor)` → `Result<Price, InvalidPriceError>`
   - `divide(price, divisor)` → `Result<Price, InvalidPriceError | DivisionByZeroError>`

3. **Округление:**
   - `roundToMarketTick(price, tickSize)` → `Result<Price, ...>` - округляет к ближайшему тику
   - `ensureAlignedToMarketTick(price, tickSize)` → `Result<void, ...>` - проверяет что УЖЕ кратно тику

4. **Сравнение:**
   - `approximatelyEquals(price1, price2, epsilon)` → boolean (единственный метод БЕЗ Result)

### Инварианты

**Всегда должно быть true:**
1. ✅ `0.0001 <= price <= 0.9999`
2. ✅ `isFinite(price)`
3. ✅ `!isNaN(price)`

### Бизнес-правила (контекстуальные)

**Зависят от контекста:**
1. 🔶 Округление до конкретного tickSize (может быть не 0.0001)
2. 🔶 Проверка что price подходит для конкретного рынка
3. 🔶 Проверка spread между bid/ask

---

## Целевая архитектура

### Структура директорий

```
packages/domain/value-objects/src/price/
 ├─ core/
 │   ├─ Price.ts                    ← Core VO (только инварианты)
 │   └─ index.ts
 │
 ├─ rules/
 │   ├─ types.ts                    ← Типизация стандартизированных ошибок
 │   ├─ ValidateTickSize.ts         ← Правило: tickSize валидный
 │   ├─ ValidateSpread.ts           ← Правило: spread корректный
 │   ├─ ValidateAligned.ts          ← Правило: price кратен tickSize
 │   └─ index.ts
 │
 ├─ facade/
 │   ├─ PriceService.ts             ← Главный фасад
 │   └─ index.ts
 │
 ├─ adapters/
 │   ├─ PriceSerializer.ts          ← JSON сериализация
 │   ├─ PriceFormatter.ts           ← String formatting
 │   └─ index.ts
 │
 └─ index.ts                        ← Главный экспорт
```

**Изменения в структуре:**
- ❌ Удалена `policy/` — избыточный слой для одной политики
- ✅ Функционал `MarketPricePolicy` перенесён в `rules/ValidateAligned.ts`
- ✅ Rules содержат атомарные правила: ValidateTickSize, ValidateSpread, ValidateAligned

### Слои и ответственность

#### **Core Layer** (`core/Price.ts`)

**Ответственность:** Только инварианты существования.

```typescript
import Decimal from 'decimal.js';

/**
 * PriceInvariantViolation - нарушение инварианта Price
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 */
export class PriceInvariantViolation extends Error {
  constructor(message: string) {
    super(`Price invariant violation: ${message}`);
    this.name = 'PriceInvariantViolation';
  }
}

/**
 * Core Price Value Object
 *
 * @remarks
 * Представляет цену на Polymarket-like рынках предсказаний.
 * Диапазон: [0.0001, 0.9999]
 *
 * Содержит ТОЛЬКО инварианты существования:
 * - Not NaN
 * - Finite
 * - Диапазон [MIN, MAX]
 * - Строгое равенство
 *
 * Методы toTick/floor/ceil/round УДАЛЕНЫ из Core.
 * Используй PriceService для математических операций.
 */
export class Price {
  private static readonly MIN_PRICE = new Decimal(0.0001);
  private static readonly MAX_PRICE = new Decimal(0.9999);
  private static readonly HALF_PRICE = new Decimal(0.5);

  private constructor(private readonly v: Decimal) {
    // Инвариант 1: Not NaN
    if (v.isNaN()) {
      throw new PriceInvariantViolation('must not be NaN');
    }

    // Инвариант 2: Must be finite
    if (!v.isFinite()) {
      throw new PriceInvariantViolation('must be finite');
    }

    // Инвариант 3: Must be >= MIN
    if (v.lessThan(Price.MIN_PRICE)) {
      throw new PriceInvariantViolation(`must be >= ${Price.MIN_PRICE.toString()}`);
    }

    // Инвариант 4: Must be <= MAX
    if (v.greaterThan(Price.MAX_PRICE)) {
      throw new PriceInvariantViolation(`must be <= ${Price.MAX_PRICE.toString()}`);
    }
  }

  /**
   * Создаёт Price из Decimal/number/string
   *
   * @param value - Значение цены
   * @returns Price instance
   * @throws {PriceInvariantViolation} При нарушении инвариантов
   */
  public static of(value: number | string | Decimal): Price {
    const decimal = value instanceof Decimal ? value : new Decimal(value);
    return new Price(decimal);
  }

  /**
   * Константы (функции, создающие новый объект каждый раз)
   *
   * @remarks
   * Функции возвращают новый Price-объект; Decimal константы шарятся как иммутабельные значения.
   * Не полагаемся на referential equality.
   */
  public static min(): Price {
    return new Price(Price.MIN_PRICE);
  }

  public static max(): Price {
    return new Price(Price.MAX_PRICE);
  }

  public static half(): Price {
    return new Price(Price.HALF_PRICE);
  }

  /**
   * Возвращает минимальное значение цены как Decimal (без создания Price объекта)
   *
   * @remarks
   * Используется в Rules для проверок без создания Price объектов.
   * Оптимизация: не гоняет инварианты конструктора.
   */
  public static minValue(): Decimal {
    return Price.MIN_PRICE;
  }

  /**
   * Возвращает максимальное значение цены как Decimal (без создания Price объекта)
   *
   * @remarks
   * Используется в Rules для проверок без создания Price объектов.
   * Оптимизация: не гоняет инварианты конструктора.
   */
  public static maxValue(): Decimal {
    return Price.MAX_PRICE;
  }

  /**
   * Возвращает Decimal значение
   */
  public value(): Decimal {
    return this.v;
  }

  /**
   * Возвращает number значение
   */
  public toNumber(): number {
    return this.v.toNumber();
  }

  /**
   * Проверяет строгое равенство с другой ценой
   *
   * @remarks
   * СТРОГОЕ равенство по Decimal.equals().
   * Для approximate-equality используй PriceService.approximatelyEquals().
   *
   * @param other - Другая цена
   * @returns true если значения строго равны
   */
  public equals(other: Price): boolean {
    return this.v.equals(other.v);
  }

  /**
   * Проверяет что это минимальная цена
   */
  public isMin(): boolean {
    return this.v.equals(Price.MIN_PRICE);
  }

  /**
   * Проверяет что это максимальная цена
   */
  public isMax(): boolean {
    return this.v.equals(Price.MAX_PRICE);
  }
}
```

**Что можно в Core:**
- ✅ Проверка инвариантов (конструктор)
- ✅ Строгое equality (без epsilon)
- ✅ Геттеры для Decimal/number
- ✅ Проверки isMin/isMax

**Что нельзя в Core:**
- ❌ Approximate equality с epsilon → используй `PriceService.approximatelyEquals()`
- ❌ Математику (complement, multiply, divide) → используй `PriceService`
- ❌ Округление (toTick, floor, ceil) → используй `PriceService.roundToMarketTick()`
- ❌ Сравнение (lessThan, greaterThan) → используй `price1.value().lessThan(price2.value())`
- ❌ Бизнес-правила → используй Rules
- ❌ Сериализацию → используй Adapters

---

#### **Math Layer** (из `@polymarket/math`)

**Используем готовые функции:**

```typescript
import {
  multiplyDecimal,
  divideDecimal,
  addDecimal,
  subtractDecimal,
  roundToTick
} from '@polymarket/math';
```

**Примеры:**
```typescript
// Дополнение (complement): 1 - price
const one = new Decimal(1);
const complement = subtractDecimal(one, price.value());

// Среднее
const sum = addDecimal(price1.value(), price2.value());
const avgValue = divideDecimal(sum, new Decimal(2));

// Умножение
const multiplied = multiplyDecimal(price.value(), new Decimal(2));

// Округление до тика
const rounded = roundToTick(price.value(), new Decimal(0.0001));
```

---

#### **Rules Layer**

**Типизация стандартизированных ошибок:**

```typescript
/**
 * Общий тип для стандартизированных контекстов ошибок
 *
 * @remarks
 * Все ошибки в Rules должны содержать field + reason для упрощения обработки.
 */
export type ErrorContext = {
  field: string;
  reason: string;
  [key: string]: unknown; // дополнительные поля
};

/**
 * Типы reason для ValidateTickSize
 */
export type TickSizeErrorReason =
  | 'parse_error'
  | 'is_nan'
  | 'not_finite'
  | 'not_positive'
  | 'too_large';

/**
 * Типы reason для ValidateSpread
 */
export type SpreadErrorReason =
  | 'parse_error'    // minSpread парсинг
  | 'is_nan'         // minSpread NaN
  | 'not_finite'     // minSpread Infinity
  | 'negative'       // minSpread < 0
  | 'ask_lt_bid'     // ask < bid
  | 'lt_min_spread'; // spread < minSpread

/**
 * Типы reason для ValidateAligned
 */
export type AlignedErrorReason =
  | 'not_aligned'; // price не кратен tickSize
```

**Файл:** `rules/ValidateTickSize.ts`

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTickSizeError } from '@polymarket/errors';
import { Price } from '../core/Price.js';
import type { TickSizeErrorReason } from './types.js';
import Decimal from 'decimal.js';

/**
 * Правило: TickSize должен быть валидным
 *
 * @remarks
 * Атомарное бизнес-правило.
 * Проверяет что tickSize:
 * - Положительный
 * - Конечный
 * - Не больше чем диапазон цены (MAX - MIN)
 *
 * ВАЖНО:
 * - Никаких магических чисел типа 0.9998! Используем Price.maxValue().minus(Price.minValue())
 * - Возвращает нормализованный Decimal (не void), чтобы избежать двойного парсинга
 *
 * @param tickSize - Размер тика (принимает number/string/Decimal для удобства на границе)
 * @returns Result<Decimal, InvalidTickSizeError> - валидированный и нормализованный tickSize
 *
 * @example
 * ```typescript
 * const result = ValidateTickSize.check(0.01);
 * if (result.ok) {
 *   const tickDecimal = result.value; // готовый Decimal
 * } else {
 *   console.error(result.error); // InvalidTickSizeError
 * }
 * ```
 */
export class ValidateTickSize {
  public static check(tickSize: number | string | Decimal): Result<Decimal, InvalidTickSizeError> {
    // Нормализуем входное значение (с обработкой ошибок парсинга!)
    let tickDecimal: Decimal;
    try {
      tickDecimal = tickSize instanceof Decimal ? tickSize : new Decimal(tickSize);
    } catch (error) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size is not a valid decimal: ${ctx.tickSize}`,
          {
            code: InvalidTickSizeError.code,
            context: {
              field: 'tickSize',
              reason: 'parse_error' as TickSizeErrorReason,
              tickSize: String(tickSize),
              parseError: error instanceof Error ? error.message : 'unknown'
            }
          }
        )
      );
    }

    // Проверка 1: Not NaN
    if (tickDecimal.isNaN()) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size must not be NaN, got ${ctx.tickSize}`,
          {
            code: InvalidTickSizeError.code,
            context: {
              field: 'tickSize',
              reason: 'is_nan' as TickSizeErrorReason,
              tickSize: String(tickSize)
            }
          }
        )
      );
    }

    // Проверка 2: Finite
    if (!tickDecimal.isFinite()) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size must be finite, got ${ctx.tickSize}`,
          {
            code: InvalidTickSizeError.code,
            context: {
              field: 'tickSize',
              reason: 'not_finite' as TickSizeErrorReason,
              tickSize: tickDecimal.toString()
            }
          }
        )
      );
    }

    // Проверка 3: Positive
    if (tickDecimal.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size must be positive, got ${ctx.tickSize}`,
          {
            code: InvalidTickSizeError.code,
            context: {
              field: 'tickSize',
              reason: 'not_positive' as TickSizeErrorReason,
              tickSize: tickDecimal.toString()
            }
          }
        )
      );
    }

    // Проверка 4: Не больше диапазона (MAX - MIN)
    // ВАЖНО: Вычисляем из констант, не используем магические числа!
    // Используем Price.minValue()/maxValue() чтобы не создавать Price-объекты
    const maxAllowed = Price.maxValue().minus(Price.minValue());
    if (tickDecimal.greaterThan(maxAllowed)) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size ${ctx.tickSize} is too large for price range [${ctx.minPrice}, ${ctx.maxPrice}]`,
          {
            code: InvalidTickSizeError.code,
            context: {
              field: 'tickSize',
              reason: 'too_large' as TickSizeErrorReason,
              tickSize: tickDecimal.toString(),
              maxAllowed: maxAllowed.toString(),
              minPrice: Price.minValue().toString(),
              maxPrice: Price.maxValue().toString()
            }
          }
        )
      );
    }

    // Возвращаем нормализованный Decimal (избегаем двойного парсинга!)
    return Ok(tickDecimal);
  }
}
```

**Файл:** `rules/ValidateSpread.ts`

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import { Price } from '../core/Price.js';
import type { SpreadErrorReason } from './types.js';
import Decimal from 'decimal.js';

/**
 * Правило: Spread между ценами должен быть валидным
 *
 * @remarks
 * Атомарное бизнес-правило.
 * Проверяет что:
 * - Ask >= Bid
 * - Spread >= minSpread
 *
 * ВАЖНО:
 * - Принимает Price, а не raw Decimal
 * - minSpread принимает number|string|Decimal с валидацией (консистентность с ValidateTickSize)
 * - Парсинг minSpread обёрнут в try/catch
 *
 * @param bid - Цена покупки (bid)
 * @param ask - Цена продажи (ask)
 * @param minSpread - Минимальный спред (number | string | Decimal)
 * @returns Result<void, InvalidSpreadError>
 *
 * @example
 * ```typescript
 * const bid = expectOk(PriceService.create(0.4));
 * const ask = expectOk(PriceService.create(0.6));
 * const result = ValidateSpread.check(bid, ask, 0.01);
 * if (!result.ok) {
 *   console.error(result.error);
 * }
 * ```
 */
export class ValidateSpread {
  public static check(
    bid: Price,
    ask: Price,
    minSpread: number | string | Decimal
  ): Result<void, InvalidSpreadError> {
    // Парсим и валидируем minSpread
    let minSpreadDecimal: Decimal;
    try {
      minSpreadDecimal = minSpread instanceof Decimal ? minSpread : new Decimal(minSpread);
    } catch (error) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Invalid minSpread value: ${ctx.minSpread}`,
          {
            code: InvalidSpreadError.code,
            context: {
              field: 'minSpread',
              reason: 'parse_error' as SpreadErrorReason,
              minSpread: String(minSpread),
              parseError: error instanceof Error ? error.message : 'unknown'
            }
          }
        )
      );
    }

    // Валидация minSpread: NaN, Infinity, negative
    if (minSpreadDecimal.isNaN()) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `minSpread must not be NaN, got ${ctx.minSpread}`,
          {
            code: InvalidSpreadError.code,
            context: {
              field: 'minSpread',
              reason: 'is_nan' as SpreadErrorReason,
              minSpread: String(minSpread)
            }
          }
        )
      );
    }

    if (!minSpreadDecimal.isFinite()) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `minSpread must be finite, got ${ctx.minSpread}`,
          {
            code: InvalidSpreadError.code,
            context: {
              field: 'minSpread',
              reason: 'not_finite' as SpreadErrorReason,
              minSpread: minSpreadDecimal.toString()
            }
          }
        )
      );
    }

    if (minSpreadDecimal.lessThan(0)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `minSpread must be non-negative, got ${ctx.minSpread}`,
          {
            code: InvalidSpreadError.code,
            context: {
              field: 'minSpread',
              reason: 'negative' as SpreadErrorReason,
              minSpread: minSpreadDecimal.toString()
            }
          }
        )
      );
    }

    // Проверка 1: Ask должен быть >= Bid
    if (ask.value().lessThan(bid.value())) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Ask price ${ctx.ask} must be >= bid price ${ctx.bid}`,
          {
            code: InvalidSpreadError.code,
            context: {
              field: 'ask',
              reason: 'ask_lt_bid' as SpreadErrorReason,
              bid: bid.value().toString(),
              ask: ask.value().toString()
            }
          }
        )
      );
    }

    // Проверка 2: Spread должен быть >= minSpread
    const spread = ask.value().minus(bid.value());
    if (spread.lessThan(minSpreadDecimal)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Spread ${ctx.spread} is less than minimum ${ctx.minSpread}`,
          {
            code: InvalidSpreadError.code,
            context: {
              field: 'spread',
              reason: 'lt_min_spread' as SpreadErrorReason,
              spread: spread.toString(),
              minSpread: minSpreadDecimal.toString(),
              bid: bid.value().toString(),
              ask: ask.value().toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**Файл:** `rules/ValidateAligned.ts`

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError, InvalidTickSizeError } from '@polymarket/errors';
import { Price } from '../core/Price.js';
import { ValidateTickSize } from './ValidateTickSize.js';
import type { AlignedErrorReason } from './types.js';
import Decimal from 'decimal.js';

/**
 * Правило: Цена должна быть кратна tickSize
 *
 * @remarks
 * Атомарное бизнес-правило.
 * Проверяет что цена УЖЕ выровнена по тику (aligned).
 *
 * Используется когда нужна валидация БЕЗ округления
 * (например, при отправке ордера на биржу).
 *
 * Для округления используй PriceService.roundToMarketTick().
 *
 * ВАЖНО:
 * - Сам валидирует tickSize через ValidateTickSize (не требует precondition)
 * - ValidateTickSize возвращает нормализованный Decimal — БЕЗ двойного парсинга!
 * - Использует строгую проверку mod() БЕЗ epsilon
 *
 * @param price - Цена для проверки
 * @param tickSize - Размер тика (number | string | Decimal)
 * @returns Result<void, InvalidPriceError | InvalidTickSizeError>
 *
 * @example
 * ```typescript
 * const price = expectOk(PriceService.create(0.5));
 * const result = ValidateAligned.check(price, 0.0001);
 * if (!result.ok) {
 *   console.error('Price not aligned to tick');
 * }
 * ```
 */
export class ValidateAligned {
  public static check(
    price: Price,
    tickSize: number | string | Decimal
  ): Result<void, InvalidPriceError | InvalidTickSizeError> {
    // 1. Парсим и валидируем tickSize (через ValidateTickSize)
    // ValidateTickSize возвращает Result<Decimal, ...> — получаем готовый Decimal!
    const tickResult = ValidateTickSize.check(tickSize);
    if (!tickResult.ok) {
      return Err(tickResult.error);
    }

    // 2. Получаем нормализованный Decimal из Result (БЕЗ повторного парсинга!)
    const tickDecimal = tickResult.value;

    // 3. Проверяем кратность через mod() - СТРОГО, без epsilon!
    // Для положительных price и tickSize mod() всегда >= 0, abs() избыточен
    const remainder = price.value().mod(tickDecimal);

    if (!remainder.isZero()) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Price ${ctx.price} is not aligned to tick size ${ctx.tickSize} (remainder: ${ctx.remainder})`,
          {
            code: InvalidPriceError.code,
            context: {
              price: price.value().toString(),
              tickSize: tickDecimal.toString(),
              remainder: remainder.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

---

#### **Facade Layer**

**Файл:** `facade/PriceService.ts`

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { Price, PriceInvariantViolation } from '../core/Price.js';
import { InvalidPriceError, InvalidTickSizeError, DivisionByZeroError } from '@polymarket/errors';
import {
  multiplyDecimal,
  divideDecimal,
  addDecimal,
  subtractDecimal,
  roundToTick
} from '@polymarket/math';
import { ValidateTickSize } from '../rules/ValidateTickSize.js';
import { ValidateAligned } from '../rules/ValidateAligned.js';
import Decimal from 'decimal.js';

/**
 * Фасад для работы с Price
 *
 * @remarks
 * Единая точка входа для всех операций с ценами.
 * Оркестрирует Core + Math + Rules.
 *
 * Все публичные методы возвращают Result<T, E>.
 * Исключения из Core оборачиваются в Result.
 */
export class PriceService {
  /**
   * Создаёт Price из значения
   *
   * @param value - Значение цены
   * @returns Result<Price, InvalidPriceError> с богатым контекстом
   *
   * @remarks
   * Внутри использует Price.of() (Core может кидать исключения).
   * Все исключения оборачиваются в Result.Err.
   *
   * @example
   * ```typescript
   * const result = PriceService.create(0.5);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.5
   * } else {
   *   console.error(result.error.context); // { value, originalMessage, originalName }
   * }
   * ```
   */
  public static create(value: number | string | Decimal): Result<Price, InvalidPriceError> {
    try {
      const price = Price.of(value);
      return Ok(price);
    } catch (error) {
      if (error instanceof Error) {
        return Err(
          new InvalidPriceError(
            (ctx) => `Failed to create Price: ${ctx.originalMessage}`,
            {
              code: InvalidPriceError.code,
              context: {
                value: String(value),
                originalMessage: error.message,
                originalName: error.name
              }
            }
          )
        );
      }
      throw error;
    }
  }

  /**
   * Вычисляет дополнение (1 - price)
   *
   * @param price - Цена
   * @returns Result<Price, InvalidPriceError>
   *
   * @remarks
   * Возвращает Result, т.к. результат вычисления может выйти за диапазон.
   * НЕ использует Price.of() напрямую - только через this.create().
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.3));
   * const result = PriceService.complement(price);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.7
   * }
   * ```
   */
  public static complement(price: Price): Result<Price, InvalidPriceError> {
    const one = new Decimal(1);
    const complementValue = subtractDecimal(one, price.value());
    return this.create(complementValue);
  }

  /**
   * Вычисляет среднюю цену
   *
   * @param price1 - Первая цена
   * @param price2 - Вторая цена
   * @returns Result<Price, InvalidPriceError>
   *
   * @remarks
   * Возвращает Result, т.к. результат вычисления может выйти за диапазон.
   * НЕ использует Price.of() напрямую - только через this.create().
   *
   * @example
   * ```typescript
   * const p1 = expectOk(PriceService.create(0.4));
   * const p2 = expectOk(PriceService.create(0.6));
   * const result = PriceService.average(p1, p2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.5
   * }
   * ```
   */
  public static average(price1: Price, price2: Price): Result<Price, InvalidPriceError> {
    const sum = addDecimal(price1.value(), price2.value());
    const avgValue = divideDecimal(sum, new Decimal(2));
    return this.create(avgValue);
  }

  /**
   * Умножает цену на коэффициент
   *
   * @param price - Цена
   * @param factor - Коэффициент (number | string | Decimal)
   * @returns Result<Price, InvalidPriceError>
   *
   * @remarks
   * Парсинг factor обёрнут в try/catch.
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * const result = PriceService.multiply(price, 1.5);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.75
   * }
   * ```
   */
  public static multiply(
    price: Price,
    factor: number | string | Decimal
  ): Result<Price, InvalidPriceError> {
    // Парсим factor с обработкой ошибок
    let factorDecimal: Decimal;
    try {
      factorDecimal = factor instanceof Decimal ? factor : new Decimal(factor);
    } catch (error) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid factor for multiplication: ${ctx.factor}`,
          {
            code: InvalidPriceError.code,
            context: {
              factor: String(factor),
              parseError: error instanceof Error ? error.message : 'unknown'
            }
          }
        )
      );
    }

    const result = multiplyDecimal(price.value(), factorDecimal);

    return this.create(result);
  }

  /**
   * Делит цену на делитель
   *
   * @param price - Цена
   * @param divisor - Делитель (number | string | Decimal)
   * @returns Result<Price, InvalidPriceError | DivisionByZeroError>
   *
   * @remarks
   * - Парсинг divisor обёрнут в try/catch
   * - Проверяет деление на 0 (если @polymarket/math не делает это)
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * const result = PriceService.divide(price, 2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.25
   * }
   * ```
   */
  public static divide(
    price: Price,
    divisor: number | string | Decimal
  ): Result<Price, InvalidPriceError | DivisionByZeroError> {
    // Парсим divisor с обработкой ошибок
    let divisorDecimal: Decimal;
    try {
      divisorDecimal = divisor instanceof Decimal ? divisor : new Decimal(divisor);
    } catch (error) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid divisor for division: ${ctx.divisor}`,
          {
            code: InvalidPriceError.code,
            context: {
              divisor: String(divisor),
              parseError: error instanceof Error ? error.message : 'unknown'
            }
          }
        )
      );
    }

    // Проверка деления на 0 (если @polymarket/math не делает это)
    if (divisorDecimal.isZero()) {
      return Err(
        new DivisionByZeroError(
          (ctx) => `Cannot divide price ${ctx.price} by zero`,
          {
            code: DivisionByZeroError.code,
            context: {
              price: price.value().toString(),
              divisor: '0'
            }
          }
        )
      );
    }

    const result = divideDecimal(price.value(), divisorDecimal);

    return this.create(result);
  }

  /**
   * Округляет цену до ближайшего тика
   *
   * @param price - Цена для округления
   * @param tickSize - Размер тика (number | string | Decimal)
   * @returns Result<Price, InvalidPriceError | InvalidTickSizeError>
   *
   * @remarks
   * НЕ требует что цена УЖЕ кратна тику.
   * Это функция ОКРУГЛЕНИЯ, а не валидации.
   *
   * Для проверки alignment используй ensureAlignedToMarketTick().
   *
   * ValidateTickSize возвращает нормализованный Decimal — БЕЗ двойного парсинга!
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.12345));
   * const result = PriceService.roundToMarketTick(price, 0.01);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.12
   * }
   * ```
   */
  public static roundToMarketTick(
    price: Price,
    tickSize: number | string | Decimal
  ): Result<Price, InvalidPriceError | InvalidTickSizeError> {
    // Валидируем tickSize и получаем нормализованный Decimal
    // ValidateTickSize возвращает Result<Decimal, ...> — без повторного парсинга!
    const tickResult = ValidateTickSize.check(tickSize);
    if (!tickResult.ok) {
      return Err(tickResult.error);
    }

    // Получаем готовый Decimal из Result
    const tickDecimal = tickResult.value;

    // Округляем (без проверки alignment!)
    const rounded = roundToTick(price.value(), tickDecimal);

    // Создаём Price из округлённого значения
    return this.create(rounded);
  }

  /**
   * Проверяет что цена УЖЕ выровнена по тику (aligned)
   *
   * @param price - Цена для проверки
   * @param tickSize - Размер тика (number | string | Decimal)
   * @returns Result<void, InvalidPriceError | InvalidTickSizeError>
   *
   * @remarks
   * Используется когда нужна валидация БЕЗ округления.
   * Например, перед отправкой ордера на биржу.
   *
   * Для округления используй roundToMarketTick().
   *
   * Делегирует всю логику ValidateAligned (который сам парсит и валидирует tickSize).
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * const result = PriceService.ensureAlignedToMarketTick(price, 0.0001);
   * if (result.ok) {
   *   // Цена кратна тику, можно отправлять ордер
   * } else {
   *   console.error('Price not aligned to tick');
   * }
   * ```
   */
  public static ensureAlignedToMarketTick(
    price: Price,
    tickSize: number | string | Decimal
  ): Result<void, InvalidPriceError | InvalidTickSizeError> {
    // Делегируем всю логику ValidateAligned
    // (ValidateAligned сам вызовет ValidateTickSize и сделает mod-проверку)
    return ValidateAligned.check(price, tickSize);
  }

  /**
   * Проверяет приблизительное равенство двух цен
   *
   * @param price1 - Первая цена
   * @param price2 - Вторая цена
   * @param epsilon - Погрешность (по умолчанию 0.0001, должен быть > 0)
   * @returns true если |price1 - price2| < epsilon, false если epsilon <= 0
   *
   * @remarks
   * Для строгого равенства используй price1.equals(price2).
   * Если epsilon <= 0, возвращает false (вместо бросания исключения).
   *
   * @example
   * ```typescript
   * const p1 = expectOk(PriceService.create(0.50001));
   * const p2 = expectOk(PriceService.create(0.50002));
   * const isApprox = PriceService.approximatelyEquals(p1, p2, new Decimal(0.0001));
   * console.log(isApprox); // true
   *
   * // При невалидном epsilon возвращает false
   * const invalid = PriceService.approximatelyEquals(p1, p2, new Decimal(0));
   * console.log(invalid); // false
   * ```
   */
  public static approximatelyEquals(
    price1: Price,
    price2: Price,
    epsilon: Decimal = new Decimal(0.0001)
  ): boolean {
    // Защита от невалидного epsilon
    if (epsilon.lessThanOrEqualTo(0)) {
      return false;
    }

    return price1.value().minus(price2.value()).abs().lessThan(epsilon);
  }
}
```

---

#### **Adapters Layer**

**Файл:** `adapters/PriceSerializer.ts`

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { Price } from '../core/Price.js';
import { InvalidPriceError } from '@polymarket/errors';
import { PriceService } from '../facade/PriceService.js';

/**
 * Сериализация Price в/из JSON
 *
 * @remarks
 * Поддерживает формат: { value: number }
 */
export class PriceSerializer {
  /**
   * Сериализует Price в JSON
   *
   * @param price - Цена
   * @returns JSON объект { value: number }
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * const json = PriceSerializer.toJSON(price);
   * console.log(json); // { value: 0.5 }
   * ```
   */
  public static toJSON(price: Price): { value: number } {
    return { value: price.toNumber() };
  }

  /**
   * Десериализует Price из JSON
   *
   * @param json - JSON объект
   * @returns Result<Price, InvalidPriceError>
   *
   * @remarks
   * Валидирует структуру JSON:
   * - Проверяет что json?.value существует
   * - Проверяет что тип value - number или string
   * - Возвращает ошибку с кодом "invalid_json" при проблемах
   *
   * @example
   * ```typescript
   * const result = PriceSerializer.fromJSON({ value: 0.5 });
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.5
   * } else {
   *   console.error(result.error.context);
   * }
   * ```
   */
  public static fromJSON(json: unknown): Result<Price, InvalidPriceError> {
    // Валидация 1: Проверяем что json - объект
    if (typeof json !== 'object' || json === null) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid JSON structure: expected object, got ${ctx.type}`,
          {
            code: 'invalid_json',
            context: {
              type: typeof json,
              json: String(json)
            }
          }
        )
      );
    }

    // Валидация 2: Проверяем что поле value существует
    const jsonObj = json as Record<string, unknown>;
    if (!('value' in jsonObj)) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid JSON structure: missing field "value"`,
          {
            code: 'invalid_json',
            context: {
              json: JSON.stringify(json),
              availableFields: Object.keys(jsonObj).join(', ')
            }
          }
        )
      );
    }

    // Валидация 3: Проверяем тип value
    const value = jsonObj.value;
    if (typeof value !== 'number' && typeof value !== 'string') {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid JSON structure: field "value" must be number or string, got ${ctx.type}`,
          {
            code: 'invalid_json',
            context: {
              type: typeof value,
              value: String(value)
            }
          }
        )
      );
    }

    // Создаём Price через PriceService
    return PriceService.create(value);
  }
}
```

**Файл:** `adapters/PriceFormatter.ts`

```typescript
import { Price } from '../core/Price.js';

/**
 * Форматирование Price в строки
 *
 * @remarks
 * Работает только с Price, не с Decimal.
 */
export class PriceFormatter {
  /**
   * Форматирует цену в строку с фиксированным числом знаков
   *
   * @param price - Цена
   * @param decimals - Количество знаков после запятой (по умолчанию 4)
   * @returns Строка формата "0.5000"
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * console.log(PriceFormatter.toString(price)); // "0.5000"
   * console.log(PriceFormatter.toString(price, 2)); // "0.50"
   * ```
   */
  public static toString(price: Price, decimals: number = 4): string {
    return price.value().toFixed(decimals);
  }

  /**
   * Форматирует цену в проценты
   *
   * @param price - Цена
   * @returns Строка формата "50.00%"
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * console.log(PriceFormatter.toPercentage(price)); // "50.00%"
   * ```
   */
  public static toPercentage(price: Price): string {
    const percent = price.value().times(100);
    return `${percent.toFixed(2)}%`;
  }

  /**
   * Форматирует цену для отладки
   *
   * @param price - Цена
   * @returns Строка формата "Price(0.5)"
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * console.log(PriceFormatter.toDebugString(price)); // "Price(0.5)"
   * ```
   */
  public static toDebugString(price: Price): string {
    return `Price(${price.value().toString()})`;
  }
}
```

---

## Детальный план по фазам

### Фаза 0: Подготовка (15 минут)

**Цель:** Создать структуру директорий.

**Команды:**
```bash
cd packages/domain/value-objects/src
mkdir -p price/core
mkdir -p price/rules
mkdir -p price/facade
mkdir -p price/adapters
```

**Результат:**
- ✅ Структура директорий создана (без policy/)
- ✅ Готово к началу реализации

---

### Фаза 1: Core Layer (20 минут)

**Файлы:**
- `price/core/Price.ts` - Core VO
- `price/core/index.ts` - Экспорты

**Ключевые изменения согласно критике:**
1. ✅ Константы как функции `min()`, `max()`, `half()` вместо синглтонов
2. ✅ `equals()` без epsilon - только строгое равенство
3. ✅ Явная проверка `isNaN()` в инвариантах
4. ✅ Удалены методы `toTick`, `floor`, `ceil`, `round`, `complement`, `multiply`, `divide`, `lessThan`, `greaterThan`

**Реализация:** См. секцию "Core Layer" выше для полного кода.

**Тесты:** `__tests__/unit/price/core/Price.test.ts`

**Тест-кейсы:**
1. Создание Price из number/string/Decimal
2. Инварианты: NaN, Infinity, отрицательные, < MIN, > MAX
3. Константы: `min()`, `max()`, `half()` возвращают корректные значения
4. **`minValue()`, `maxValue()` возвращают Decimal (не создают Price)**
5. **`minValue()` возвращает тот же Decimal что и `min().value()`**
6. **`maxValue()` возвращает тот же Decimal что и `max().value()`**
7. `equals()` - строгое равенство (без epsilon!)
8. `isMin()`, `isMax()` работают корректно
9. `value()`, `toNumber()` возвращают корректные значения
10. PriceInvariantViolation содержит корректное сообщение

**Итого:** ~22 теста (было 20)

---

### Фаза 2: Rules Layer (30 минут)

**Файлы:**
- `price/rules/types.ts` - типизация стандартизированных ошибок (ErrorContext, *ErrorReason)
- `price/rules/ValidateTickSize.ts` - валидация tickSize
- `price/rules/ValidateSpread.ts` - валидация spread между bid/ask
- `price/rules/ValidateAligned.ts` - проверка что цена кратна tickSize
- `price/rules/index.ts` - экспорты

**Ключевые изменения согласно критике:**
1. ✅ `ValidateTickSize.check()` принимает `number | string | Decimal` (удобно на границе)
2. ✅ Никаких магических чисел `0.9998` - используем `Price.maxValue().minus(Price.minValue())`
3. ✅ `ValidateSpread.check()` принимает `Price`, а не `Decimal`
4. ✅ Добавлен `ValidateAligned` для проверки alignment (было в MarketPricePolicy)
5. ✅ Все ошибки ValidateSpread стандартизированы (field + reason)
6. ✅ Типизация ошибок через ErrorContext и *ErrorReason unions

**Реализация:** См. секцию "Rules Layer" выше для полного кода.

**Тесты:** `__tests__/unit/price/rules/*.test.ts`

**Тест-кейсы для ValidateTickSize:**
1. Валидный tickSize (0.0001, 0.01, 0.1) - **проверяем что возвращается Decimal**
2. Невалидный: NaN, Infinity, отрицательный, 0
3. **Ошибка парсинга: "abc", null, undefined**
4. **Проверяем что возвращённый Decimal равен входному значению (без потери точности)**
5. **При too-large tickSize ошибка содержит context.maxAllowed/minPrice/maxPrice**
6. **Граничный случай: вычисляем `maxAllowed = Price.maxValue().minus(Price.minValue())`, проверяем `tickSize == maxAllowed → Ok`**
7. **Граничный случай: `tickSize == maxAllowed.plus(0.0001) → Err`**
8. Граничные значения

**Тест-кейсы для ValidateSpread:**
1. Валидный spread (ask >= bid, spread >= minSpread)
2. **Невалидный: ask < bid → проверяем field: "ask", reason: "ask_lt_bid"**
3. **Невалидный: spread < minSpread → проверяем field: "spread", reason: "lt_min_spread"**
4. **Ошибка парсинга minSpread: "abc", null → field: "minSpread", reason: "parse_error"**
5. **Невалидный minSpread: NaN → field: "minSpread", reason: "is_nan"**
6. **Невалидный minSpread: Infinity → field: "minSpread", reason: "not_finite"**
7. **Невалидный minSpread: отрицательный → field: "minSpread", reason: "negative"**
8. **minSpread принимает number/string/Decimal**
9. **ВСЕ ошибки содержат field + reason (проверяем наличие полей во всех Err)**
10. **reason соответствует типу SpreadErrorReason (типобезопасность)**
11. Граничные значения

**Важно:** ВСЕ ошибки должны содержать стандартизированные field + reason для упрощения обработки.

**Тест-кейсы для ValidateAligned:**
1. Цена кратна tickSize (0.5 % 0.0001 === 0) - строгая проверка mod().isZero()
2. Цена НЕ кратна tickSize (0.12345 % 0.01 !== 0)
3. **При валидном tickSize не возвращает InvalidTickSizeError**
4. **При невалидном tickSize возвращает ровно ошибку от ValidateTickSize**
5. **При валидном tickSize, но некратной цене — возвращает InvalidPriceError (не InvalidTickSizeError)**
6. Граничные значения (MIN, MAX)

**Итого:** ~26 тестов (было 22)

---

### Фаза 3: Facade Layer (40 минут)

**Файлы:**
- `price/facade/PriceService.ts` - главный фасад
- `price/facade/index.ts` - экспорты

**Ключевые изменения согласно критике:**
1. ✅ `create()` возвращает богатый контекст (value, originalMessage, originalName)
2. ✅ `multiply()` и `divide()` симметричны - принимают `number | string | Decimal`
3. ✅ `divide()` ловит деление на 0 (если @polymarket/math не делает)
4. ✅ `roundToMarketTick()` НЕ требует alignment - это функция округления!
5. ✅ Добавлен `ensureAlignedToMarketTick()` для валидации без округления
6. ✅ Добавлен `approximatelyEquals()` для approximate equality с epsilon

**Реализация:** См. секцию "Facade Layer" выше для полного кода.

**Тесты:** `__tests__/unit/price/facade/*.test.ts`

**Тест-кейсы:**
1. `create()`: успех и ошибки с богатым контекстом (value, originalMessage, originalName)
2. **`complement()`: возвращает Result, проверяем ok и error случаи**
3. **`average()`: возвращает Result, проверяем ok и error случаи**
4. **`multiply()`: ошибки парсинга factor ("abc", null)**
5. **`divide()`: ошибки парсинга divisor, деление на 0**
6. `roundToMarketTick()`: округление БЕЗ проверки alignment, ошибки парсинга tickSize
7. `ensureAlignedToMarketTick()`: делегирует ValidateAligned, проверяем все Result paths
8. **`approximatelyEquals()`: approximate equality с epsilon**
   - **Валидный epsilon > 0**
   - **Невалидный epsilon <= 0 → возвращает false**
   - **Невалидный epsilon отрицательный → возвращает false**

**Акцент на тестировании:**
- Все публичные методы возвращают Result (кроме approximatelyEquals)
- Все парсинги Decimal обёрнуты в try/catch
- НЕТ вызовов Price.of() в публичных методах (только this.create())
- approximatelyEquals защищён от epsilon <= 0

**Итого:** ~37 тестов (было 35)

---

### Фаза 4: Adapters Layer (15 минут)

**Файлы:**
- `price/adapters/PriceSerializer.ts` - JSON сериализация
- `price/adapters/PriceFormatter.ts` - форматирование в строки
- `price/adapters/index.ts` - экспорты

**Ключевые изменения согласно критике:**
1. ✅ `fromJSON()` валидирует структуру (json?.value существует, тип number/string)
2. ✅ Ошибки с кодом `invalid_json` при проблемах структуры

**Реализация:** См. секцию "Adapters Layer" выше для полного кода.

**Тесты:** `__tests__/unit/price/adapters/*.test.ts`

**Тест-кейсы для PriceSerializer:**
1. `toJSON()`: корректная сериализация
2. `fromJSON()`: успешная десериализация валидного JSON
3. `fromJSON()`: ошибка при отсутствии поля `value`
4. `fromJSON()`: ошибка при невалидном типе `value`
5. `fromJSON()`: ошибка при null/undefined JSON
6. `fromJSON()`: ошибка при primitive вместо объекта

**Тест-кейсы для PriceFormatter:**
1. `toString()`: форматирование с разным количеством decimals
2. `toPercentage()`: форматирование в проценты
3. `toDebugString()`: отладочная строка

**Итого:** ~12 тестов

---

### Фаза 5: Главный index.ts (10 минут)

**Файл:** `price/index.ts`

```typescript
// Core
export { Price, PriceInvariantViolation } from './core/index.js';

// Facade (главная точка входа)
export { PriceService } from './facade/index.js';

// Adapters
export { PriceSerializer, PriceFormatter } from './adapters/index.js';

// Rules (для advanced use cases)
export { ValidateTickSize, ValidateSpread, ValidateAligned } from './rules/index.js';

// Типизация ошибок (для type-safe обработки)
export type {
  ErrorContext,
  TickSizeErrorReason,
  SpreadErrorReason,
  AlignedErrorReason
} from './rules/types.js';
```

**Изменения:**
- ❌ Удалён экспорт `MarketPricePolicy` (policy/ больше нет)
- ✅ Добавлен экспорт `ValidateAligned`

---

### Фаза 6: Integration тесты (30 минут)

**Файл:** `__tests__/integration/price/PriceWorkflow.integration.test.ts`

**Сценарии:**
1. **Создание → округление → alignment:**
   - Создать Price из строки
   - Округлить до тика через `roundToMarketTick()`
   - Проверить alignment через `ensureAlignedToMarketTick()`

2. **Complement → average → approximate equality:**
   - Создать две цены
   - Вычислить complement
   - Вычислить среднее
   - Проверить approximate equality (не strict!)

3. **Multiply → divide → проверка диапазона:**
   - Умножить цену на коэффициент
   - Разделить на делитель
   - Проверить что результат в диапазоне [MIN, MAX]
   - Проверить ошибку при выходе за диапазон

4. **Сериализация → десериализация → equality:**
   - Создать Price
   - Сериализовать в JSON
   - Десериализовать обратно
   - Проверить строгое равенство (`equals()`)

5. **Форматирование в разных форматах:**
   - toString с разным decimals
   - toPercentage
   - toDebugString

6. **Валидация spread между bid/ask:**
   - Создать bid и ask цены
   - Проверить ValidateSpread
   - Проверить ошибку при ask < bid

**Итого:** ~15 интеграционных тестов

---

### Фаза 7: Обновить package.json exports (5 минут)

**Файл:** `packages/domain/value-objects/package.json`

```json
{
  "exports": {
    "./price": {
      "types": "./dist/price/index.d.ts",
      "import": "./dist/price/index.js"
    },
    "./price/core": {
      "types": "./dist/price/core/index.d.ts",
      "import": "./dist/price/core/index.js"
    }
  }
}
```

---

## План тестирования

### Суммарная статистика

**Изменения после критики (финальная итерация):**
- ❌ Policy Layer удалён (был: 10 тестов)
- ✅ Rules Layer расширен ValidateAligned + ValidateSpread field/reason + контракты (+13 тестов)
- ✅ Facade Layer: все методы → Result, approximatelyEquals защита (+12 тестов)
- ✅ Adapters Layer расширен валидацией (+2 теста)
- ✅ Core Layer: +minValue/maxValue тесты (+2 теста)

| Слой | Unit тестов | Integration | Комментарий |
|------|-------------|-------------|-------------|
| Core | 22 | - | +isNaN, +min/max/half/minValue/maxValue, -epsilon (было 20) |
| Rules | 27 | - | +ValidateSpread field/reason для всех ошибок, +контракты (было 15) |
| Facade | 37 | - | ВСЕ методы → Result, +approximatelyEquals защита (было 25) |
| Adapters | 12 | - | +JSON валидация (было 10) |
| **Integration** | - | 15 | +alignment workflow, +Result chains, +проверяемые утверждения |
| **Итого** | **98** | **15** | |
| **ВСЕГО** | **113 тестов** | | **+18 тестов после финальной итерации** |

### Coverage Target

- **Branches:** 100%
- **Functions:** 100%
- **Lines:** 100%
- **Statements:** 100%

**Важно:** Все правила из секции "Архитектурные правила" должны быть покрыты тестами.

---

## План документации

### Файлы документации

1. **`price/README.md`** - Обзор архитектуры Price
2. **`price/docs/architecture.md`** - Детали слоёв
3. **`price/docs/migration-guide.md`** - Гайд по миграции
4. **`price/docs/examples.md`** - Примеры использования

---

## Миграция

### Breaking Changes

**API Changes:**
```typescript
// Было:
const price = Price.fromValue(0.5);
const complement = price.complement();
const avg = price.average(other);

// Стало:
const priceResult = PriceService.create(0.5);
if (!priceResult.ok) { /* handle error */ }
const price = priceResult.value;

const complementResult = PriceService.complement(price);
const avgResult = PriceService.average(price, other);
```

**Ключевые изменения:**
1. Все методы создания/математики теперь возвращают `Result<Price, Error>`
2. Методы перенесены из инстанс-методов Price в статические методы PriceService
3. `Price.of()` остаётся только для internal использования в Core
4. Публичное API использует `PriceService.create()`

**Стратегия миграции:**
- Вручную заменить вызовы методов с проверкой Result
- НЕ использовать автоматические sed-скрипты (опасно для импортов)

---

## Timeline

**Обновлённый timeline после критики (4 итерации):**

| Фаза | Время | Изменения |
|------|-------|-----------|
| 0. Подготовка | 15 мин | -policy/ директория |
| 1. Core | 30 мин | +isNaN, +min/max/half/minValue/maxValue, -epsilon |
| 2. Rules | 45 мин | +ValidateTickSize → Result<Decimal>, +ValidateSpread minSpread, +импорты |
| 3. Facade | 55 мин | ВСЕ методы → Result, БЕЗ двойного парсинга tickSize |
| 4. Adapters | 20 мин | +JSON валидация |
| 5. Index | 10 мин | -policy exports |
| 6. Integration | 40 мин | +alignment workflow, +Result chains, +проверяемые утверждения |
| 7. Exports | 5 мин | без изменений |
| **Итого** | **~3.7 часа** | **+42 мин** |

**Изменения после четвертой критики:**
- ❌ Удалена Фаза 3 (Policy Layer) - экономия 20 мин
- ✅ Core: +5 мин на minValue()/maxValue() (было 25, стало 30)
- ✅ Rules: +10 мин на ValidateTickSize → Result<Decimal> + ValidateSpread minSpread + импорты (было 35, стало 45)
- ✅ Facade: +10 мин на Result для всех методов, БЕЗ двойного парсинга (было 45, стало 55)
- ✅ Integration: +5 мин на проверяемые утверждения вместо "нет двойного парсинга" (было 35, стало 40)
- ✅ Общее время: ~3.7 часа (+42 мин за счёт строгой обработки, оптимизаций и корректных тестов)

---

**Конец плана для Price**

---

## Чеклист соответствия критике

Перед началом реализации убедись что план соответствует всем правилам:

### Архитектурные правила (критические)
- [x] **Правило 1:** Core не делает approximate-equality ✅
- [x] **Правило 2:** Rules/Policy работают с Price ✅
- [x] **Правило 3:** roundToMarketTick() не требует alignment ✅
- [x] **Правило 4:** Исключения остаются в Core, всё наружу — Result ✅
  - [x] ВСЕ публичные методы PriceService возвращают Result (включая complement, average)
  - [x] Никаких Price.of() в публичных методах — только this.create()
  - [x] Все парсинги new Decimal() обёрнуты в try/catch → Result.Err
- [x] **Правило 5:** Никаких магических чисел (0.9998) ✅
- [x] **Правило 6:** Никаких epsilon в проверках alignment ✅
  - [x] ValidateAligned использует mod().isZero() — строго, без приближений
  - [x] Epsilon только в approximatelyEquals()

### Детальные проверки
- [x] Core: константы min()/max()/half() создают новый объект каждый раз ✅
- [x] **Core: добавлены minValue()/maxValue() для доступа к Decimal без создания Price** ✅
- [x] ValidateTickSize: парсинг tickSize обёрнут в try/catch ✅
- [x] **ValidateTickSize: возвращает Result<Decimal, ...> (не void) - избегаем двойного парсинга** ✅
- [x] **ValidateTickSize: использует Price.minValue()/maxValue() вместо создания Price-объектов** ✅
- [x] ValidateSpread: парсинг minSpread обёрнут в try/catch ✅
- [x] **ValidateSpread: принимает minSpread: number|string|Decimal (консистентность)** ✅
- [x] **ValidateSpread: валидирует minSpread (NaN, Infinity, negative)** ✅
- [x] **ValidateSpread: ВСЕ ошибки содержат field + reason (minSpread, ask, spread)** ✅
- [x] **Rules: типизация ошибок через ErrorContext и *ErrorReason unions** ✅
- [x] **ValidateAligned: убран избыточный .abs() после mod()** ✅
- [x] **ValidateAligned: импорты ValidateTickSize и InvalidTickSizeError** ✅
- [x] ValidateAligned: вызывает ValidateTickSize внутри ✅
- [x] **ValidateAligned: получает готовый Decimal из ValidateTickSize.check().value** ✅
- [x] **ValidateAligned: НЕ парсит tickSize повторно (нет new Decimal)** ✅
- [x] ValidateAligned: использует mod() без epsilon ✅
- [x] PriceService.complement(): возвращает Result ✅
- [x] PriceService.average(): возвращает Result ✅
- [x] PriceService.multiply(): парсинг factor в try/catch ✅
- [x] PriceService.divide(): парсинг divisor в try/catch ✅
- [x] **PriceService.roundToMarketTick(): получает готовый Decimal из ValidateTickSize.check().value** ✅
- [x] **PriceService.roundToMarketTick(): НЕ парсит tickSize повторно** ✅
- [x] PriceService.ensureAlignedToMarketTick(): делегирует ValidateAligned ✅
- [x] **PriceService.approximatelyEquals(): защита от epsilon <= 0 (возвращает false)** ✅
- [x] **Все примеры/тесты вне Core: Price.of() заменён на expectOk(PriceService.create())** ✅
- [x] **Все упоминания Price.max().value().minus() заменены на Price.maxValue().minus()** ✅
- [x] **Тест-план: убраны магические числа (0.9998), вычисляется maxAllowed динамически** ✅
- [x] **Core constants: точная формулировка про Decimal sharing** ✅
- [x] **Правило 4 переписано: парсинг в одном месте, не "везде try/catch"** ✅
- [x] **Правило 5 исправлено: Price.maxValue().minus(Price.minValue())** ✅
- [x] **Тест-план: убраны непроверяемые утверждения про "нет двойного парсинга"** ✅
- [x] **Тест-план: добавлены проверяемые контракты (error context, границы)** ✅
- [x] **Миграция: убран опасный sed-скрипт, описаны breaking changes** ✅

**План полностью адаптирован согласно критике (финальная итерация + 4 правки).**

**Обязательные правки выполнены:**
1. ✅ **Тест-кейсы ValidateTickSize:** убраны магические числа (0.9998), maxAllowed вычисляется динамически
2. ✅ **Core constants:** точная формулировка "Decimal константы шарятся как иммутабельные значения"
3. ✅ **ValidateAligned:** убран избыточный `.abs()` после `mod()` (для положительных чисел)
4. ✅ **Standardized errors:** типизация через ErrorContext и *ErrorReason unions (rules/types.ts)

**Предыдущие правки:**
5. ✅ Правило 5 исправлено: везде Price.maxValue().minus(Price.minValue())
6. ✅ ValidateTickSize тест-план: удалено "не создаются Price-объекты", добавлены проверяемые контракты
7. ✅ ValidateSpread: ВСЕ ошибки стандартизированы (field + reason для minSpread/ask/spread)
8. ✅ Core constants: упрощена аргументация про referential equality
9. ✅ approximatelyEquals: защита от epsilon <= 0 (возвращает false)

**Финальная проверка пройдена:**
- ✅ Все Price.of() вне Core заменены на expectOk(PriceService.create())
- ✅ ValidateAligned компилируется (добавлены импорты)
- ✅ ValidateSpread ошибки полностью стандартизированы (field + reason + типизация)
- ✅ Правило 4 про парсинг переписано корректно
- ✅ Правило 5 исправлено (maxValue/minValue везде, включая тесты)
- ✅ Тест-план содержит только проверяемые контракты (без магических чисел)
- ✅ Price.minValue()/maxValue() добавлены и используются
- ✅ approximatelyEquals защищён от epsilon <= 0
- ✅ ValidateAligned без избыточного .abs()
- ✅ Типизация ошибок: ErrorContext + *ErrorReason unions
- ✅ Миграция описана без опасных sed-скриптов

**План готов к реализации.**
