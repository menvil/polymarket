# Price Value Object — Полная документация

> Иммутабельный value object для представления цены на рынках предсказаний Polymarket

## 📋 Содержание

1. [Введение](#введение)
2. [Быстрый старт](#быстрый-старт)
3. [Архитектура](#архитектура)
4. [Слои системы](#слои-системы)
5. [API Reference](#api-reference)
6. [Примеры использования](#примеры-использования)
7. [Polymarket-специфика](#polymarket-специфика)
8. [Миграция](#миграция)

---

## Введение

**Price** — это value object для работы с ценами на рынках предсказаний Polymarket. Модуль построен на архитектуре **Throws+Facade** с чётким разделением на 4 слоя.

### Ключевые особенности

✅ **Type-safe** — все операции возвращают `Result<T, E>`, нет runtime `undefined`
✅ **Иммутабельный** — все операции создают новые экземпляры
✅ **Высокоточный** — использует `Decimal.js` для произвольной точности
✅ **Polymarket-aligned** — диапазон [0.0001, 0.9999], базовый тик 0.0001
✅ **Layered Architecture** — чёткое разделение ответственности
✅ **Comprehensive Test Coverage** — все слои покрыты тестами (182 unit теста)

### Когда использовать Price

- Цена исхода (outcome) на рынке предсказаний
- Bid/Ask цены в ордербуке
- Средневзвешенная цена
- Цена последней сделки
- Любые probability-based цены в диапазоне [0.0001, 0.9999]

### Почему не Percentage?

Price ≠ Percentage, хотя оба в диапазоне [0, 1]:

- **Price** — цена исхода на рынке (0.0001-0.9999), кратна базовому тику 0.0001
- **Percentage** — процентная ставка (0-100%), может быть любым значением

---

## Быстрый старт

### Установка

```bash
npm install @polymarket/value-objects
```

### Базовое использование

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';
import Decimal from 'decimal.js';

// Создание цены
const result = PriceService.create(0.5);
if (!result.ok) {
  console.error(result.error.message);
  return;
}

const price = result.value;
console.log(price.toNumber()); // 0.5

// Вычисление дополнения (complement)
const complementResult = PriceService.complement(price);
if (complementResult.ok) {
  console.log(complementResult.value.toNumber()); // 0.5
}

// Округление к market tick
const roundedResult = PriceService.roundToMarketTick(price, 0.01);
if (roundedResult.ok) {
  console.log(roundedResult.value.toNumber()); // 0.50
}
```

---

## Архитектура

Price модуль построен на **4-слойной архитектуре** с паттерном **Throws+Facade**:

```text
┌─────────────────────────────────────────────────┐
│           Adapters Layer                        │
│  (Serializers, Formatters)                      │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Facade Layer                          │
│  (PriceService - Result<T, E>)                  │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Rules Layer                           │
│  (Atomic validation rules)                      │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Core Layer                            │
│  (Price, PriceInvariantViolation)               │
└─────────────────────────────────────────────────┘
```

### Паттерн Throws+Facade

**Core кидает исключения** → **Facade оборачивает в Result<T, E>**

- **Core слой**: Кидает типизированные исключения (`PriceInvariantViolation`)
- **Facade слой**: Ловит исключения и возвращает `Result<Price, InvalidPriceError>`

Это обеспечивает:

- Явное управление ошибками через `Result<T, E>`
- Невозможность забыть обработать ошибку (compile-time проверка)
- Типизированный контекст ошибок

Подробнее: [architecture.md](./architecture.md)

---

## Слои системы

### 1. Core Layer

**Назначение:** Базовый value object с инвариантами

**Компоненты:**

- `Price` — иммутабельный value object
- `PriceInvariantViolation` — типизированное исключение

**Инварианты:**

- Значение должно быть finite (не `NaN`, не `Infinity`)
- Значение должно быть в диапазоне [0.0001, 0.9999]

**Константы:**

- `MIN_PRICE = 0.0001` — минимальная цена (базовый тик Polymarket)
- `MAX_PRICE = 0.9999` — максимальная цена
- `HALF_PRICE = 0.5` — средняя цена

**API:**

```typescript
// Создание
Price.of(value: Decimal): Price  // ТОЛЬКО для Core/Facade - принимает Decimal
Price.MIN: Price  // 0.0001
Price.MAX: Price  // 0.9999
Price.HALF: Price // 0.5

// Методы
price.value(): Decimal
price.toNumber(): number  // lossy
price.equals(other: Price): boolean
price.isMin(): boolean
price.isMax(): boolean
```

Подробнее: [core.md](./core.md)

---

### 2. Rules Layer

**Назначение:** Атомарные правила валидации

**Правила:**

- `ValidateTickSize` — проверка tick size (positive, finite, <= MAX_PRICE)
- `ValidateTickSizeMultipleOfBaseTick` — проверка кратности базовому тику (0.0001)
- `ValidateAligned` — проверка выравнивания цены по tick size
- `ValidateDivisorForPriceDivision` — валидация делителя (isNaN, isFinite, isZero, isNegative)
- `ValidateFactorForPriceMultiplication` — валидация множителя (isNaN, isFinite, isNegative)

**Принцип:** Одно правило = одна проверка

---

### 3. Facade Layer

**Назначение:** Единая точка входа с `Result<T, E>`

**PriceService API:**

```typescript
// Создание
create(value: number | string | Decimal): Result<Price, InvalidPriceError>

// Арифметика
multiply(price: Price, factor: number | string | Decimal): Result<Price, InvalidPriceError>
divide(price: Price, divisor: number | string | Decimal): Result<Price, InvalidPriceError>

// Polymarket-специфичные операции
complement(price: Price): Result<Price, InvalidPriceError>
average(price1: Price, price2: Price): Result<Price, InvalidPriceError>

// Округление и выравнивание
roundToMarketTick(price: Price, tickSize: number | string | Decimal, mode?: 'nearest' | 'floor' | 'ceil'): Result<Price, InvalidPriceError>
ensureAlignedToMarketTick(price: Price, tickSize: number | string | Decimal): Result<void, InvalidPriceError>

// Применение относительного изменения (markup/markdown)
applyRelativeChange(
  price: Price,
  ratio: Ratio,
  tickSize: number | string | Decimal,
  options?: { roundingMode?: 'nearest' | 'floor' | 'ceil' }
): Result<Price, InvalidPriceError>
```

**Facade Error Contract:**

Все ошибки содержат:

- `context.op` — название операции (`'create'`, `'complement'`, `'divide'`, etc.)
- `context.price` / `context.price1` / `context.price2` — входные цены
- `context.divisor|factor|tickSize` — параметры операции
- `context.reason` — причина ошибки (`'not_aligned'`, `'is_nan'`, `'is_zero'`, etc.)
- `context.cause` — для math-исключений: `{ name, message }`

Подробнее: [facade.md](./facade.md)

---

### 4. Adapters Layer

**Назначение:** Сериализация и форматирование

**Компоненты:**

- `PriceSerializer` — точная сериализация через `string`
- `PriceFormatter` — форматирование в строки

**Пример:**

```typescript
// Точная сериализация
const json = PriceSerializer.toJSON(price);  // { value: "0.5" }
const result = PriceSerializer.fromJSON(json);

// Форматирование
const formatted = PriceFormatter.toFixed(price, 4);
console.log(formatted);  // "0.5000"

console.log(PriceFormatter.toPercentage(price));  // "50.00%"
```

---

## API Reference

### Импорты

```typescript
// Основной импорт (рекомендуется)
import {
  Price,
  PriceService,
  PriceSerializer,
  PriceFormatter
} from '@polymarket/value-objects/price';

// Backward compatibility (старый путь)
import { Price, PriceService } from '@polymarket/value-objects';
```

### Типы

```typescript
type PriceValue = number | string | Decimal;

type PriceResult = Result<Price, InvalidPriceError>;

type RoundingMode = 'nearest' | 'floor' | 'ceil';

interface InvalidPriceErrorContext {
  op?: string;
  field?: string;
  value?: string;
  price?: string;
  price1?: string;
  price2?: string;
  divisor?: string;
  factor?: string;
  tickSize?: string;
  mode?: RoundingMode;
  reason?: string;
  cause?: { name: string; message: string };
}
```

---

## Примеры использования

### Создание цены

```typescript
import { PriceService } from '@polymarket/value-objects/price';

// Пользователь вводит цену
const userInput = "0.65";

// Создаём price с валидацией инвариантов
const result = PriceService.create(userInput);

if (!result.ok) {
  // Ошибка валидации (out of range, non-finite, etc.)
  console.error(`Invalid price: ${result.error.message}`);
  console.error(`Value: ${result.error.context?.value}`);
  return;
}

const price = result.value;
console.log(`Price: ${price.toNumber()}`);  // 0.65
```

### Вычисление дополнения (1 - price)

```typescript
import { PriceService } from '@polymarket/value-objects/price';

// YES цена (используем PriceService для создания)
const yesPriceResult = PriceService.create(0.65);
if (!yesPriceResult.ok) return;
const yesPrice = yesPriceResult.value;

// Вычисляем NO цену (complement)
const noResult = PriceService.complement(yesPrice);

if (!noResult.ok) {
  console.error(noResult.error.message);
  return;
}

const noPrice = noResult.value;
console.log(`YES: ${yesPrice.toNumber()}`);   // 0.65
console.log(`NO: ${noPrice.toNumber()}`);     // 0.35
```

### Усреднение bid/ask

```typescript
import { PriceService } from '@polymarket/value-objects/price';
import Decimal from 'decimal.js';

// Bid и Ask цены (используем PriceService)
const bidResult = PriceService.create(0.64);
const askResult = PriceService.create(0.66);
if (!bidResult.ok || !askResult.ok) return;

const bidPrice = bidResult.value;
const askPrice = askResult.value;

// Вычисляем mid price
const midResult = PriceService.average(bidPrice, askPrice);

if (midResult.ok) {
  console.log(`Mid price: ${midResult.value.toNumber()}`);  // 0.65
}
```

### Округление к market tick

```typescript
import { PriceService } from '@polymarket/value-objects/price';

// Результат вычисления (используем PriceService)
const calcResult = PriceService.create(0.65432);
if (!calcResult.ok) return;
const calculated = calcResult.value;

// Tick size рынка (должен быть кратен 0.0001)
const tickSize = 0.01;

// Округляем вниз (для bid)
const bidResult = PriceService.roundToMarketTick(
  calculated,
  tickSize,
  'floor'
);
if (bidResult.ok) {
  console.log(bidResult.value.toNumber());  // 0.65
}

// Округляем вверх (для ask)
const askResult = PriceService.roundToMarketTick(
  calculated,
  tickSize,
  'ceil'
);
if (askResult.ok) {
  console.log(askResult.value.toNumber());  // 0.66
}

// Округляем к ближайшему (для mid)
const midResult = PriceService.roundToMarketTick(
  calculated,
  tickSize,
  'nearest'
);
if (midResult.ok) {
  console.log(midResult.value.toNumber());  // 0.65
}
```

### Валидация выравнивания

```typescript
import { PriceService } from '@polymarket/value-objects/price';

const priceResult = PriceService.create(0.65);
if (!priceResult.ok) return;
const price = priceResult.value;
const tickSize = 0.01;

// Проверяем что цена aligned к tick size
const alignResult = PriceService.ensureAlignedToMarketTick(price, tickSize);

if (alignResult.ok) {
  console.log('Price is aligned');
} else {
  console.error(alignResult.error.context?.reason);  // 'not_aligned'
}
```

### Сериализация для API

```typescript
import { PriceService, PriceSerializer } from '@polymarket/value-objects/price';

// Создаём price
const priceResult = PriceService.create(0.6543);
if (!priceResult.ok) return;
const price = priceResult.value;

// Сериализуем для отправки на сервер
const payload = {
  orderId: "123",
  price: PriceSerializer.toJSON(price)
};

// payload.price = { value: "0.6543" }

// На сервере: десериализация
const receivedResult = PriceSerializer.fromJSON(payload.price);
if (receivedResult.ok) {
  const price = receivedResult.value;
  // Точность сохранена!
}
```

### Форматирование для UI

```typescript
import { PriceService, PriceFormatter } from '@polymarket/value-objects/price';

const priceResult = PriceService.create(0.65);
if (!priceResult.ok) return;
const price = priceResult.value;

// Для детального отображения (4 знака)
console.log(PriceFormatter.toFixed(price, 4));  // "0.6500"

// Как процент
console.log(PriceFormatter.toPercentage(price));  // "65.00%"

// Для отладки
console.log(`Price(${price.toNumber()})`);  // "Price(0.65)"
```

Больше примеров: [examples.md](./examples.md)

---

## Polymarket-специфика

### Базовый тик (Base Tick)

Минимальная цена `0.0001` служит **базовым тиком** Polymarket.

**Все tick sizes должны быть кратны базовому тику:**

```typescript
// ✅ Валидные tick sizes (кратны 0.0001)
0.0001  // 1x базовый тик
0.0002  // 2x базовый тик
0.001   // 10x базовый тик
0.01    // 100x базовый тик

// ❌ Невалидные (не кратны 0.0001)
0.00015 // НЕ кратен базовому тику
0.003   // НЕ кратен базовому тику
```

### Проверка кратности

`ValidateTickSizeMultipleOfBaseTick` используется в:

- `roundToMarketTick()` — округление к тику
- `ensureAlignedToMarketTick()` — проверка выравнивания

### Диапазон [0.0001, 0.9999]

Price НЕ может быть 0 или 1:

- `0` означает "невозможный исход"
- `1` означает "гарантированный исход"

На реальных рынках всегда есть uncertainty, поэтому:

- Минимум: `0.0001` (0.01%)
- Максимум: `0.9999` (99.99%)

---

## Миграция

### Миграция со старого Price

Старый `Price.ts` остаётся для backward compatibility, но новый код должен использовать `PriceService`.

**Было:**

```typescript
import { Price } from '@polymarket/value-objects';

const price = new Price(0.5);  // Может бросить исключение
```

**Стало:**

```typescript
import { PriceService } from '@polymarket/value-objects/price';

const result = PriceService.create(0.5);
if (!result.ok) {
  // Обработка ошибки
  return;
}
const price = result.value;
```

---

## Дополнительные ресурсы

- [Архитектура и паттерны](./architecture.md)
- [Core Layer API](./core.md)
- [Facade Layer API](./facade.md)
- [Примеры использования](./examples.md)

---

## Поддержка

Вопросы? Проблемы? Создайте issue в репозитории.

**Версия:** 0.1.0
**Последнее обновление:** 30 января 2026
