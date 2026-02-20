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
✅ **100% Test Coverage** — все слои покрыты тестами
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

**Примечание:** Money имеет Rules Layer для валидации операндов арифметических операций (ValidateDivisorForMoneyDivision, ValidateFactorForMoneyMultiplication, ValidateDeltaForIncreaseBy).

### Паттерн Throws+Facade

**Core кидает исключения** → **Facade оборачивает в Result<T, E>**

- **Core слой**: Кидает типизированные исключения (`MoneyInvariantViolation`)
- **Facade слой**: Ловит исключения и возвращает `Result<Money, InvalidMoneyError>`

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
// Создание (ТОЛЬКО для внутреннего использования, принимает ТОЛЬКО Decimal)
Money.of(value: Decimal, currency?: SupportedCurrency): Money

// Константы (singleton для каждой валюты)
Money.ZERO: Record<SupportedCurrency, Money>  // Money.ZERO.USDC

// Методы
money.value(): Decimal
money.currency(): SupportedCurrency
money.toNumber(): number  // lossy conversion
money.hasSameCurrency(other: Money): boolean
money.isZero(): boolean
money.isPositive(): boolean
money.isNegative(): boolean
```

**Важно:** Для создания Money из `number` или `string` используйте `MoneyService.create()`, а не `Money.of()` напрямую.

Подробнее: [core.md](./core.md)

---

### 2. Facade Layer

**Назначение:** Единая точка входа с `Result<T, E>`

**MoneyService API:**

```typescript
// Создание
create(value: number | string | Decimal, currency?: 'USDC'): Result<Money, InvalidMoneyError>

// Арифметика
add(a: Money, b: Money): Result<Money, InvalidMoneyError>
subtract(a: Money, b: Money): Result<Money, InvalidMoneyError>
multiply(m: Money, factor: number | string | Decimal): Result<Money, InvalidMoneyError>
divide(m: Money, divisor: number | string | Decimal): Result<Money, InvalidMoneyError>

// Операции с Ratio (проценты, доли)
portion(m: Money, rate: Ratio): Result<Money, InvalidMoneyError>
increaseBy(m: Money, delta: Ratio): Result<Money, InvalidMoneyError>
decreaseBy(m: Money, delta: Ratio): Result<Money, InvalidMoneyError>
```

**Facade Error Contract:**

Все ошибки содержат:

- `context.op` — название операции (`'create'`, `'add'`, `'divide'`, etc.)
- `context.value | amount` — входные значения
- `context.currency` — валюта (если применимо)
- `context.divisor | factor` — параметры операции
- `context.reason` — причина ошибки:
  - `INVALID_FORMAT` — ошибка парсинга
  - `NAN` — значение NaN
  - `NON_FINITE` — значение не finite (Infinity)
  - `EXCEEDS_MAX_AMOUNT` — превышение максимальной суммы
  - `UNSUPPORTED_CURRENCY` — неподдерживаемая валюта
  - `CURRENCY_MISMATCH` — несовпадение валют
  - `DIVISION_BY_ZERO` — деление на ноль
  - `NEGATIVE_RESULT` — отрицательный результат
  - `INVALID_RATIO` — невалидный Ratio
  - `RATIO_OUT_OF_RANGE` — Ratio вне диапазона
  - `DELTA_LESS_THAN_MINUS_ONE` — delta < -1

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
if (formatted.ok) console.log(formatted.value);  // "100.50"

const withCurrency = MoneyFormatter.toCurrency(money);
if (withCurrency.ok) console.log(withCurrency.value);  // "$100.50 USDC"

const compactMoneyResult = MoneyService.create(new Decimal(1500));
if (compactMoneyResult.ok) {
  const compact = MoneyFormatter.toCompact(compactMoneyResult.value);
  if (compact.ok) console.log(compact.value);  // "$1.5K"
}
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
  reason?:
    | 'NAN'
    | 'NON_FINITE'
    | 'EXCEEDS_MAX_AMOUNT'
    | 'CURRENCY_MISMATCH'
    | 'DIVISION_BY_ZERO'
    | 'UNSUPPORTED_CURRENCY'
    | 'INVALID_FORMAT'
    | 'NEGATIVE_RESULT'
    | 'INVALID_RATIO'
    | 'RATIO_OUT_OF_RANGE'
    | 'DELTA_LESS_THAN_MINUS_ONE';
}

// Для ошибок CURRENCY_MISMATCH контекст содержит:
interface InvalidMoneyErrorCurrencyMismatchContext {
  op: string;
  reason: 'CURRENCY_MISMATCH';
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
import Decimal from 'decimal.js';

// Создаём две суммы в USDC
const usdc1Result = MoneyService.create(new Decimal(100));
const usdc2Result = MoneyService.create(new Decimal(50));

if (!usdc1Result.ok || !usdc2Result.ok) {
  console.error('Failed to create Money');
  return;
}

// Одинаковые валюты — успешно
const sumResult = MoneyService.add(usdc1Result.value, usdc2Result.value);
if (sumResult.ok) {
  console.log(`Sum: $${sumResult.value.value()}`);  // $150
}

// Пример с разными валютами (концептуально, если бы EUR была поддержана):
// const eurResult = MoneyService.create(new Decimal(100), 'EUR');
// const mismatchResult = MoneyService.add(usdc1Result.value, eurResult.value);
// if (!mismatchResult.ok) {
//   // InvalidMoneyError (reason: CURRENCY_MISMATCH)
//   console.error(mismatchResult.error.context?.expected);  // "USDC"
//   console.error(mismatchResult.error.context?.actual);    // "EUR"
// }
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
const fixed = MoneyFormatter.toFixed(money, 2);
if (fixed.ok) console.log(fixed.value);  // "1234.56"

// С символом валюты
const withCurrency = MoneyFormatter.toCurrency(money);
if (withCurrency.ok) console.log(withCurrency.value);  // "$1234.56 USDC"
const withoutCurrency = MoneyFormatter.toCurrency(money, false);
if (withoutCurrency.ok) console.log(withoutCurrency.value);  // "$1234.56"

// Компактный формат для dashboard
const compact1MoneyResult = MoneyService.create(new Decimal(1500));
const compact2MoneyResult = MoneyService.create(new Decimal(2300000));
if (compact1MoneyResult.ok && compact2MoneyResult.ok) {
  const compact1 = MoneyFormatter.toCompact(compact1MoneyResult.value);
  if (compact1.ok) console.log(compact1.value);  // "$1.5K"
  const compact2 = MoneyFormatter.toCompact(compact2MoneyResult.value);
  if (compact2.ok) console.log(compact2.value);  // "$2.3M"
}
```

### Операции с Ratio (проценты, доли)

```typescript
import { MoneyService, Money } from '@polymarket/value-objects/money';
import { Ratio } from '@polymarket/value-objects/ratio';
import Decimal from 'decimal.js';

// 1. Вычисление доли (portion) - fees, allocations
const orderAmountResult = MoneyService.create(new Decimal(1000));
if (!orderAmountResult.ok) {
  console.error('Failed to create Money');
  return;
}

const orderAmount = orderAmountResult.value;
const feeRate = Ratio.of(new Decimal(0.02)); // 2%

const feeResult = MoneyService.portion(orderAmount, feeRate);
if (feeResult.ok) {
  console.log(feeResult.value.value().toString()); // "20" USDC (2% от $1000)
}

// 2. Увеличение на процент (increaseBy) - markup, interest
const baseCostResult = MoneyService.create(new Decimal(100));
if (!baseCostResult.ok) {
  console.error('Failed to create Money');
  return;
}

const baseCost = baseCostResult.value;
const markup = Ratio.of(new Decimal(0.2)); // +20%

const priceResult = MoneyService.increaseBy(baseCost, markup);
if (priceResult.ok) {
  console.log(priceResult.value.value().toString()); // "120" USDC (+20%)
}

// 3. Уменьшение на процент (decreaseBy) - discount
const originalPriceResult = MoneyService.create(new Decimal(100));
if (!originalPriceResult.ok) {
  console.error('Failed to create Money');
  return;
}

const originalPrice = originalPriceResult.value;
const discount = Ratio.of(new Decimal(0.15)); // 15% discount

const finalPriceResult = MoneyService.decreaseBy(originalPrice, discount);
if (finalPriceResult.ok) {
  console.log(finalPriceResult.value.value().toString()); // "85" USDC (-15%)
}

// 4. Workflow: fee calculation + discount
const totalResult = MoneyService.create(new Decimal(5000));
if (!totalResult.ok) {
  console.error('Failed to create Money');
  return;
}

const total = totalResult.value;

// Вычисляем allocation 30%
const allocRate = Ratio.of(new Decimal(0.3));
const allocResult = MoneyService.portion(total, allocRate);
if (allocResult.ok) {
  console.log(`Allocation: $${allocResult.value.value()}`); // $1500

  // Применяем discount 10% к allocation
  const discountRate = Ratio.of(new Decimal(0.1));
  const finalResult = MoneyService.decreaseBy(allocResult.value, discountRate);
  if (finalResult.ok) {
    console.log(`After discount: $${finalResult.value.value()}`); // $1350
  }
}
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

---

## Дополнительные ресурсы

- [Архитектура и паттерны](./architecture.md)
- [Core Layer API](./core.md)
- [Facade Layer API](./facade.md)
- [Adapters Layer](./adapters.md)
- [Примеры использования](./examples.md)

---

## Поддержка

Вопросы? Проблемы? Создайте issue в репозитории.

**Версия:** 0.1.0
**Последнее обновление:** 1 февраля 2026
