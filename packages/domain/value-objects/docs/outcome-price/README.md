# OutcomePrice Value Object — Полная документация

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

**OutcomePrice** — это value object для работы с ценами на рынках предсказаний Polymarket. Модуль построен на архитектуре **Throws+Facade** с чётким разделением на 4 слоя.

### Ключевые особенности

✅ **Type-safe** — все операции возвращают `Result<T, E>`, нет runtime `undefined`
✅ **Иммутабельный** — все операции создают новые экземпляры
✅ **Высокоточный** — использует `Decimal.js` для произвольной точности
✅ **Polymarket-aligned** — диапазон [0.0001, 0.9999], базовый тик 0.0001
✅ **Layered Architecture** — чёткое разделение ответственности
✅ **Comprehensive Test Coverage** — все слои покрыты тестами (182 unit теста)

### Когда использовать OutcomePrice

- Цена исхода (outcome) на рынке предсказаний
- Bid/Ask цены в ордербуке
- Средневзвешенная цена
- Цена последней сделки
- Любые probability-based цены в диапазоне [0.0001, 0.9999]

### Почему не Percentage?

OutcomePrice ≠ Percentage, хотя оба в диапазоне [0, 1]:

- **OutcomePrice** — цена исхода на рынке (0.0001-0.9999), кратна базовому тику 0.0001
- **Percentage** — процентная ставка (0-100%), может быть любым значением

---

## Быстрый старт

### Установка

```bash
npm install @polymarket/value-objects
```

### Базовое использование

```typescript
import { OutcomePriceService, OutcomePrice } from '@polymarket/value-objects/outcome-price';
import Decimal from 'decimal.js';

// Создание цены
const result = OutcomePriceService.create(0.5);
if (!result.ok) {
  console.error(result.error.message);
  return;
}

const price = result.value;
console.log(price.toNumber()); // 0.5

// Вычисление дополнения (complement)
const complementResult = OutcomePriceService.complement(price);
if (complementResult.ok) {
  console.log(complementResult.value.toNumber()); // 0.5
}

// Округление к market tick
const roundedResult = OutcomePriceService.roundToMarketTick(price, 0.01);
if (roundedResult.ok) {
  console.log(roundedResult.value.toNumber()); // 0.50
}
```

---

## Архитектура

OutcomePrice модуль построен на **4-слойной архитектуре** с паттерном **Throws+Facade**:

```text
┌─────────────────────────────────────────────────┐
│           Adapters Layer                        │
│  (Serializers, Formatters)                      │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Facade Layer                          │
│  (OutcomePriceService - Result<T, E>)                  │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Rules Layer                           │
│  (Atomic validation rules)                      │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Core Layer                            │
│  (OutcomePrice, OutcomePriceInvariantViolation)               │
└─────────────────────────────────────────────────┘
```

### Паттерн Throws+Facade

**Core кидает исключения** → **Facade оборачивает в Result<T, E>**

- **Core слой**: Кидает типизированные исключения (`OutcomePriceInvariantViolation`)
- **Facade слой**: Ловит исключения и возвращает `Result<OutcomePrice, InvalidOutcomePriceError>`

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

- `OutcomePrice` — иммутабельный value object
- `OutcomePriceInvariantViolation` — типизированное исключение

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
OutcomePrice.of(value: Decimal): OutcomePrice  // ТОЛЬКО для Core/Facade - принимает Decimal
OutcomePrice.MIN: OutcomePrice  // 0.0001
OutcomePrice.MAX: OutcomePrice  // 0.9999
OutcomePrice.HALF: OutcomePrice // 0.5

// Методы
price.value(): Decimal
price.toNumber(): number  // lossy
price.equals(other: OutcomePrice): boolean
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

**OutcomePriceService API:**

```typescript
// Создание
create(value: number | string | Decimal): Result<OutcomePrice, InvalidOutcomePriceError>

// Арифметика
multiply(price: OutcomePrice, factor: number | string | Decimal): Result<OutcomePrice, InvalidOutcomePriceError>
divide(price: OutcomePrice, divisor: number | string | Decimal): Result<OutcomePrice, InvalidOutcomePriceError>

// Polymarket-специфичные операции
complement(price: OutcomePrice): Result<OutcomePrice, InvalidOutcomePriceError>
average(price1: OutcomePrice, price2: OutcomePrice): Result<OutcomePrice, InvalidOutcomePriceError>

// Округление и выравнивание
roundToMarketTick(price: OutcomePrice, tickSize: number | string | Decimal, mode?: 'nearest' | 'floor' | 'ceil'): Result<OutcomePrice, InvalidOutcomePriceError>
ensureAlignedToMarketTick(price: OutcomePrice, tickSize: number | string | Decimal): Result<void, InvalidOutcomePriceError>

// Применение относительного изменения (markup/markdown)
applyRelativeChange(
  price: OutcomePrice,
  ratio: Ratio,
  tickSize: number | string | Decimal,
  options?: { roundingMode?: 'nearest' | 'floor' | 'ceil' }
): Result<OutcomePrice, InvalidOutcomePriceError>
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

- `OutcomePriceSerializer` — точная сериализация через `string`
- `OutcomePriceFormatter` — форматирование в строки

**Пример:**

```typescript
// Точная сериализация
const json = OutcomePriceSerializer.toJSON(price);  // { value: "0.5" }
const result = OutcomePriceSerializer.fromJSON(json);

// Форматирование (возвращают Result<string, InvalidOutcomePriceError>)
const fixedResult = OutcomePriceFormatter.toFixed(price, 4);
if (fixedResult.ok) console.log(fixedResult.value);  // "0.5000"

const percentResult = OutcomePriceFormatter.toPercentage(price);
if (percentResult.ok) console.log(percentResult.value);  // "50.00%"
```

---

## API Reference

### Импорты

```typescript
// Основной импорт (рекомендуется)
import {
  OutcomePrice,
  OutcomePriceService,
  OutcomePriceSerializer,
  OutcomePriceFormatter
} from '@polymarket/value-objects/outcome-price';

// Backward compatibility (старый путь)
import { OutcomePrice, OutcomePriceService } from '@polymarket/value-objects';
```

### Типы

```typescript
type PriceValue = number | string | Decimal;

type PriceResult = Result<OutcomePrice, InvalidOutcomePriceError>;

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
import { OutcomePriceService } from '@polymarket/value-objects/outcome-price';

// Пользователь вводит цену
const userInput = "0.65";

// Создаём price с валидацией инвариантов
const result = OutcomePriceService.create(userInput);

if (!result.ok) {
  // Ошибка валидации (out of range, non-finite, etc.)
  console.error(`Invalid price: ${result.error.message}`);
  console.error(`Value: ${result.error.context?.value}`);
  return;
}

const price = result.value;
console.log(`OutcomePrice: ${price.toNumber()}`);  // 0.65
```

### Вычисление дополнения (1 - price)

```typescript
import { OutcomePriceService } from '@polymarket/value-objects/outcome-price';

// YES цена (используем OutcomePriceService для создания)
const yesPriceResult = OutcomePriceService.create(0.65);
if (!yesPriceResult.ok) return;
const yesPrice = yesPriceResult.value;

// Вычисляем NO цену (complement)
const noResult = OutcomePriceService.complement(yesPrice);

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
import { OutcomePriceService } from '@polymarket/value-objects/outcome-price';
import Decimal from 'decimal.js';

// Bid и Ask цены (используем OutcomePriceService)
const bidResult = OutcomePriceService.create(0.64);
const askResult = OutcomePriceService.create(0.66);
if (!bidResult.ok || !askResult.ok) return;

const bidPrice = bidResult.value;
const askPrice = askResult.value;

// Вычисляем mid price
const midResult = OutcomePriceService.average(bidPrice, askPrice);

if (midResult.ok) {
  console.log(`Mid price: ${midResult.value.toNumber()}`);  // 0.65
}
```

### Округление к market tick

```typescript
import { OutcomePriceService } from '@polymarket/value-objects/outcome-price';

// Результат вычисления (используем OutcomePriceService)
const calcResult = OutcomePriceService.create(0.65432);
if (!calcResult.ok) return;
const calculated = calcResult.value;

// Tick size рынка (должен быть кратен 0.0001)
const tickSize = 0.01;

// Округляем вниз (для bid)
const bidResult = OutcomePriceService.roundToMarketTick(
  calculated,
  tickSize,
  'floor'
);
if (bidResult.ok) {
  console.log(bidResult.value.toNumber());  // 0.65
}

// Округляем вверх (для ask)
const askResult = OutcomePriceService.roundToMarketTick(
  calculated,
  tickSize,
  'ceil'
);
if (askResult.ok) {
  console.log(askResult.value.toNumber());  // 0.66
}

// Округляем к ближайшему (для mid)
const midResult = OutcomePriceService.roundToMarketTick(
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
import { OutcomePriceService } from '@polymarket/value-objects/outcome-price';

const priceResult = OutcomePriceService.create(0.65);
if (!priceResult.ok) return;
const price = priceResult.value;
const tickSize = 0.01;

// Проверяем что цена aligned к tick size
const alignResult = OutcomePriceService.ensureAlignedToMarketTick(price, tickSize);

if (alignResult.ok) {
  console.log('OutcomePrice is aligned');
} else {
  console.error(alignResult.error.context?.reason);  // 'not_aligned'
}
```

### Сериализация для API

```typescript
import { OutcomePriceService, OutcomePriceSerializer } from '@polymarket/value-objects/outcome-price';

// Создаём price
const priceResult = OutcomePriceService.create(0.6543);
if (!priceResult.ok) return;
const price = priceResult.value;

// Сериализуем для отправки на сервер
const payload = {
  orderId: "123",
  price: OutcomePriceSerializer.toJSON(price)
};

// payload.price = { value: "0.6543" }

// На сервере: десериализация
const receivedResult = OutcomePriceSerializer.fromJSON(payload.price);
if (receivedResult.ok) {
  const price = receivedResult.value;
  // Точность сохранена!
}
```

### Форматирование для UI

```typescript
import { OutcomePriceService, OutcomePriceFormatter } from '@polymarket/value-objects/outcome-price';

const priceResult = OutcomePriceService.create(0.65);
if (!priceResult.ok) return;
const price = priceResult.value;

// Для детального отображения (4 знака)
const fixedResult = OutcomePriceFormatter.toFixed(price, 4);
if (fixedResult.ok) {
  console.log(fixedResult.value);  // "0.6500"
}

// Как процент
const percentResult = OutcomePriceFormatter.toPercentage(price);
if (percentResult.ok) {
  console.log(percentResult.value);  // "65.00%"
}

// Для отладки
console.log(`OutcomePrice(${price.toNumber()})`);  // "OutcomePrice(0.65)"
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

OutcomePrice НЕ может быть 0 или 1:

- `0` означает "невозможный исход"
- `1` означает "гарантированный исход"

На реальных рынках всегда есть uncertainty, поэтому:

- Минимум: `0.0001` (0.01%)
- Максимум: `0.9999` (99.99%)

---

## Миграция

### Миграция со старого OutcomePrice

Старый `OutcomePrice.ts` остаётся для backward compatibility, но новый код должен использовать `OutcomePriceService`.

**Было:**

```typescript
import { OutcomePrice } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

const price = OutcomePrice.of(new Decimal(0.5));  // Может бросить исключение
```

**Стало:**

```typescript
import { OutcomePriceService } from '@polymarket/value-objects/outcome-price';

const result = OutcomePriceService.create(0.5);
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
