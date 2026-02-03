# Percentage Value Object — Полная документация

> Иммутабельный value object для представления процентных значений в Polymarket

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

**Percentage** — это value object для работы с процентными значениями (fees, spreads, PnL) в Polymarket. Модуль построен на архитектуре **Throws+Facade** с чётким разделением на 4 слоя.

### Ключевые особенности

✅ **Type-safe** — все операции возвращают `Result<T, E>`, нет runtime `undefined`
✅ **Иммутабельный** — все операции создают новые экземпляры
✅ **Высокоточный** — использует `Decimal.js` для произвольной точности
✅ **Polymarket-aligned** — диапазон [-1,000,000%, 1,000,000%], поддержка fees/spreads
✅ **Layered Architecture** — чёткое разделение ответственности
✅ **errorUtils Integration** — централизованный error handling (-100% дублирования)

### Когда использовать Percentage

- **Fees (комиссии):** maker fee, taker fee, protocol fee
- **Spreads (спреды):** bid-ask spread, market spread
- **PnL (прибыль/убыток):** в процентах от начального капитала
- **Изменения цен:** процентное изменение цены актива
- **Доходность:** процентная доходность инвестиций

### Почему не Price?

Percentage ≠ Price, хотя оба могут быть в диапазоне [0, 1]:

- **Percentage** — процентная ставка (0-100%, шкала 0-100), может быть отрицательной
- **Price** — цена исхода на рынке (0.0001-0.9999, шкала 0-1), всегда положительная

---

## Быстрый старт

### Установка

```bash
npm install @polymarket/value-objects
```

### Базовое использование

```typescript
import { PercentageService, Percentage } from '@polymarket/value-objects';

// Создание процента
const result = PercentageService.create(50);
if (!result.ok) {
  console.error(result.error.message);
  return;
}

const pct = result.value;
console.log(pct.toNumber()); // 50

// Математические операции
const pct2Result = PercentageService.create(25);
if (pct2Result.ok) {
  const sumResult = PercentageService.add(pct, pct2Result.value);
  if (sumResult.ok) {
    console.log(sumResult.value.toNumber()); // 75
  }
}

// Конверсии
console.log(pct.toDecimal());       // 0.5 (десятичная дробь)
console.log(pct.toBasisPoints());   // 5000 bp (базисные пункты)
```

---

## Архитектура

Percentage модуль построен на **4-слойной архитектуре** с паттерном **Throws+Facade**:

```text
┌─────────────────────────────────────────────────┐
│           Adapters Layer                        │
│  (Formatters, Serializers)                      │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Facade Layer                          │
│  (PercentageService - Result<T, E>)             │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│            Core Layer                           │
│  (Percentage - throws на инварианты)            │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│           Rules Layer                           │
│  (Validate* правила)                            │
└─────────────────────────────────────────────────┘
```

### Принципы архитектуры

1. **Core (Percentage)** — throws при нарушении инвариантов, ТОЛЬКО инварианты
2. **Facade (PercentageService)** — Result-based API, НИКОГДА не бросает исключения
3. **Adapters** — форматирование и сериализация
4. **Rules** — контекстуальные бизнес-правила (fees, spreads)

📖 **Подробнее:** [architecture.md](./architecture.md)

---

## Слои системы

### 1. Core Layer

**Файлы:**

- `Percentage.ts` — Value Object (433 строки)
- `PercentageInvariantViolation.ts` — Exception класс
- `PercentageErrorReason.ts` — Typed error reasons (13 значений)

**Инварианты:**

- `value.isFinite()` — не NaN, не Infinity
- `value >= -1,000,000%` — минимальное значение
- `value <= 1,000,000%` — максимальное значение

📖 **Подробнее:** [core.md](./core.md)

### 2. Facade Layer

**Файлы:**

- `PercentageService.ts` — Result-based API (540 строк)

**Методы:**

- **Создание:** `create()`, `fromDecimalFraction()`, `fromBasisPoints()`
- **Операции:** `add()`, `subtract()`, `multiply()`, `divide()`, `applyTo()`

**Интеграция errorUtils:**

- Использует `toDecimal()`, `wrapOp()`, `rewrap()` из централизованного модуля
- **-100% дублирования** error handling кода
- **-77% LOC** по сравнению со старой реализацией

📖 **Подробнее:** [facade.md](./facade.md)

### 3. Adapters Layer

**Файлы:**

- `PercentageFormatter.ts` — Форматирование (176 строк)
- `PercentageSerializer.ts` — JSON сериализация (158 строк)

**Методы форматирования:**

- `toFixed()` — фиксированное количество знаков
- `toPercent()` — с символом % ("50.00%")
- `toDecimalFraction()` — десятичная дробь ("0.5000")
- `toBasisPoints()` — базисные пункты ("5000 bp")
- `toCompact()` — компактный формат

📖 **Подробнее:** [adapters.md](./adapters.md)

### 4. Rules Layer

**Файлы:**

- `ValidateFeeNonNegative.ts` — Проверка fee >= 0%
- `ValidateFeeForTrading.ts` — Проверка fee в [0%, 5%]
- `ValidateTotalFee.ts` — Проверка суммарной fee <= 10%
- `ValidateSpreadNonNegative.ts` — Проверка spread >= 0%
- `ValidateSpreadRange.ts` — Проверка spread в [min, max]

📖 **Подробнее:** [rules.md](./rules.md)

---

## API Reference

### PercentageService (Facade)

```typescript
// Создание
PercentageService.create(value: number | string | Decimal): Result<Percentage, InvalidPercentageError>
PercentageService.fromDecimalFraction(decimal: number | string | Decimal): Result<Percentage, InvalidPercentageError>
PercentageService.fromBasisPoints(bp: number | string | Decimal): Result<Percentage, InvalidPercentageError>

// Математика
PercentageService.add(a: Percentage, b: Percentage): Result<Percentage, InvalidPercentageError>
PercentageService.subtract(a: Percentage, b: Percentage): Result<Percentage, InvalidPercentageError>
PercentageService.multiply(pct: Percentage, factor: number | string | Decimal): Result<Percentage, InvalidPercentageError>
PercentageService.divide(pct: Percentage, divisor: number | string | Decimal): Result<Percentage, InvalidPercentageError>
PercentageService.applyTo(pct: Percentage, value: Decimal): Result<Decimal, InvalidPercentageError>
```

### Percentage (Core)

```typescript
// Константы
Percentage.ZERO        // 0%
Percentage.ONE_HUNDRED // 100%

// Методы
value(): Decimal                     // Внутреннее значение (шкала 0-100)
toNumber(): number                   // Конверсия в number (lossy)
toDecimal(): Decimal                 // Конверсия в дробь (0-1)
toBasisPoints(): Decimal             // Конверсия в bp (100 bp = 1%)
equals(other: Percentage): boolean   // Строгое равенство
isZero(): boolean                    // Проверка на 0
isPositive(): boolean                // Проверка > 0
isNegative(): boolean                // Проверка < 0
```

### PercentageFormatter (Adapters)

```typescript
PercentageFormatter.toFixed(pct: Percentage, decimals?: number): string
PercentageFormatter.toPercent(pct: Percentage, decimals?: number): string
PercentageFormatter.toDecimalFraction(pct: Percentage, decimals?: number): string
PercentageFormatter.toBasisPoints(pct: Percentage, decimals?: number): string
PercentageFormatter.toCompact(pct: Percentage, decimals?: number): string
```

### PercentageSerializer (Adapters)

```typescript
PercentageSerializer.toJSON(pct: Percentage): { value: string }
PercentageSerializer.fromJSON(json: unknown): Result<Percentage, InvalidPercentageError>
```

---

## Примеры использования

### Пример 1: Trading Fees

```typescript
import { PercentageService, ValidateFeeForTrading } from '@polymarket/value-objects';

// Создание maker fee
const makerFeeResult = PercentageService.create(0.5); // 0.5%
if (!makerFeeResult.ok) {
  console.error('Invalid maker fee:', makerFeeResult.error);
  return;
}

// Валидация торговой комиссии
const validateResult = ValidateFeeForTrading.check(makerFeeResult.value);
if (!validateResult.ok) {
  console.error('Fee validation failed:', validateResult.error);
  return;
}

console.log('✅ Valid trading fee');
```

### Пример 2: Spread Calculation

```typescript
import { PercentageService, ValidateSpreadRange } from '@polymarket/value-objects';

// Вычисление спреда
const bidPrice = 0.48;
const askPrice = 0.52;
const spreadDecimal = askPrice - bidPrice; // 0.04

const spreadResult = PercentageService.fromDecimalFraction(spreadDecimal);
if (!spreadResult.ok) {
  console.error('Invalid spread:', spreadResult.error);
  return;
}

// Валидация спреда
const validateResult = ValidateSpreadRange.check(spreadResult.value);
if (validateResult.ok) {
  console.log(`Spread: ${spreadResult.value.toNumber()}%`); // 4%
}
```

### Пример 3: PnL Calculation

```typescript
import { PercentageService, PercentageFormatter } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

const initialCapital = new Decimal(10000);
const currentCapital = new Decimal(11500);

// Вычисление PnL в процентах
const pnlDecimal = currentCapital.minus(initialCapital).dividedBy(initialCapital);
const pnlResult = PercentageService.fromDecimalFraction(pnlDecimal);

if (pnlResult.ok) {
  const pnl = pnlResult.value;
  console.log(`PnL: ${PercentageFormatter.toPercent(pnl)}`); // "15.00%"
  console.log(`PnL (compact): ${PercentageFormatter.toCompact(pnl)}`); // "15.0%"
}
```

📖 **Больше примеров:** [examples.md](./examples.md)

---

## Polymarket-специфика

### Fees (Комиссии)

Polymarket использует процентные комиссии для торговли:

- **Maker Fee:** комиссия за создание ордера (обычно 0-2%)
- **Taker Fee:** комиссия за исполнение ордера (обычно 0.5-3%)
- **Protocol Fee:** комиссия протокола (фиксированная)

**Правила:**

- Отдельная комиссия: [0%, 5%] (ValidateFeeForTrading)
- Суммарная комиссия: <= 10% (ValidateTotalFee)

### Spreads (Спреды)

Spread — разница между bid и ask ценой:

```typescript
spread = (askPrice - bidPrice) / midPrice * 100%
```

**Правила:**

- Минимальный spread: 0% (ValidateSpreadNonNegative)
- Максимальный spread: 10% по умолчанию (ValidateSpreadRange)

### Basis Points

В финансовых расчётах часто используются базисные пункты (bp):

- 1 bp = 0.01%
- 100 bp = 1%
- 10000 bp = 100%

```typescript
const feeResult = PercentageService.fromBasisPoints(50); // 50 bp = 0.5%
```

---

## Миграция

### Миграция со старого API

**Старый код:**

```typescript
// Было: throws exceptions
const pct = Percentage.of(50);
const sum = pct.add(other);
```

**Новый код:**

```typescript
// Стало: Result-based, never throws
const result = PercentageService.create(50);
if (!result.ok) {
  console.error(result.error);
  return;
}

const sumResult = PercentageService.add(result.value, other);
if (!sumResult.ok) {
  console.error(sumResult.error);
  return;
}
```

📖 **Подробнее:** [migration.md](./migration.md)

---

## Связанные документы

- [Архитектура](./architecture.md) — детальное описание архитектуры
- [Core Layer](./core.md) — документация Core слоя
- [Facade Layer](./facade.md) — документация Facade слоя
- [Adapters Layer](./adapters.md) — документация Adapters слоя
- [Rules Layer](./rules.md) — документация Rules слоя
- [Примеры](./examples.md) — практические примеры
- [Миграция](./migration.md) — руководство по миграции

---

**Версия:** 1.0.0
**Дата:** 2026-02-02
**Архитектура:** Core/Facade/Adapters/Rules + errorUtils
