# Quantity Value Object — Полная документация

> Иммутабельный value object для представления количества в торговой системе Polymarket

## 📋 Содержание

1. [Введение](#введение)
2. [Быстрый старт](#быстрый-старт)
3. [Архитектура](#архитектура)
4. [Слои системы](#слои-системы)
5. [API Reference](#api-reference)
6. [Примеры использования](#примеры-использования)
7. [Миграция](#миграция)

---

## Введение

**Quantity** — это value object для работы с количествами в торговой системе Polymarket. Модуль построен на архитектуре **Throws+Facade** с чётким разделением на 5 слоёв.

### Ключевые особенности

✅ **Type-safe** — все операции возвращают `Result<T, E>`, нет runtime `undefined`
✅ **Иммутабельный** — все операции создают новые экземпляры
✅ **Высокоточный** — использует `Decimal.js` для произвольной точности
✅ **Layered Architecture** — чёткое разделение ответственности
✅ **100% Test Coverage** — все слои покрыты тестами
✅ **Backward Compatible** — старый код продолжает работать

### Когда использовать Quantity

- Количество токенов в ордере
- Размер позиции
- Объём сделки
- Любые количественные значения, где критична точность

---

## Быстрый старт

### Установка

```bash
npm install @polymarket/value-objects
```

### Базовое использование

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import Decimal from 'decimal.js';

// Создание количества
const result = QuantityService.create(10);
if (!result.ok) {
  console.error(result.error.message);
  return;
}

const qty = result.value;
console.log(qty.value().toString()); // "10"

// Арифметические операции
const qty1 = Quantity.of(10);
const qty2 = Quantity.of(5);

const sumResult = QuantityService.add(qty1, qty2);
if (sumResult.ok) {
  console.log(sumResult.value.value().toNumber()); // 15
}

// Создание для ордера с проверкой minSize
const orderResult = QuantityService.createForOrder(10, new Decimal(1));
if (orderResult.ok) {
  console.log('Order quantity valid');
}
```

---

## Архитектура

Quantity модуль построен на **5-слойной архитектуре** с паттерном **Throws+Facade**:

```
┌─────────────────────────────────────────────────┐
│           Adapters Layer                        │
│  (Serializers, Formatters)                      │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Facade Layer                          │
│  (QuantityService - Result<T, E>)               │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Policy Layer                          │
│  (OrderQuantityPolicy, PositionQuantityPolicy)  │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Rules Layer                           │
│  (Atomic validation rules)                      │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Core Layer                            │
│  (Quantity, QuantityInvariantViolation)         │
└─────────────────────────────────────────────────┘
```

### Паттерн Throws+Facade

**Core кидает исключения** → **Facade оборачивает в Result<T, E>**

- **Core слой**: Кидает типизированные исключения (`QuantityInvariantViolation`)
- **Facade слой**: Ловит исключения и возвращает `Result<Quantity, InvalidQuantityError>`

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
- `Quantity` — иммутабельный value object
- `QuantityInvariantViolation` — типизированное исключение

**Инварианты:**
- Значение должно быть finite (не `NaN`, не `Infinity`)
- Значение должно быть >= 0 (неотрицательное)

**API:**
```typescript
// Создание
Quantity.of(value: Decimal.Value): Quantity
Quantity.fromDecimal(decimal: Decimal): Quantity  // zero-copy

// Константы
Quantity.ZERO: Quantity
Quantity.ONE: Quantity

// Методы
quantity.value(): Decimal
quantity.toNumber(): number  // lossy
quantity.equals(other: Quantity): boolean
quantity.isZero(): boolean
quantity.isPositive(): boolean
```

Подробнее: [core.md](./core.md)

---

### 2. Rules Layer

**Назначение:** Атомарные правила валидации

**Правила:**
- `ValidateMinSize` — проверка минимального размера
- `ValidateResultNonNegative` — проверка неотрицательности результата
- `ValidateDivisorForQuantityDivision` — валидация делителя
- `ValidateFactorForQuantityMultiplication` — валидация множителя
- `ValidateTickSizeForRounding` — валидация размера тика

**Принцип:** Одно правило = одна проверка

Подробнее: [rules.md](./rules.md)

---

### 3. Policy Layer

**Назначение:** Композиция правил для бизнес-контекстов

**Политики:**
- `OrderQuantityPolicy` — правила для ордеров
- `PositionQuantityPolicy` — правила для позиций

**Пример:**
```typescript
// Для ордера: quantity >= minSize
OrderQuantityPolicy.validateForOrder(quantity, minSize)

// Для позиции: quantity >= 0 (разрешён ноль)
PositionQuantityPolicy.validateForPosition(quantity)

// Частичное закрытие позиции
PositionQuantityPolicy.validatePartialClose(current, close)
```

Подробнее: [policy.md](./policy.md)

---

### 4. Facade Layer

**Назначение:** Единая точка входа с `Result<T, E>`

**QuantityService API:**

```typescript
// Создание
create(value: number | string | Decimal): Result<Quantity, InvalidQuantityError>
createForOrder(value: number | string | Decimal, minSize: Decimal): Result<Quantity, InvalidQuantityError>

// Арифметика
add(qty1: Quantity, qty2: Quantity): Result<Quantity, InvalidQuantityError>
subtract(qty1: Quantity, qty2: Quantity): Result<Quantity, InvalidQuantityError>
multiply(quantity: Quantity, factor: number | Decimal): Result<Quantity, InvalidQuantityError>
divide(quantity: Quantity, divisor: number | Decimal): Result<Quantity, InvalidQuantityError>

// Округление
roundToTick(quantity: Quantity, tickSize: Decimal, roundingMode?: Decimal.Rounding): Result<Quantity, InvalidQuantityError>

// Валидация
validateForPosition(quantity: Quantity): Result<void, InvalidQuantityError>
```

**Facade Error Contract:**

Все ошибки содержат:
- `context.op` — название операции (`'create'`, `'add'`, `'divide'`, etc.)
- `context.quantity` — входное количество (если применимо)
- `context.divisor|factor|tickSize` — параметры операции
- `context.reason` — причина из Core/Rules (`'NEGATIVE'`, `'NON_FINITE'`)
- `context.cause` — для math-исключений: `{ name, message }`

Подробнее: [facade.md](./facade.md)

---

### 5. Adapters Layer

**Назначение:** Сериализация и форматирование

**Компоненты:**
- `QuantitySerializer` — точная сериализация через `string`
- `QuantityLossySerializer` — lossy сериализация через `number`
- `QuantityFormatter` — форматирование в строки

**Пример:**
```typescript
// Точная сериализация (для больших чисел)
const json = QuantitySerializer.toJSON(qty);  // { value: "12345678901234567890.123" }
const result = QuantitySerializer.fromJSON(json);

// Lossy сериализация (для UI)
const lossy = QuantityLossySerializer.toJSON(qty);  // { value: 123.45 }

// Форматирование
QuantityFormatter.toString(qty, 2);  // "10.50"
QuantityFormatter.toDisplayString(qty);  // "1.50K" для 1500
```

Подробнее: [adapters.md](./adapters.md)

---

## API Reference

### Импорты

```typescript
// Основной импорт (рекомендуется)
import {
  Quantity,
  QuantityService,
  QuantitySerializer,
  QuantityFormatter
} from '@polymarket/value-objects/quantity';

// Для advanced use cases
import {
  OrderQuantityPolicy,
  PositionQuantityPolicy,
  ValidateMinSize
} from '@polymarket/value-objects/quantity';

// Backward compatibility (старый путь)
import { Quantity, QuantityService } from '@polymarket/value-objects';
```

### Типы

```typescript
type QuantityValue = number | string | Decimal;

type QuantityResult = Result<Quantity, InvalidQuantityError>;

interface InvalidQuantityErrorContext {
  op?: string;
  value?: string;
  quantity?: string;
  quantity1?: string;
  quantity2?: string;
  divisor?: string;
  factor?: string;
  tickSize?: string;
  minSize?: string;
  reason?: 'NEGATIVE' | 'NON_FINITE';
  cause?: { name: string; message: string };
}
```

---

## Примеры использования

### Создание ордера

```typescript
import { QuantityService } from '@polymarket/value-objects/quantity';
import Decimal from 'decimal.js';

// Минимальный размер ордера для рынка
const ORDER_MIN_SIZE = new Decimal(1);

// Пользователь вводит количество
const userInput = "10.5";

// Создаём quantity с валидацией minSize
const result = QuantityService.createForOrder(userInput, ORDER_MIN_SIZE);

if (!result.ok) {
  // Ошибка валидации
  console.error(`Order rejected: ${result.error.message}`);
  console.error(`Reason: ${result.error.context?.reason}`);
  return;
}

const orderQuantity = result.value;
console.log(`Order quantity: ${orderQuantity.value()}`);
```

### Вычисление остатка позиции

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';

// Текущая позиция
const currentPosition = Quantity.of(100);

// Размер сделки (частичное закрытие)
const tradeSize = Quantity.of(30);

// Вычисляем остаток
const remainingResult = QuantityService.subtract(currentPosition, tradeSize);

if (!remainingResult.ok) {
  // Ошибка: попытка закрыть больше чем есть
  console.error(remainingResult.error.message);
  return;
}

const remaining = remainingResult.value;
console.log(`Remaining position: ${remaining.value()}`);  // 70
```

### Округление к тику

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import Decimal from 'decimal.js';

// Результат вычисления
const calculated = Quantity.of("10.567891");

// Tick size рынка
const tickSize = new Decimal("0.01");

// Округляем
const roundedResult = QuantityService.roundToTick(
  calculated,
  tickSize,
  Decimal.ROUND_HALF_UP
);

if (roundedResult.ok) {
  console.log(roundedResult.value.value().toString());  // "10.57"
}
```

### Сериализация для API

```typescript
import { Quantity, QuantitySerializer } from '@polymarket/value-objects/quantity';

// Создаём quantity
const qty = Quantity.of("99999999999999999999.123456789");

// Сериализуем для отправки на сервер (точная)
const payload = {
  orderId: "123",
  quantity: QuantitySerializer.toJSON(qty)
};

// payload.quantity = { value: "99999999999999999999.123456789" }

// На сервере: десериализация
const receivedResult = QuantitySerializer.fromJSON(payload.quantity);
if (receivedResult.ok) {
  const quantity = receivedResult.value;
  // Точность сохранена!
}
```

### Форматирование для UI

```typescript
import { Quantity, QuantityFormatter } from '@polymarket/value-objects/quantity';

const qty = Quantity.of(1500);

// Для детального отображения
console.log(QuantityFormatter.toString(qty, 2));  // "1500.00"

// Для компактного отображения
console.log(QuantityFormatter.toCompactString(qty));  // "1500"

// Для dashboard с K/M суффиксами
console.log(QuantityFormatter.toDisplayString(qty));  // "1.50K"

// Для отладки
console.log(QuantityFormatter.toDebugString(qty));  // "Quantity(1500)"
```

Больше примеров: [examples.md](./examples.md)

---

## Миграция

### Миграция со старого Quantity

Старый `Quantity.ts` остаётся для backward compatibility, но новый код должен использовать `QuantityService`.

**Было:**
```typescript
import { Quantity } from '@polymarket/value-objects';

const qty = new Quantity(10);  // Может бросить исключение
```

**Стало:**
```typescript
import { QuantityService } from '@polymarket/value-objects/quantity';

const result = QuantityService.create(10);
if (!result.ok) {
  // Обработка ошибки
  return;
}
const qty = result.value;
```

Подробный гайд: [migration.md](./migration.md)

---

## Дополнительные ресурсы

- [Архитектура и паттерны](./architecture.md)
- [Core Layer API](./core.md)
- [Rules Layer](./rules.md)
- [Policy Layer](./policy.md)
- [Facade Layer API](./facade.md)
- [Adapters Layer](./adapters.md)
- [Примеры использования](./examples.md)
- [Миграция со старого Quantity](./migration.md)

---

## Поддержка

Вопросы? Проблемы? Создайте issue в репозитории.

**Версия:** 0.1.0
**Последнее обновление:** 29 января 2026
