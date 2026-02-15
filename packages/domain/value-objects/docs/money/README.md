# Money Value Object — Полная документация

> Иммутабельный value object для представления денежных сумм в торговой системе Polymarket

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

**Money** — это value object для работы с денежными суммами в торговой системе Polymarket. Модуль построен на архитектуре **Throws+Facade** с чётким разделением на 4 слоя.

### Ключевые особенности

✅ **Type-safe** — все операции возвращают `Result<T, E>`, нет runtime `undefined`
✅ **Иммутабельный** — все операции создают новые экземпляры
✅ **Высокоточный** — использует `Decimal.js` для произвольной точности
✅ **Multi-currency ready** — поддержка нескольких валют (сейчас USDC)
✅ **Layered Architecture** — чёткое разделение ответственности
✅ **100% Test Coverage** — все слои покрыты тестами (95 тестов)
✅ **Backward Compatible** — старый код продолжает работать

### Когда использовать Money

- Баланс счета пользователя
- Сумма ордера
- Комиссии и fees
- Profit/Loss (P&L)
- Любые денежные операции, где критична точность и валюта

### Money vs Price vs Quantity

| Аспект | Money | Price | Quantity |
| -------- | ------- | ------- | ---------- |
| **Что представляет** | Денежная сумма с валютой | Вероятность исхода | Количество токенов |
| **Диапазон** | [0, 1e15] | [0.0001, 0.9999] | [0, +∞) |
| **Валюта** | ✅ Обязательна (USDC) | ❌ Нет | ❌ Нет |
| **Операции** | add, subtract, multiply, divide | complement, average, roundToTick | add, subtract, multiply, divide, roundToStep |
| **Использование** | Балансы, суммы | Цены на рынках | Объёмы, количества |

---

## Быстрый старт

### Установка

```bash
npm install @polymarket/value-objects
```

### Базовое использование

```typescript
import { MoneyService, Money } from '@polymarket/value-objects/money';
import Decimal from 'decimal.js';

// Создание денежной суммы
const result = MoneyService.create(100);
if (!result.ok) {
  console.error(result.error.message);
  return;
}

const money = result.value;
console.log(money.value().toString()); // "100"
console.log(money.currency()); // "USDC"

// Арифметические операции
const money1Result = MoneyService.create(100);
const money2Result = MoneyService.create(50);

if (money1Result.ok && money2Result.ok) {
  const sumResult = MoneyService.add(money1Result.value, money2Result.value);
  if (sumResult.ok) {
    console.log(sumResult.value.value().toNumber()); // 150
  }
}
```

---

## Архитектура

Money модуль построен на **4-слойной архитектуре** с паттерном **Throws+Facade**:

```text
┌─────────────────────────────────────────────────┐
│           Adapters Layer                        │
│  (Serializers, Formatters)                      │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Facade Layer                          │
│  (MoneyService - Result<T, E>)                  │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Core Layer                            │
│  (Money, MoneyInvariantViolation)               │
└─────────────────────────────────────────────────┘
```

**Примечание:** Money НЕ имеет Rules Layer, т.к. все правила — это инварианты Core.

### Паттерн Throws+Facade

**Core кидает исключения** → **Facade оборачивает в Result<T, E>**

- **Core слой**: Кидает типизированные исключения (`MoneyInvariantViolation`, `MoneyParseError`)
- **Facade слой**: Ловит исключения и возвращает `Result<Money, InvalidMoneyError | ...>`

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

- `Money` — иммутабельный value object
- `MoneyInvariantViolation` — типизированное исключение для нарушения инвариантов
- `MoneyParseError` — исключение для ошибок парсинга

**Инварианты:**

1. Валюта поддерживается (сейчас только `USDC`)
2. Сумма finite (не `NaN`, не `Infinity`)
3. | Сумма | <= MAX_AMOUNT (1e15)

**НЕ инварианты** (контекстные правила):

- Неотрицательность — бизнес-логика (можно иметь отрицательный баланс)
- Минимальная сумма — PaymentPolicy
- Совпадение валют — проверяется в MoneyService

**Константы:**

- `MAX_AMOUNT = 1e15` — максимальная абсолютная сумма
- `SUPPORTED_CURRENCIES = new Set(['USDC'])` — поддерживаемые валюты

**API:**

```typescript
// Создание
Money.of(value: number | string, currency?: 'USDC'): Money
Money.fromDecimal(decimal: Decimal, currency?: 'USDC'): Money
Money.zero(currency?: 'USDC'): Money

// Константы
Money.ZERO.USDC: Money

// Методы
money.value(): Decimal
money.currency(): SupportedCurrency
money.toNumber(): number  // lossy
money.toDecimal(): Decimal
money.equals(other: Money): boolean
money.hasSameCurrency(other: Money): boolean
```

Подробнее: [core.md](./core.md)

---

### 2. Facade Layer

**Назначение:** Единая точка входа с `Result<T, E>`

**MoneyService API:**

```typescript
// Создание
create(value: number | string | Decimal, currency?: 'USDC'): Result<Money, InvalidMoneyError>

// Арифметика
add(a: Money, b: Money): Result<Money, CurrencyMismatchError | ArithmeticOverflowError>
subtract(a: Money, b: Money): Result<Money, CurrencyMismatchError | ArithmeticOverflowError>
multiply(m: Money, factor: number | string | Decimal): Result<Money, InvalidMoneyError | ArithmeticOverflowError>
divide(m: Money, divisor: number | string | Decimal): Result<Money, DivisionByZeroError | InvalidMoneyError | ArithmeticOverflowError>
```

**Facade Error Contract:**

Все ошибки содержат:

- `context.op` — название операции (`'create'`, `'add'`, `'divide'`, etc.)
- `context.value | amount` — входные значения
- `context.currency` — валюта (если применимо)
- `context.divisor | factor` — параметры операции
- `context.reason` — причина из Core (`'UNSUPPORTED_CURRENCY'`, `'NAN'`, `'NON_FINITE'`, `'EXCEEDS_MAX_AMOUNT'`, `'INVALID_FORMAT'`)

**Специфика MoneyService:**

- **Never Throw**: Все методы ГАРАНТИРОВАННО возвращают Result, никогда не бросают исключения
- **Math Safety**: Все вызовы @polymarket/math обёрнуты в try/catch
- **Currency Check**: add/subtract проверяют совпадение валют

Подробнее: [facade.md](./facade.md)

---

### 3. Adapters Layer

**Назначение:** Сериализация и форматирование

**Компоненты:**

- `MoneySerializer` — точная сериализация через `string`
- `MoneyFormatter` — форматирование в строки

**Пример:**

```typescript
// Точная сериализация (для больших чисел)
const json = MoneySerializer.toJSON(money);  // { amount: "123.45", currency: "USDC" }
const result = MoneySerializer.fromJSON(json);

// Форматирование
const formatted = MoneyFormatter.toFixed(money, 2);
console.log(formatted);  // "100.50"

console.log(MoneyFormatter.toCurrency(money));  // "$100.50 USDC"
console.log(MoneyFormatter.toCompact(Money.of(1500)));  // "$1.5K"
```

Подробнее: [adapters.md](./adapters.md)

---

## API Reference

### Импорты

```typescript
// Основной импорт (рекомендуется)
import {
  Money,
  MoneyService,
  MoneySerializer,
  MoneyFormatter
} from '@polymarket/value-objects/money';

// Backward compatibility (старый путь)
import { Money, MoneyService } from '@polymarket/value-objects';
```

### Типы

```typescript
type SupportedCurrency = 'USDC';

type MoneyValue = number | string | Decimal;

type MoneyResult = Result<Money, InvalidMoneyError>;

interface InvalidMoneyErrorContext {
  op?: string;
  value?: string;
  amount?: string;
  currency?: SupportedCurrency;
  divisor?: string;
  factor?: string;
  reason?: 'UNSUPPORTED_CURRENCY' | 'NAN' | 'NON_FINITE' | 'EXCEEDS_MAX_AMOUNT' | 'INVALID_FORMAT';
}

interface CurrencyMismatchErrorContext {
  op: string;
  expected: SupportedCurrency;
  actual: SupportedCurrency;
}
```

---

## Примеры использования

### Создание денежной суммы

```typescript
import { MoneyService } from '@polymarket/value-objects/money';

// Пользователь вводит сумму
const userInput = "100.50";

// Создаём money с валидацией инвариантов
const result = MoneyService.create(userInput);

if (!result.ok) {
  // Ошибка валидации (exceeds max, non-finite, etc.)
  console.error(`Invalid money: ${result.error.message}`);
  console.error(`Reason: ${result.error.context?.reason}`);
  return;
}

const money = result.value;
console.log(`Amount: ${money.value()}`);
console.log(`Currency: ${money.currency()}`);
```

### Вычисление баланса после сделки

```typescript
import { MoneyService, Money } from '@polymarket/value-objects/money';

// Текущий баланс
const currentBalanceResult = MoneyService.create(1000);
if (!currentBalanceResult.ok) return;
const currentBalance = currentBalanceResult.value;

// Сумма сделки
const tradeAmountResult = MoneyService.create(150.50);
if (!tradeAmountResult.ok) return;
const tradeAmount = tradeAmountResult.value;

// Вычисляем новый баланс (после покупки)
const newBalanceResult = MoneyService.subtract(currentBalance, tradeAmount);

if (!newBalanceResult.ok) {
  console.error(newBalanceResult.error.message);
  return;
}

const newBalance = newBalanceResult.value;
console.log(`New balance: $${newBalance.value()}`);  // $849.50
```

### Вычисление комиссии

```typescript
import { MoneyService, Money } from '@polymarket/value-objects/money';

// Сумма ордера
const orderAmountResult = MoneyService.create(1000);
if (!orderAmountResult.ok) return;
const orderAmount = orderAmountResult.value;

// Ставка комиссии (0.2% = 0.002)
const feeRate = "0.002";

// Вычисляем комиссию
const feeResult = MoneyService.multiply(orderAmount, feeRate);

if (!feeResult.ok) {
  console.error(feeResult.error.message);
  return;
}

const fee = feeResult.value;
console.log(`Fee: $${fee.value()}`);  // $2.00
```

### Проверка совпадения валют

```typescript
import { MoneyService, Money } from '@polymarket/value-objects/money';

const usd1 = Money.of(100, 'USDC');
const usd2 = Money.of(50, 'USDC');

// Попытка сложить разные валюты
const sumResult = MoneyService.add(usd1, usd2);

if (!sumResult.ok) {
  // CurrencyMismatchError
  console.error(sumResult.error.context?.expected);  // "USDC"
  console.error(sumResult.error.context?.actual);    // "EUR" (example)
  return;
}
```

### Сериализация для API

```typescript
import { MoneyService, MoneySerializer } from '@polymarket/value-objects/money';

// Создаём money
const moneyResult = MoneyService.create("999999999999.123456789");
if (!moneyResult.ok) return;
const money = moneyResult.value;

// Сериализуем для отправки на сервер (точная)
const payload = {
  userId: "123",
  balance: MoneySerializer.toJSON(money)
};

// payload.balance = { amount: "999999999999.123456789", currency: "USDC" }

// На сервере: десериализация
const receivedResult = MoneySerializer.fromJSON(payload.balance);
if (receivedResult.ok) {
  const money = receivedResult.value;
  // Точность сохранена!
}
```

### Форматирование для UI

```typescript
import { MoneyService, MoneyFormatter } from '@polymarket/value-objects/money';

const moneyResult = MoneyService.create(1234.56);
if (!moneyResult.ok) return;
const money = moneyResult.value;

// Для детального отображения
console.log(MoneyFormatter.toFixed(money, 2));  // "1234.56"

// С символом валюты
console.log(MoneyFormatter.toCurrency(money));  // "$1234.56 USDC"
console.log(MoneyFormatter.toCurrency(money, false));  // "$1234.56"

// Компактный формат для dashboard
console.log(MoneyFormatter.toCompact(Money.of(1500)));  // "$1.5K"
console.log(MoneyFormatter.toCompact(Money.of(2300000)));  // "$2.3M"
```

Больше примеров: [examples.md](./examples.md)

---

## Миграция

### Миграция со старого Money

Старый `Money.ts` может существовать для backward compatibility, но новый код должен использовать `MoneyService`.

**Было:**

```typescript
import { Money } from '@polymarket/value-objects';

const money = new Money(100);  // Может бросить исключение
```

**Стало:**

```typescript
import { MoneyService } from '@polymarket/value-objects/money';

const result = MoneyService.create(100);
if (!result.ok) {
  // Обработка ошибки
  return;
}
const money = result.value;
```

Подробное руководство: [migration.md](./migration.md)

---

## Дополнительные ресурсы

- [Архитектура и паттерны](./architecture.md)
- [Core Layer API](./core.md)
- [Facade Layer API](./facade.md)
- [Adapters Layer](./adapters.md)
- [Примеры использования](./examples.md)
- [Миграция со старого Money](./migration.md)

---

## Поддержка

Вопросы? Проблемы? Создайте issue в репозитории.

**Версия:** 0.1.0
**Последнее обновление:** 1 февраля 2026
