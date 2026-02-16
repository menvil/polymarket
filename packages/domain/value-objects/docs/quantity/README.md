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

**Quantity** — это value object для работы с количествами в торговой системе Polymarket. Модуль построен на архитектуре **Throws+Facade** с чётким разделением на 4 слоя.

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
const qty1Result = QuantityService.create(10);
const qty2Result = QuantityService.create(5);

if (qty1Result.ok && qty2Result.ok) {
  const sumResult = QuantityService.add(qty1Result.value, qty2Result.value);
  if (sumResult.ok) {
    console.log(sumResult.value.value().toNumber()); // 15
  }
}
```

---

## Архитектура

Quantity модуль построен на **4-слойной архитектуре** с паттерном **Throws+Facade**:

```text
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
Quantity.of(value: Decimal): Quantity

// Константы
Quantity.ZERO: Quantity
Quantity.ONE: Quantity

// Методы
quantity.value(): Decimal
quantity.toNumber(): number  // lossy
quantity.equals(other: Quantity): boolean
quantity.isZero(): boolean
quantity.isPositive(): boolean
quantity.isLessThan(other: Quantity): boolean
quantity.isLessThanOrEqual(other: Quantity): boolean
quantity.isGreaterThan(other: Quantity): boolean
quantity.isGreaterThanOrEqual(other: Quantity): boolean
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
- `ValidateStepSizeForQuantity` — валидация размера тика

**Принцип:** Одно правило = одна проверка


---

### 3. Facade Layer

**Назначение:** Единая точка входа с `Result<T, E>`

**QuantityService API:**

```typescript
// Создание
create(value: number | string | Decimal): Result<Quantity, InvalidQuantityError>

// Арифметика
add(qty1: Quantity, qty2: Quantity): Result<Quantity, InvalidQuantityError>
subtract(qty1: Quantity, qty2: Quantity): Result<Quantity, InvalidQuantityError>
multiply(quantity: Quantity, factor: number | string | Decimal): Result<Quantity, InvalidQuantityError>
divide(quantity: Quantity, divisor: number | string | Decimal): Result<Quantity, InvalidQuantityError>

// Округление
roundToStep(quantity: Quantity, stepSize: number | string | Decimal, roundingMode?: Decimal.Rounding): Result<Quantity, InvalidQuantityError>

// Процентные операции
portion(quantity: Quantity, rate: Ratio): Result<Quantity, InvalidQuantityError>
increaseBy(quantity: Quantity, delta: Ratio, stepSize: number | string | Decimal, options?: { roundingMode?: Decimal.Rounding }): Result<Quantity, InvalidQuantityError>
```

**Контракт "Never Throw":**

ВСЕ методы QuantityService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения. Любые ошибки (ожидаемые и неожиданные) ловятся и преобразуются в Result.Err.

**Facade Error Contract:**

Все ошибки содержат:

- `context.op` — название операции (`'create'`, `'add'`, `'divide'`, etc.) — **ВСЕГДА присутствует**
- `context.quantity` — входное количество (если применимо)
- `context.divisor|factor|stepSize` — параметры операции (операционные поля)
- `context.raw` — сырой ввод для toDecimal (для ошибок парсинга)
- `context.reason` — причина из Core/Rules (`'NEGATIVE'`, `'NON_FINITE'`)
- `context.cause` — для math-исключений и unexpected errors: `{ name, message, stack? }`

Подробнее: [facade.md](./facade.md)

---

### 4. Adapters Layer

**Назначение:** Сериализация и форматирование

**Компоненты:**

- `QuantitySerializer` — точная сериализация через `string`
- `QuantityFormatter` — форматирование в строки

**Пример:**

```typescript
// Точная сериализация (для больших чисел)
const json = QuantitySerializer.toJSON(qty);  // { value: "12345678901234567890.123" }
const result = QuantitySerializer.fromJSON(json);

// Форматирование
const formattedResult = QuantityFormatter.toString(qty, 2);
if (formattedResult.ok) {
  console.log(formattedResult.value);  // "10.50"
}
console.log(QuantityFormatter.toDisplayString(qty));  // "1.50K" для 1500
```


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
  stepSize?: string;
  minSize?: string;
  reason?: 'NEGATIVE' | 'NON_FINITE';
  cause?: { name: string; message: string };
}
```

---

## Примеры использования

### Создание количества

```typescript
import { QuantityService } from '@polymarket/value-objects/quantity';

// Пользователь вводит количество
const userInput = "10.5";

// Создаём quantity с валидацией инвариантов
const result = QuantityService.create(userInput);

if (!result.ok) {
  // Ошибка валидации (negative, non-finite, etc.)
  console.error(`Invalid quantity: ${result.error.message}`);
  console.error(`Reason: ${result.error.context?.reason}`);
  return;
}

const quantity = result.value;
console.log(`Quantity: ${quantity.value()}`);
```

### Вычисление остатка позиции

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';

// Текущая позиция (используем QuantityService.create для создания)
const currentPositionResult = QuantityService.create(100);
if (!currentPositionResult.ok) return;
const currentPosition = currentPositionResult.value;

// Размер сделки (частичное закрытие)
const tradeSizeResult = QuantityService.create(30);
if (!tradeSizeResult.ok) return;
const tradeSize = tradeSizeResult.value;

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
const calculatedResult = QuantityService.create("10.567891");
if (!calculatedResult.ok) return;
const calculated = calculatedResult.value;

// Tick size рынка
const stepSize = new Decimal("0.01");

// Округляем
const roundedResult = QuantityService.roundToStep(
  calculated,
  stepSize,
  Decimal.ROUND_HALF_UP
);

if (roundedResult.ok) {
  console.log(roundedResult.value.value().toString());  // "10.57"
}
```

### Сериализация для API

```typescript
import { QuantityService, QuantitySerializer } from '@polymarket/value-objects/quantity';

// Создаём quantity
const qtyResult = QuantityService.create("99999999999999999999.123456789");
if (!qtyResult.ok) return;
const qty = qtyResult.value;

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
import { QuantityService, QuantityFormatter } from '@polymarket/value-objects/quantity';

const qtyResult = QuantityService.create(1500);
if (!qtyResult.ok) return;
const qty = qtyResult.value;

// Для детального отображения
const formattedResult = QuantityFormatter.toString(qty, 2);
if (formattedResult.ok) {
  console.log(formattedResult.value);  // "1500.00"
}

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
**Последнее обновление:** 1 февраля 2026
