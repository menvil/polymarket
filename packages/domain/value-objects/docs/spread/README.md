# Spread Value Object — Полная документация

> Иммутабельный value object для представления спреда (bid-ask spread) на рынках предсказаний Polymarket

## 📋 Содержание

1. [Введение](#введение)
2. [Быстрый старт](#быстрый-старт)
3. [Архитектура](#архитектура)
4. [Слои системы](#слои-системы)
5. [API Reference](#api-reference)
6. [Примеры использования](#примеры-использования)
7. [Polymarket-специфика](#polymarket-специфика)

---

## Введение

**Spread** — это value object для работы со спредами (разницей между bid и ask ценами) на рынках предсказаний Polymarket. Модуль построен на архитектуре **Throws+Facade** с чётким разделением на 4 слоя.

### Ключевые особенности

✅ **Type-safe** — все операции возвращают `Result<T, E>`, нет runtime `undefined`
✅ **Иммутабельный** — все операции создают новые экземпляры
✅ **Высокоточный** — использует `Decimal.js` для произвольной точности
✅ **Строгие сравнения** — только точные сравнения через `equals()`, без epsilon
✅ **Polymarket-aligned** — работает с Price объектами в диапазоне [0.0001, 0.9999]
✅ **Layered Architecture** — чёткое разделение ответственности
✅ **100% Test Coverage** — все слои покрыты тестами (86 тестов)

### Что такое Spread?

**Spread (спред)** — это разница между:

- **Bid** (цена покупки) — максимальная цена, которую готовы заплатить покупатели
- **Ask** (цена продажи) — минимальная цена, по которой готовы продать продавцы

**Инвариант:** `bid ≤ ask` (bid не может быть больше ask)

### Когда использовать Spread

- Отображение bid-ask цен в ордербуке
- Расчёт ликвидности рынка (узкий спред = высокая ликвидность)
- Вычисление mid price (средней цены между bid и ask)
- Анализ торговых условий
- Валидация маркет-мейкерских стратегий

### Почему отдельный Value Object?

Spread ≠ просто две цены:

- **Семантика** — bid и ask имеют чёткую связь (bid ≤ ask)
- **Операции** — специфические методы (tighten, widen, shift, midpoint)
- **Инварианты** — гарантии на уровне типов
- **Polymarket-специфика** — работа с вероятностными ценами

---

## Быстрый старт

### Установка

```bash
npm install @polymarket/value-objects
```

### Базовое использование

```typescript
import { SpreadService, Spread } from '@polymarket/value-objects';

// Создание спреда из чисел
const result = SpreadService.fromValues(0.48, 0.52);
if (!result.ok) {
  console.error(result.error.message);
  return;
}

const spread = result.value;

// Получение bid и ask цен
console.log(spread.bid().toNumber());  // 0.48
console.log(spread.ask().toNumber());  // 0.52

// Вычисление характеристик спреда
console.log(spread.width().toNumber());     // 0.04
console.log(spread.midpoint().toNumber());  // 0.50
console.log(spread.widthPercentage().toNumber());  // 8 (8%)

// Сужение спреда (tighten)
const tightenResult = SpreadService.tighten(spread, 0.01);
if (tightenResult.ok) {
  const tighter = tightenResult.value;
  console.log(tighter.bid().toNumber());  // 0.49
  console.log(tighter.ask().toNumber());  // 0.51
}

// Расширение спреда (widen)
const widenResult = SpreadService.widen(spread, 0.02);
if (widenResult.ok) {
  const wider = widenResult.value;
  console.log(wider.bid().toNumber());   // 0.46
  console.log(wider.ask().toNumber());   // 0.54
}

// Сдвиг спреда вверх
const shiftResult = SpreadService.shift(spread, 0.10);
if (shiftResult.ok) {
  const shifted = shiftResult.value;
  console.log(shifted.bid().toNumber());  // 0.58
  console.log(shifted.ask().toNumber());  // 0.62
}
```

### Обработка ошибок

```typescript
import { SpreadService, SpreadErrorReason } from '@polymarket/value-objects';

const result = SpreadService.fromValues(0.60, 0.50);  // bid > ask!

if (!result.ok) {
  console.error(result.error.message);
  // "Spread invariant violation: bid 0.6 cannot be greater than ask 0.5"
  
  console.log(result.error.context?.reason);
  // SpreadErrorReason.BID_GREATER_THAN_ASK
  
  console.log(result.error.context?.bid);   // "0.6"
  console.log(result.error.context?.ask);   // "0.5"
}
```

---

## Архитектура

### 4-слойная структура

```text
┌─────────────────────────────────────────────────────┐
│                  User Code                          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 4: Adapters                                  │
│  - SpreadSerializer (JSON/DTO)                      │
│  - SpreadFormatter (display formatting)             │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 3: Facade (Public API)                       │
│  - SpreadService                                    │
│  - Catches exceptions → Result<T, E>                │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 2: Rules (Business Validations)              │
│  - ValidateBidAsk                                   │
│  - ValidateMinWidth / ValidateMaxWidth              │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 1: Core (Domain Logic)                       │
│  - Spread                                           │
│  - SpreadInvariantViolation                         │
│  - Throws typed exceptions                          │
└─────────────────────────────────────────────────────┘
```

Подробнее: [architecture.md](./architecture.md)

---

## Слои системы

### 1. Core Layer — доменная логика

**Файлы:**

- `src/spread/core/Spread.ts` — основной Value Object
- `src/spread/core/SpreadInvariantViolation.ts` — typed exception
- `src/spread/core/SpreadErrorReason.ts` — enum причин ошибок

**Ответственность:**

- Хранение bid/ask цен как Price объектов
- Инварианты (bid ≤ ask)
- Чистые вычисления (width, midpoint, widthPercentage)
- Бросает `SpreadInvariantViolation` при нарушении инвариантов

**Пример:**

```typescript
import { Spread } from '@polymarket/value-objects';
import { Price } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

const bid = Price.of(new Decimal(0.48));
const ask = Price.of(new Decimal(0.52));

const spread = Spread.of(bid, ask);  // может бросить исключение
console.log(spread.width().toNumber());  // 0.04
```

Подробнее: [core.md](./core.md)

### 2. Rules Layer — бизнес-валидации

**Файлы:**

- `src/spread/rules/ValidateBidAsk.ts` — проверка bid ≤ ask
- `src/spread/rules/ValidateMinWidth.ts` — проверка минимальной ширины
- `src/spread/rules/ValidateMaxWidth.ts` — проверка максимальной ширины

**Ответственность:**

- Бизнес-правила валидации
- Возвращают `Result<void, InvalidSpreadError>`
- Расширяемые правила для custom валидаций

**Пример:**

```typescript
import { ValidateBidAsk } from '@polymarket/value-objects/spread/rules';

const result = ValidateBidAsk.check(bid, ask);
if (!result.ok) {
  console.error(result.error.context?.reason);
}
```

### 3. Facade Layer — публичный API

**Файлы:**

- `src/spread/facade/SpreadService.ts` — главный сервис

**Ответственность:**

- Единственный публичный API для потребителей
- Перехватывает исключения из Core
- Возвращает `Result<Spread, InvalidSpreadError>`
- Never Throw Contract — никогда не бросает исключений

**Основные методы:**

- `create(bid, ask)` — создание из Price объектов
- `fromValues(bid, ask)` — создание из чисел/Decimal
- `zero(price)` — спред нулевой ширины
- `tighten(spread, amount)` — сужение спреда
- `widen(spread, amount)` — расширение спреда
- `shift(spread, amount)` — сдвиг спреда

Подробнее: [facade.md](./facade.md)

### 4. Adapters Layer — сериализация и форматирование

**Файлы:**

- `src/spread/adapters/SpreadSerializer.ts` — JSON/DTO конвертация
- `src/spread/adapters/SpreadFormatter.ts` — форматирование для UI

**Ответственность:**

- Сериализация/десериализация
- Форматирование для отображения
- Конвертация в/из внешних форматов

Подробнее: [adapters.md](./adapters.md)

---

## API Reference

### SpreadService (Facade)

#### Фабричные методы

```typescript
// Создание из Price объектов
SpreadService.create(bid: Price, ask: Price): Result<Spread, InvalidSpreadError>

// Создание из чисел/Decimal
SpreadService.fromValues(
  bid: number | string | Decimal,
  ask: number | string | Decimal
): Result<Spread, InvalidSpreadError>

// Спред нулевой ширины (bid = ask)
SpreadService.zero(price: Price): Spread
```

#### Операции

```typescript
// Сужение спреда (bid+amount, ask-amount)
SpreadService.tighten(
  spread: Spread,
  amount: number | Decimal
): Result<Spread, InvalidSpreadError>

// Расширение спреда (bid-amount, ask+amount)
SpreadService.widen(
  spread: Spread,
  amount: number | Decimal
): Result<Spread, InvalidSpreadError>

// Сдвиг спреда (bid+amount, ask+amount)
SpreadService.shift(
  spread: Spread,
  amount: number | Decimal
): Result<Spread, InvalidSpreadError>
```

### Spread (Core)

#### Геттеры

```typescript
spread.bid(): Price              // Цена покупки
spread.ask(): Price              // Цена продажи
spread.width(): Decimal          // Ширина спреда (ask - bid)
spread.midpoint(): Decimal       // Середина (bid + ask) / 2
spread.widthPercentage(): Decimal // Ширина в % от mid price
```

#### Утилиты

```typescript
spread.equals(other: Spread): boolean     // Сравнение
spread.isZeroWidth(): boolean             // Проверка на нулевую ширину
spread.contains(price: Price): boolean    // Проверка вхождения цены
```

### SpreadSerializer

```typescript
SpreadSerializer.toJSON(spread: Spread): SpreadJSON
SpreadSerializer.fromJSON(json: unknown): Result<Spread, InvalidSpreadError>
SpreadSerializer.toJSONString(spread: Spread): string
SpreadSerializer.fromJSONString(jsonString: string): Result<Spread, InvalidSpreadError>
```

### SpreadFormatter

```typescript
SpreadFormatter.format(spread: Spread, options?: FormatOptions): string
SpreadFormatter.toBidAskString(spread: Spread, decimals?: number): string
SpreadFormatter.toDetailedString(spread: Spread, decimals?: number): string
SpreadFormatter.toObject(spread: Spread): SpreadObject
```

---

## Примеры использования

Полные примеры реальных сценариев: [examples.md](./examples.md)

### Отображение ордербука

```typescript
import { SpreadService, SpreadFormatter } from '@polymarket/value-objects';

function displayOrderBook(bidPrice: number, askPrice: number) {
  const spreadResult = SpreadService.fromValues(bidPrice, askPrice);
  
  if (!spreadResult.ok) {
    return `Error: ${spreadResult.error.message}`;
  }
  
  const spread = spreadResult.value;
  
  return {
    display: SpreadFormatter.format(spread, { decimals: 4 }),
    // "0.4800-0.5200 (0.0400)"
    
    bid: spread.bid().toNumber(),
    ask: spread.ask().toNumber(),
    midPrice: spread.midpoint().toNumber(),
    spreadBps: (spread.widthPercentage() * 100).toFixed(0) + ' bps'
  };
}

console.log(displayOrderBook(0.48, 0.52));
// {
//   display: "0.4800-0.5200 (0.0400)",
//   bid: 0.48,
//   ask: 0.52,
//   midPrice: 0.50,
//   spreadBps: "800 bps"
// }
```

### Маркет-мейкинг стратегия

```typescript
import { SpreadService } from '@polymarket/value-objects';

function applyMarketMakingStrategy(
  currentSpread: Spread,
  targetWidthBps: number
) {
  const currentWidthBps = currentSpread.widthPercentage() * 100;
  const mid = currentSpread.midpoint();
  
  // Рассчитываем новую ширину в абсолютных величинах
  const targetWidth = mid.mul(targetWidthBps / 10000);
  const currentWidth = currentSpread.width();
  
  const diff = targetWidth.minus(currentWidth).div(2);
  
  if (diff.greaterThan(0)) {
    // Нужно расширить
    return SpreadService.widen(currentSpread, diff.toNumber());
  } else {
    // Нужно сузить
    return SpreadService.tighten(currentSpread, diff.abs().toNumber());
  }
}
```

---

## Polymarket-специфика

### Работа с вероятностными ценами

Spread работает с Price объектами, которые представляют вероятности:

- Диапазон: [0.0001, 0.9999] (0.01% — 99.99%)
- Базовый тик: 0.0001 (1 basis point)

```typescript
const spreadResult = SpreadService.fromValues(0.4567, 0.4892);
// Bid = 45.67% probability
// Ask = 48.92% probability
// Width = 3.25% probability
```

### Ограничения

```typescript
// ❌ Bid не может быть больше Ask
SpreadService.fromValues(0.60, 0.50);  // Err

// ❌ Цены должны быть в допустимом диапазоне
SpreadService.fromValues(0.00005, 0.50);  // Err (bid < MIN_PRICE)
SpreadService.fromValues(0.50, 1.5);      // Err (ask > MAX_PRICE)

// ✅ Нулевая ширина разрешена (bid = ask)
SpreadService.fromValues(0.50, 0.50);  // Ok
```

### Интеграция с Price

```typescript
import { PriceService, SpreadService } from '@polymarket/value-objects';

// Из отдельных Price объектов
const bidResult = PriceService.create(0.48);
const askResult = PriceService.create(0.52);

if (bidResult.ok && askResult.ok) {
  const spread = SpreadService.create(bidResult.value, askResult.value);
}

// Или напрямую из чисел
const spread = SpreadService.fromValues(0.48, 0.52);
```

---

## Дальнейшее чтение

- [Архитектура](./architecture.md) — подробности архитектурных решений
- [Core Layer](./core.md) — детали доменной модели
- [Facade API](./facade.md) — полное описание публичного API
- [Примеры](./examples.md) — реальные сценарии использования
- [Адаптеры](./adapters.md) — сериализация и форматирование
