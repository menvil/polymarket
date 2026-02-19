# Spread Core Layer

> Детали доменной модели и инвариантов

## Содержание

1. [Обзор](#обзор)
2. [Класс Spread](#класс-spread)
3. [Инварианты](#инварианты)
4. [Методы](#методы)
5. [SpreadInvariantViolation](#spreadinvariantviolation)
6. [SpreadErrorReason](#spreaderrorreason)

---

## Обзор

Core слой содержит чистую доменную логику без знания о Result<T, E> или внешних интеграциях.

**Файлы:**

- `Spread.ts` — основной Value Object
- `SpreadInvariantViolation.ts` — typed exception
- `SpreadErrorReason.ts` — enum причин ошибок (расположен в `src/spread/errors/`, не в Core)

**Принципы:**

- ✅ Иммутабельность
- ✅ Throwing typed exceptions
- ✅ Чистые функции
- ✅ Нулевые зависимости (кроме Price и Decimal.js)

---

## Класс Spread

### Определение

```typescript
export class Spread {
  private constructor(
    private readonly _bid: Price,
    private readonly _ask: Price
  ) {
    // Инвариант: bid <= ask
    if (_bid.value().greaterThan(_ask.value())) {
      throw new SpreadInvariantViolation(
        `bid ${_bid.value()} cannot be greater than ask ${_ask.value()}`,
        SpreadErrorReason.BID_GREATER_THAN_ASK
      );
    }
  }

  /**
   * Создаёт спред из Price объектов
   * 
   * @throws {SpreadInvariantViolation} если bid > ask
   */
  static of(bid: Price, ask: Price): Spread {
    return new Spread(bid, ask);
  }

  /**
   * Создаёт спред нулевой ширины (bid === ask)
   */
  static zero(price: Price): Spread {
    return new Spread(price, price);
  }

  // ... методы
}
```

### Свойства

| Свойство | Тип | Описание |
| ---------- | ----- | ---------- |
| `_bid` | `Price` | Цена покупки (private, readonly) |
| `_ask` | `Price` | Цена продажи (private, readonly) |

**Примечание:** Свойства приватные. Доступ только через геттеры.

---

## Инварианты

### 1. Bid ≤ Ask

**Инвариант:** `bid.value() <= ask.value()`

**Проверка:** В конструкторе

**Исключение:** `SpreadInvariantViolation` с `SpreadErrorReason.BID_GREATER_THAN_ASK`

```typescript
// ✅ Ok
Spread.of(Price.of(new Decimal(0.48)), Price.of(new Decimal(0.52)));

// ✅ Ok (нулевая ширина)
Spread.of(Price.of(new Decimal(0.50)), Price.of(new Decimal(0.50)));

// ❌ Throws
Spread.of(Price.of(new Decimal(0.60)), Price.of(new Decimal(0.50)));
// SpreadInvariantViolation: bid 0.6 cannot be greater than ask 0.5
```

### 2. Валидность Price объектов

**Инвариант:** Bid и Ask должны быть валидными Price объектами [0.0001, 0.9999]

**Гарантируется:** Делегировано Price классу

```typescript
// Price уже валидирует диапазон при создании
const price = Price.of(new Decimal(1.5));  // Throws PriceInvariantViolation

// Поэтому Spread не может получить невалидный Price
```

---

## Методы

### Фабричные методы

#### `of(bid, ask)`

```typescript
static of(bid: Price, ask: Price): Spread
```

Создаёт спред из Price объектов.

**Throws:** `SpreadInvariantViolation` если bid > ask

**Пример:**

```typescript
const bid = Price.of(new Decimal(0.48));
const ask = Price.of(new Decimal(0.52));

const spread = Spread.of(bid, ask);
```

#### `zero(price)`

```typescript
static zero(price: Price): Spread
```

Создаёт спред нулевой ширины (bid === ask).

**Не бросает исключений** (инвариант автоматически выполнен).

**Пример:**

```typescript
const price = Price.of(new Decimal(0.50));
const spread = Spread.zero(price);

console.log(spread.isZeroWidth());  // true
console.log(spread.width().toNumber());  // 0
```

---

### Геттеры

#### `bid()`

```typescript
bid(): Price
```

Возвращает bid цену.

**Пример:**

```typescript
const spread = Spread.of(...);
const bidPrice = spread.bid();
console.log(bidPrice.toNumber());  // 0.48
```

#### `ask()`

```typescript
ask(): Price
```

Возвращает ask цену.

**Пример:**

```typescript
const spread = Spread.of(...);
const askPrice = spread.ask();
console.log(askPrice.toNumber());  // 0.52
```

---

### Вычисляемые свойства

#### `width()`

```typescript
width(): Decimal
```

Возвращает ширину спреда (ask - bid).

**Формула:** `ask.value() - bid.value()`

**Пример:**

```typescript
const spread = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.52))
);

console.log(spread.width().toNumber());  // 0.04
```

#### `midpoint()`

```typescript
midpoint(): Decimal
```

Возвращает середину спреда (mid price).

**Формула:** `(bid.value() + ask.value()) / 2`

**Пример:**

```typescript
const spread = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.52))
);

console.log(spread.midpoint().toNumber());  // 0.50
```

#### `mid()`

```typescript
mid(): Decimal
```

Возвращает середину спреда (mid price).

**Формула:** `(bid.value() + ask.value()) / 2`

**Псевдоним:** `midpoint()` — устаревший алиас, `mid()` предпочтительный метод.

**Пример:**

```typescript
const spread = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.52))
);

console.log(spread.mid().toNumber());  // 0.50
```

#### `widthRatio()`

```typescript
widthRatio(): Ratio
```

Возвращает относительную ширину спреда как дробь от midpoint.

**Формула:** `width / midpoint` (дробь, не процент)

**Пример:**

```typescript
const spread = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.52))
);

console.log(spread.widthRatio().toNumber());                       // 0.08 (дробь)
console.log(spread.widthRatio().toDecimal().times(100).toNumber()); // 8   (процент)
// 0.04 / 0.50 = 0.08 (8% как дробь); widthInBasisPoints() → 400 bps (0.04 × 10000)
```

#### `widthInBasisPoints()`

```typescript
widthInBasisPoints(): Decimal
```

Возвращает ширину спреда в базисных пунктах (basis points).

**Формула:** `width × 10000` (абсолютная ширина, не относительная)

**Примечание:** 1 basis point = 0.0001 в ценовых единицах.

**Пример:**

```typescript
const spread = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.52))
);

// Ширина = 0.04; 0.04 × 10000 = 400 bps
console.log(spread.widthInBasisPoints().toNumber());  // 400
console.log(spread.widthInBasisPoints().toFixed(0));  // '400'
```

---

### Утилиты

#### `equals(other)`

```typescript
equals(other: Spread): boolean
```

Проверяет равенство двух спредов (bid и ask совпадают).

**Строгое сравнение:**

- Использует **точное** сравнение значений через `Decimal.equals()`
- **НЕ** использует epsilon или приближенные сравнения
- Bid и Ask должны совпадать **полностью** до последнего знака

**Пример:**

```typescript
const spread1 = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.52))
);

const spread2 = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.52))
);

console.log(spread1.equals(spread2));  // true (точное совпадение)
console.log(spread1 === spread2);      // false (разные объекты)

// Приближенное совпадение НЕ считается равенством
const spread3 = Spread.of(
  Price.of(new Decimal(0.48000001)),
  Price.of(new Decimal(0.52))
);
console.log(spread1.equals(spread3));  // false (не точное совпадение)
```

#### `isZeroWidth()`

```typescript
isZeroWidth(): boolean
```

Проверяет, является ли спред нулевой ширины (bid === ask).

**Пример:**

```typescript
const spread1 = Spread.zero(Price.of(new Decimal(0.50)));
console.log(spread1.isZeroWidth());  // true

const spread2 = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.52))
);
console.log(spread2.isZeroWidth());  // false
```

#### `contains(price)`

```typescript
contains(price: Price): boolean
```

Проверяет, находится ли цена внутри спреда (bid ≤ price ≤ ask).

**Пример:**

```typescript
const spread = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.52))
);

console.log(spread.contains(Price.of(new Decimal(0.50))));  // true
console.log(spread.contains(Price.of(new Decimal(0.48))));  // true (граница)
console.log(spread.contains(Price.of(new Decimal(0.45))));  // false
console.log(spread.contains(Price.of(new Decimal(0.55))));  // false
```

#### `overlaps(other)`

```typescript
overlaps(other: Spread): boolean
```

Проверяет, пересекаются ли два спреда (имеют ли общий диапазон цен).

**Условие:** `this.bid ≤ other.ask && other.bid ≤ this.ask`

**Пример:**

```typescript
const spread1 = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.55))
);
const spread2 = Spread.of(
  Price.of(new Decimal(0.52)),
  Price.of(new Decimal(0.60))
);
const spread3 = Spread.of(
  Price.of(new Decimal(0.60)),
  Price.of(new Decimal(0.70))
);

console.log(spread1.overlaps(spread2));  // true (пересекаются в 0.52-0.55)
console.log(spread1.overlaps(spread3));  // false (не пересекаются)
```

#### `containsSpread(other)`

```typescript
containsSpread(other: Spread): boolean
```

Проверяет, входит ли один спред полностью в другой (other внутри this).

**Условие:** `this.bid ≤ other.bid && other.ask ≤ this.ask`

**Пример:**

```typescript
const outer = Spread.of(
  Price.of(new Decimal(0.46)),
  Price.of(new Decimal(0.54))
);
const inner = Spread.of(
  Price.of(new Decimal(0.48)),
  Price.of(new Decimal(0.52))
);

console.log(outer.containsSpread(inner));  // true (inner внутри outer)
console.log(inner.containsSpread(outer));  // false (outer не входит в inner)
```

---

## SpreadInvariantViolation

### Определение

```typescript
export class SpreadInvariantViolation extends Error {
  public readonly reason: SpreadErrorReason;

  constructor(message: string, reason: SpreadErrorReason) {
    super(`Spread invariant violation: ${message}`);
    this.name = 'SpreadInvariantViolation';
    this.reason = reason;
  }
}
```

### Использование

**Бросается:** Core слоем при нарушении инвариантов

**Ловится:** Facade слоем и оборачивается в `InvalidSpreadError` с `Result<T, E>`

**Пример:**

```typescript
try {
  const spread = Spread.of(
    Price.of(new Decimal(0.60)),
    Price.of(new Decimal(0.50))
  );
} catch (error) {
  if (error instanceof SpreadInvariantViolation) {
    console.log(error.message);
    // "Spread invariant violation: bid 0.6 cannot be greater than ask 0.5"
    
    console.log(error.reason);
    // SpreadErrorReason.BID_GREATER_THAN_ASK
  }
}
```

---

## SpreadErrorReason

### Enum

```typescript
export enum SpreadErrorReason {
  // Инварианты Core
  BID_GREATER_THAN_ASK = 'BID_GREATER_THAN_ASK',

  // Валидация входных данных (Facade)
  INVALID_FORMAT = 'INVALID_FORMAT',
  INVALID_AMOUNT = 'INVALID_AMOUNT',
  INVALID_WIDTH = 'INVALID_WIDTH',

  // Валидация Rules
  WIDTH_TOO_SMALL = 'WIDTH_TOO_SMALL',
  WIDTH_TOO_LARGE = 'WIDTH_TOO_LARGE',

  // Операции Facade
  OPERATION_OUT_OF_BOUNDS = 'OPERATION_OUT_OF_BOUNDS',

  // Ratio операции
  MID_UNAVAILABLE = 'MID_UNAVAILABLE',
  INVALID_RATIO = 'INVALID_RATIO',
  NEGATIVE_RATIO_NOT_ALLOWED = 'NEGATIVE_RATIO_NOT_ALLOWED',
  RATIO_OUT_OF_BOUNDS = 'RATIO_OUT_OF_BOUNDS',

  // Сериализация (Adapters)
  INVALID_JSON = 'INVALID_JSON',
  INVALID_DTO = 'INVALID_DTO'
}
```

### Описание причин

| Причина | Слой | Описание |
| --------- | ------ | ---------- |
| `BID_GREATER_THAN_ASK` | Core | bid > ask |
| `INVALID_FORMAT` | Facade | Невалидный формат входных данных |
| `INVALID_AMOUNT` | Facade | Невалидный amount в операциях |
| `INVALID_WIDTH` | Facade / Rules | Невалидная ширина спреда (config validation в ValidateMinWidth/ValidateMaxWidth) |
| `WIDTH_TOO_SMALL` | Rules | Ширина спреда меньше минимальной |
| `WIDTH_TOO_LARGE` | Rules | Ширина спреда больше максимальной |
| `OPERATION_OUT_OF_BOUNDS` | Facade | Операция выходит за допустимые пределы |
| `MID_UNAVAILABLE` | Facade | Midpoint недоступен |
| `INVALID_RATIO` | Facade | Невалидный Ratio |
| `NEGATIVE_RATIO_NOT_ALLOWED` | Facade | Отрицательный Ratio не разрешён |
| `RATIO_OUT_OF_BOUNDS` | Facade | Результат Ratio операции выходит за границы |
| `INVALID_JSON` | Adapters | Невалидный JSON |
| `INVALID_DTO` | Adapters | Невалидный DTO объект |

### Использование

```typescript
import { SpreadErrorReason } from '@polymarket/value-objects';

// В Core
throw new SpreadInvariantViolation(
  'bid cannot be greater than ask',
  SpreadErrorReason.BID_GREATER_THAN_ASK
);

// В Facade (через errorUtils)
return Err(
  new InvalidSpreadError('Invalid amount for tighten operation', {
    context: {
      source: ErrorSource.RULE_VALIDATION,
      reason: SpreadErrorReason.INVALID_AMOUNT,
      amount: 'NaN'
    }
  })
);

// Проверка в User Code
if (!result.ok && result.error.context?.reason === SpreadErrorReason.BID_GREATER_THAN_ASK) {
  // Специфичная обработка
}
```

---

## Архитектурные детали

### Почему Price, а не Decimal?

**Решение:** `private readonly _bid: Price`

**Альтернатива:** `private readonly _bid: Decimal`

**Обоснование:**

1. **Type Safety** — Price уже гарантирует диапазон [0.0001, 0.9999]
2. **Переиспользование** — не дублируем валидацию Price
3. **Семантика** — bid/ask — это цены, не просто числа
4. **Интеграция** — естественно работает с PriceService

### Почему private конструктор?

**Решение:** `private constructor()`

**Обоснование:**

1. **Контроль создания** — только через статические фабрики `of()` и `zero()`
2. **Валидация** — гарантируем проверку инвариантов
3. **Расширяемость** — легко добавить новые фабрики без изменения конструктора

### Почему width() возвращает Decimal, а не number?

**Решение:** `width(): Decimal`

**Обоснование:**

1. **Точность** — Decimal.js обеспечивает произвольную точность
2. **Consistency** — Price.value() тоже Decimal
3. **Math operations** — можно напрямую использовать для вычислений

**Когда нужен number:**

```typescript
const widthNum = spread.width().toNumber();  // явная конвертация
```

---

## Дальнейшее чтение

- [Facade API](./facade.md) — как Core используется через SpreadService
- [Архитектура](./architecture.md) — роль Core в общей архитектуре
- [Примеры](./examples.md) — практическое использование
