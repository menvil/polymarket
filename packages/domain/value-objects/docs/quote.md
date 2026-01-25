# Quote

**Quote** — value object, представляющий двухстороннюю котировку маркет-мейкера для prediction markets.

## Оглавление

- [Обзор](#обзор)
- [Создание Quote](#создание-quote)
- [Метрики](#метрики)
- [Проверки типа](#проверки-типа)
- [Определение пересечения с рынком](#определение-пересечения-с-рынком)
- [Операции](#операции)
- [Утилиты](#утилиты)
- [Сериализация](#сериализация)
- [Примеры использования](#примеры-использования)
- [Best Practices](#best-practices)
- [Архитектурные решения](#архитектурные-решения)
- [TypeScript Definition](#typescript-definition)

## Обзор

Quote инкапсулирует двухстороннюю котировку (bid/ask) как единый value object. Это критически важный компонент для маркет-мейкинга в prediction markets.

### Структура котировки

```text
Bid: 0.64 @ 100 shares   |   Ask: 0.66 @ 100 shares
     ↓                    |        ↓
  Цена покупки            |   Цена продажи
  (готовы купить)         |   (готовы продать)
         ↓                         ↓
         └─────── Spread: 0.02 ─────┘
                     ↓
              Mid Price: 0.65
```

### Зачем нужен Quote?

1. **Инкапсуляция**: Котировка как единый объект вместо разрозненных bid/ask/sizes
2. **Валидация**: Гарантирует корректность (bid < ask, положительные размеры, consistency)
3. **Метрики**: Автоматический расчёт spread и mid-price
4. **Проверка crossing**: Определяет, пересечётся ли котировка с текущим рынком
5. **Управление**: Простые операции для корректировки котировок (inventory skew, spread adjustment)

### Односторонние котировки

Quote поддерживает односторонние котировки (bid-only или ask-only):

```typescript
// Только bid (готовы купить, но не продавать)
const bidOnly = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  null,
  unwrap(Quantity.fromValue(100)),
  Quantity.zero()
));

// Только ask (готовы продать, но не покупать)
const askOnly = unwrap(Quote.create(
  null,
  unwrap(Price.fromValue(0.66)),
  Quantity.zero(),
  unwrap(Quantity.fromValue(100))
));
```

## Стили использования Result API

Result API поддерживает два стиля: **функциональный** и **OOP**. Оба полностью совместимы.

### Функциональный стиль

```typescript
import { unwrap } from '@polymarket/result';

const result = Quote.create(bid, ask, bidSize, askSize);
if (result.ok) {
  const quote = result.value;
} else {
  console.error(result.error.message);
}

// Unwrap helper
const quote = unwrap(Quote.create(bid, ask, bidSize, askSize));
```

### OOP стиль

```typescript
import { OkChain } from '@polymarket/result';

const result = Quote.create(bid, ask, bidSize, askSize);
if (result.isOk()) {
  const quote = result.unwrap();
} else {
  const error = result.unwrapErr();
}

// OkChain helper
const quote = OkChain(Quote.create(bid, ask, bidSize, askSize));
```

## Создание Quote

### create

Создаёт Quote из Price и Quantity объектов.

```typescript
Quote.create(
  bid: Price | null,
  ask: Price | null,
  bidSize: Quantity,
  askSize: Quantity,
  timestamp?: Date
): Result<Quote, InvalidQuoteError>
```

**Параметры:**
- `bid` — цена покупки (null для ask-only котировки)
- `ask` — цена продажи (null для bid-only котировки)
- `bidSize` — объём на bid
- `askSize` — объём на ask
- `timestamp` — временная метка (по умолчанию: текущее время)

**Валидация:**
- Хотя бы одна сторона (bid или ask) должна присутствовать
- Если обе стороны присутствуют: bid < ask
- Размеры должны быть неотрицательными
- Если bid = null, то bidSize должен быть 0
- Если ask = null, то askSize должен быть 0

**Примеры:**

```typescript
import { unwrap } from '@polymarket/result';
import { Quote } from '@polymarket/value-objects';
import { Price } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';

// Двухсторонняя котировка
const bid = unwrap(Price.fromValue(0.64));
const ask = unwrap(Price.fromValue(0.66));
const bidSize = unwrap(Quantity.fromValue(100));
const askSize = unwrap(Quantity.fromValue(100));

const result = Quote.create(bid, ask, bidSize, askSize);
if (result.ok) {
  const quote = result.value;
  console.log(quote.toString());
  // "0.6400 (100) / 0.6600 (100) [spread: 0.0200]"
} else {
  console.error(result.error.message);
}

// Или используя unwrap
const quote = unwrap(Quote.create(bid, ask, bidSize, askSize));

// Котировка только bid
const bidOnly = unwrap(Quote.create(
  bid,
  null,
  bidSize,
  Quantity.zero()
));

// Котировка только ask
const askOnly = unwrap(Quote.create(
  null,
  ask,
  Quantity.zero(),
  askSize
));

// Ошибка: bid >= ask
const invalid = Quote.create(
  unwrap(Price.fromValue(0.66)),
  unwrap(Price.fromValue(0.64)),
  bidSize,
  askSize
);
console.log(invalid.ok); // false
```

## Метрики

### getSpread

Вычисляет спред котировки (ask - bid).

```typescript
getSpread(): Result<number, InvalidQuoteError>
```

**Возвращает:** Result с числом спреда или InvalidQuoteError для односторонней котировки

**Примеры:**

```typescript
const quote = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

// Обработка Result
const spreadResult = quote.getSpread();
if (spreadResult.ok) {
  console.log(spreadResult.value); // 0.02
} else {
  console.error(spreadResult.error.message);
}

// Или используя unwrap
const spread = unwrap(quote.getSpread());
console.log(spread); // 0.02

// Ошибка для односторонней котировки
const bidOnly = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  null,
  unwrap(Quantity.fromValue(100)),
  Quantity.zero()
));

const result = bidOnly.getSpread();
console.log(result.ok); // false
console.log(result.error?.message); // "Cannot calculate spread for one-sided quote"
```

### getMidPrice

Вычисляет среднюю цену котировки ((bid + ask) / 2).

```typescript
getMidPrice(): Result<Price, InvalidQuoteError>
```

**Возвращает:** Result с Price или InvalidQuoteError для односторонней котировки

**Примеры:**

```typescript
const quote = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

// Обработка Result
const midResult = quote.getMidPrice();
if (midResult.ok) {
  console.log(midResult.value.value); // 0.65
} else {
  console.error(midResult.error.message);
}

// Или используя unwrap
const mid = unwrap(quote.getMidPrice());
console.log(mid.value); // 0.65

// Mid price часто используется как "справедливая" цена рынка
const fairValue = unwrap(quote.getMidPrice());
```

## Проверки типа

### isTwoSided

Проверяет, является ли котировка двухсторонней (присутствуют и bid, и ask).

```typescript
isTwoSided(): boolean
```

**Примеры:**

```typescript
const twoSided = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));
console.log(twoSided.isTwoSided()); // true

const bidOnly = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  null,
  unwrap(Quantity.fromValue(100)),
  Quantity.zero()
));
console.log(bidOnly.isTwoSided()); // false
```

### isBidOnly

Проверяет, является ли котировка только bid (присутствует только bid).

```typescript
isBidOnly(): boolean
```

**Примеры:**

```typescript
const bidOnly = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  null,
  unwrap(Quantity.fromValue(100)),
  Quantity.zero()
));
console.log(bidOnly.isBidOnly()); // true
```

### isAskOnly

Проверяет, является ли котировка только ask (присутствует только ask).

```typescript
isAskOnly(): boolean
```

**Примеры:**

```typescript
const askOnly = unwrap(Quote.create(
  null,
  unwrap(Price.fromValue(0.66)),
  Quantity.zero(),
  unwrap(Quantity.fromValue(100))
));
console.log(askOnly.isAskOnly()); // true
```

## Определение пересечения с рынком

### crossesMarket

Проверяет, пересечётся ли котировка с ценами стакана (order book).

```typescript
crossesMarket(orderbookBid: Price | null, orderbookAsk: Price | null): boolean
```

**Логика пересечения:**
- Наш bid пересекается если `bid >= orderbookAsk` (мы готовы купить по цене ≥ текущего ask)
- Наш ask пересекается если `ask <= orderbookBid` (мы готовы продать по цене ≤ текущего bid)

Если котировка пересекается, она исполнится немедленно (aggressive order).

**Параметры:**
- `orderbookBid` — лучший bid из стакана (может быть null)
- `orderbookAsk` — лучший ask из стакана (может быть null)

**Примеры:**

```typescript
const quote = unwrap(Quote.create(
  unwrap(Price.fromValue(0.67)),  // Наш bid
  unwrap(Price.fromValue(0.68)),  // Наш ask
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

// Рынок: bid=0.65, ask=0.66
const marketBid = unwrap(Price.fromValue(0.65));
const marketAsk = unwrap(Price.fromValue(0.66));

// Наш bid (0.67) >= market ask (0.66) → пересечение!
console.log(quote.crossesMarket(marketBid, marketAsk)); // true

// Пример без пересечения
const safeQuote = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),  // Наш bid
  unwrap(Price.fromValue(0.66)),  // Наш ask
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

// Наш bid (0.64) < market ask (0.66) и наш ask (0.66) >= market bid (0.65)
// Но наш ask равен market ask, так что нет пересечения
console.log(safeQuote.crossesMarket(marketBid, marketAsk)); // false
```

**Использование:**

```typescript
// Перед отправкой котировки на биржу
if (quote.crossesMarket(marketBid, marketAsk)) {
  console.warn('Quote would execute immediately - adjust prices');
  // Корректируем котировку или отменяем
}
```

## Операции

### withAdjustment

Создаёт новую котировку со скорректированными ценами.

```typescript
withAdjustment(bidAdjustment: number, askAdjustment: number): Result<Quote, InvalidQuoteError>
```

**Параметры:**
- `bidAdjustment` — величина для добавления/вычитания из bid (положительная = вверх, отрицательная = вниз)
- `askAdjustment` — величина для добавления/вычитания из ask (положительная = вверх, отрицательная = вниз)

**Возвращает:** Result с новым Quote (со скорректированными ценами и новым timestamp) или InvalidQuoteError

**Использование:**

Этот метод используется для различных стратегий корректировки котировок:

1. **Расширение спреда** (увеличение profit margin):
   ```typescript
   const widened = unwrap(quote.withAdjustment(-0.01, +0.01));
   // bid: 0.64 → 0.63, ask: 0.66 → 0.67, spread: 0.02 → 0.04
   ```

2. **Сужение спреда** (повышение вероятности исполнения):
   ```typescript
   const narrowed = unwrap(quote.withAdjustment(+0.005, -0.005));
   // bid: 0.64 → 0.645, ask: 0.66 → 0.655, spread: 0.02 → 0.01
   ```

3. **Перекос (inventory skew)**:
   ```typescript
   // Слишком много инвентаря → снижаем обе стороны
   // (делаем покупку менее привлекательной)
   const skewed = unwrap(quote.withAdjustment(-0.01, -0.01));
   // bid: 0.64 → 0.63, ask: 0.66 → 0.65
   // Теперь mid = 0.64 вместо 0.65
   ```

4. **Сдвиг вверх/вниз** (следование за рынком):
   ```typescript
   // Рынок движется вверх → сдвигаем котировку вверх
   const shifted = unwrap(quote.withAdjustment(+0.02, +0.02));
   // bid: 0.64 → 0.66, ask: 0.66 → 0.68
   ```

**Примеры:**

```typescript
const baseQuote = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

// Расширить спред
const widened = unwrap(baseQuote.withAdjustment(-0.01, +0.01));
console.log(unwrap(widened.getSpread())); // 0.04

// Перекос к bid (управление запасами)
const skewed = unwrap(baseQuote.withAdjustment(-0.01, -0.01));
console.log(unwrap(skewed.getMidPrice()).value); // 0.64

// Сдвиг вверх
const shifted = unwrap(baseQuote.withAdjustment(+0.05, +0.05));
console.log(shifted.bid?.value); // 0.69
console.log(shifted.ask?.value); // 0.71

// Timestamp обновляется
console.log(shifted.timestamp > baseQuote.timestamp); // true
```

## Утилиты

### toString

Возвращает читаемое строковое представление котировки.

```typescript
toString(): string
```

**Формат:**
- Двухсторонняя: `"bid (size) / ask (size) [spread: X]"`
- Односторонняя: `"bid (size) / N/A"` или `"N/A / ask (size)"`

**Примеры:**

```typescript
const quote = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(150))
));

console.log(quote.toString());
// "0.6400 (100) / 0.6600 (150) [spread: 0.0200]"

const bidOnly = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  null,
  unwrap(Quantity.fromValue(100)),
  Quantity.zero()
));

console.log(bidOnly.toString());
// "0.6400 (100) / N/A"
```

### equals

Проверяет равенство двух котировок.

```typescript
equals(other: Quote): boolean
```

**Логика:** Котировки равны если bid, ask, bidSize и askSize равны. **Timestamp игнорируется.**

**Примеры:**

```typescript
const q1 = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

const q2 = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

console.log(q1.equals(q2)); // true (timestamp не учитывается)

const q3 = unwrap(Quote.create(
  unwrap(Price.fromValue(0.63)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

console.log(q1.equals(q3)); // false (разные bids)
```

## Сериализация

### toJSON

Сериализует котировку в JSON-представление.

```typescript
toJSON(): {
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  timestamp: string;
}
```

**Возвращает:** JSON-объект с ценами в виде чисел и timestamp в виде ISO строки.

**Использование:** Передача данных через API или сохранение в хранилище.

**Примеры:**

```typescript
const quote = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

const json = quote.toJSON();
console.log(json);
// {
//   bid: 0.64,
//   ask: 0.66,
//   bidSize: 100,
//   askSize: 100,
//   timestamp: '2026-01-25T12:00:00.000Z'
// }

// Отправка через API
await fetch('/api/quotes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(quote.toJSON())
});

// Односторонняя котировка
const bidOnly = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  null,
  unwrap(Quantity.fromValue(100)),
  Quantity.ZERO
));

console.log(bidOnly.toJSON());
// {
//   bid: 0.64,
//   ask: null,
//   bidSize: 100,
//   askSize: 0,
//   timestamp: '2026-01-25T12:00:00.000Z'
// }
```

### fromJSON

Десериализует котировку из JSON.

```typescript
Quote.fromJSON(json: {
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  timestamp: string;
}): Result<Quote, InvalidQuoteError>
```

**Параметры:**
- `json` — JSON-объект с данными котировки

**Возвращает:** Result с Quote или InvalidQuoteError

**Валидация:** Все значения валидируются через соответствующие фабричные методы (Price.fromValue, Quantity.fromValue).

**Примеры:**

```typescript
// Десериализация из API
const response = await fetch('/api/quotes/123');
const json = await response.json();

const result = Quote.fromJSON(json);
if (result.ok) {
  const quote = result.value;
  console.log(quote.toString());
} else {
  console.error('Invalid quote data:', result.error.message);
}

// Прямая десериализация
const json = {
  bid: 0.64,
  ask: 0.66,
  bidSize: 100,
  askSize: 100,
  timestamp: '2026-01-25T12:00:00.000Z'
};

const quote = unwrap(Quote.fromJSON(json));
console.log(unwrap(quote.getSpread())); // 0.02

// Ошибка при невалидных данных
const invalidJson = {
  bid: 1.5,  // > 1.0 (invalid price)
  ask: 0.66,
  bidSize: 100,
  askSize: 100,
  timestamp: '2026-01-25T12:00:00.000Z'
};

const invalidResult = Quote.fromJSON(invalidJson);
console.log(invalidResult.ok); // false
console.log(invalidResult.error?.message); // "Invalid bid price: ..."
```

## Примеры использования

### Пример 1: Базовый маркет-мейкинг

Создание и корректировка котировки для маркет-мейкинга.

```typescript
import { unwrap } from '@polymarket/result';
import { Quote, Price, Quantity } from '@polymarket/value-objects';

// 1. Получаем справедливую цену (mid-price) из стакана
const marketBid = unwrap(Price.fromValue(0.64));
const marketAsk = unwrap(Price.fromValue(0.66));
const fairValue = (marketBid.value + marketAsk.value) / 2; // 0.65

// 2. Устанавливаем желаемый спред (например, 2%)
const targetSpread = 0.02;
const halfSpread = targetSpread / 2;

// 3. Создаём базовую котировку
const ourBid = unwrap(Price.fromValue(fairValue - halfSpread)); // 0.64
const ourAsk = unwrap(Price.fromValue(fairValue + halfSpread)); // 0.66
const size = unwrap(Quantity.fromValue(100));

const baseQuote = unwrap(Quote.create(ourBid, ourAsk, size, size));

// 4. Проверяем, не пересекается ли котировка с рынком
if (baseQuote.crossesMarket(marketBid, marketAsk)) {
  console.error('Quote would cross market!');
  // Корректируем цены
}

// 5. Отправляем котировку
console.log(`Sending quote: ${baseQuote.toString()}`);
// "0.6400 (100) / 0.6600 (100) [spread: 0.0200]"
```

### Пример 2: Управление запасами (Inventory Management)

Корректировка котировок на основе текущего инвентаря.

```typescript
import { unwrap } from '@polymarket/result';
import { Quote, Price, Quantity } from '@polymarket/value-objects';

// Текущая позиция в контрактах
let currentPosition = 500; // Положительное = long position
const targetPosition = 0;   // Нейтральная позиция
const maxPosition = 1000;

// Базовая котировка
const baseQuote = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

// Вычисляем перекос (skew) на основе инвентаря
const inventoryRatio = currentPosition / maxPosition; // 0.5
const maxSkew = 0.02; // Максимальный перекос: 2 цента
const skew = inventoryRatio * maxSkew; // 0.01

// Применяем перекос:
// - Если long (избыток инвентаря) → снижаем котировку (делаем продажу привлекательнее)
// - Если short (недостаток) → повышаем котировку (делаем покупку привлекательнее)
const skewedQuote = unwrap(baseQuote.withAdjustment(-skew, -skew));

console.log('Base quote:', baseQuote.toString());
// "0.6400 (100) / 0.6600 (100) [spread: 0.0200]"

console.log('Skewed quote:', skewedQuote.toString());
// "0.6300 (100) / 0.6500 (100) [spread: 0.0200]"
// Mid price сдвинулся с 0.65 до 0.64 → больше вероятность продажи

// После сделки обновляем позицию
currentPosition -= 100; // Продали 100 контрактов
console.log('New position:', currentPosition); // 400
```

### Пример 3: Адаптивный спред на основе волатильности

Расширение спреда в условиях высокой волатильности.

```typescript
import { unwrap } from '@polymarket/result';
import { Quote, Price, Quantity } from '@polymarket/value-objects';

interface MarketConditions {
  volatility: number;      // 0.0 - 1.0
  liquidity: number;       // Объём в стакане
  spreadPercentage: number; // Текущий спред рынка (%)
}

function createAdaptiveQuote(
  fairValue: Price,
  conditions: MarketConditions
): Quote {
  // Базовый спред: 1%
  let baseSpread = 0.01;

  // Увеличиваем спред при высокой волатильности
  if (conditions.volatility > 0.7) {
    baseSpread *= 2; // 2%
  } else if (conditions.volatility > 0.5) {
    baseSpread *= 1.5; // 1.5%
  }

  // Увеличиваем спред при низкой ликвидности
  if (conditions.liquidity < 1000) {
    baseSpread *= 1.5;
  }

  // Не делаем спред уже, чем текущий рынок
  const marketSpread = conditions.spreadPercentage / 100;
  const finalSpread = Math.max(baseSpread, marketSpread);

  const halfSpread = finalSpread / 2;
  const bid = unwrap(Price.fromValue(fairValue.value - halfSpread));
  const ask = unwrap(Price.fromValue(fairValue.value + halfSpread));
  const size = unwrap(Quantity.fromValue(100));

  return unwrap(Quote.create(bid, ask, size, size));
}

// Нормальные условия
const normalConditions: MarketConditions = {
  volatility: 0.3,
  liquidity: 5000,
  spreadPercentage: 1.0
};

const normalQuote = createAdaptiveQuote(
  unwrap(Price.fromValue(0.65)),
  normalConditions
);
console.log('Normal:', unwrap(normalQuote.getSpread())); // ~0.01

// Высокая волатильность + низкая ликвидность
const volatileConditions: MarketConditions = {
  volatility: 0.8,
  liquidity: 500,
  spreadPercentage: 2.0
};

const volatileQuote = createAdaptiveQuote(
  unwrap(Price.fromValue(0.65)),
  volatileConditions
);
console.log('Volatile:', unwrap(volatileQuote.getSpread())); // ~0.03 (wider)
```

### Пример 4: Обнаружение stale quotes и refresh

Проверка устаревших котировок и их обновление.

```typescript
import { unwrap } from '@polymarket/result';
import { Quote, Price, Quantity } from '@polymarket/value-objects';

const QUOTE_TTL_MS = 5000; // Котировка живёт 5 секунд

class QuoteManager {
  private currentQuote: Quote | null = null;

  isStale(quote: Quote): boolean {
    const age = Date.now() - quote.timestamp.getTime();
    return age > QUOTE_TTL_MS;
  }

  refreshQuote(oldQuote: Quote): Quote {
    // Пересоздаём котировку с теми же ценами, но новым timestamp
    return unwrap(Quote.create(
      oldQuote.bid,
      oldQuote.ask,
      oldQuote.bidSize,
      oldQuote.askSize
    ));
  }

  updateQuote(newQuote: Quote): void {
    if (this.currentQuote && !this.isStale(this.currentQuote)) {
      // Проверяем, изменились ли цены
      if (this.currentQuote.equals(newQuote)) {
        console.log('Quote unchanged, skipping update');
        return;
      }
    }

    this.currentQuote = newQuote;
    console.log(`Quote updated: ${newQuote.toString()}`);
  }

  getActiveQuote(): Quote | null {
    if (this.currentQuote && this.isStale(this.currentQuote)) {
      console.log('Quote is stale, refreshing...');
      this.currentQuote = this.refreshQuote(this.currentQuote);
    }

    return this.currentQuote;
  }
}

// Использование
const manager = new QuoteManager();

const quote = unwrap(Quote.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

manager.updateQuote(quote);

// Через 6 секунд
setTimeout(() => {
  const active = manager.getActiveQuote();
  // Котировка обновится с новым timestamp
}, 6000);
```

## Best Practices

### DO ✅

```typescript
// Всегда проверяйте пересечение перед отправкой котировки
if (quote.crossesMarket(marketBid, marketAsk)) {
  console.warn('Quote would cross, adjusting...');
  quote = unwrap(quote.withAdjustment(-0.01, +0.01));
}

// Используйте withAdjustment для управления запасами
const skew = calculateInventorySkew(position);
const adjustedQuote = unwrap(baseQuote.withAdjustment(skew, skew));

// Проверяйте тип котировки перед расчётом метрик
if (quote.isTwoSided()) {
  const spread = unwrap(quote.getSpread());
  const mid = unwrap(quote.getMidPrice());
}

// Обновляйте котировки периодически (новый timestamp)
if (isStale(quote)) {
  quote = unwrap(Quote.create(
    quote.bid,
    quote.ask,
    quote.bidSize,
    quote.askSize
  ));
}

// Используйте Result API для обработки ошибок
const result = Quote.create(bid, ask, bidSize, askSize);
if (!result.ok) {
  console.error('Invalid quote:', result.error.message);
  return;
}
```

### DON'T ❌

```typescript
// Не вызывайте getSpread/getMidPrice без проверки типа
const spread = unwrap(quote.getSpread()); // Может вернуть Err для bid-only!
// Правильно:
if (quote.isTwoSided()) {
  const spread = unwrap(quote.getSpread());
}

// Не создавайте котировки с bid >= ask
const badQuote = Quote.create(
  unwrap(Price.fromValue(0.66)),
  unwrap(Price.fromValue(0.64)), // ask < bid!
  size,
  size
); // Вернёт Err

// Не игнорируйте timestamp
// Устаревшие котировки могут привести к adverse selection
if (Date.now() - quote.timestamp.getTime() > 10000) {
  // Обновите котировку!
}

// Не мутируйте котировки напрямую
quote.bid = newBid; // ❌ readonly properties
// Правильно:
const newQuote = unwrap(Quote.create(newBid, quote.ask, ...));

// Не создавайте котировки без проверки crossing
sendQuote(quote); // Может исполниться немедленно!
// Правильно:
if (!quote.crossesMarket(marketBid, marketAsk)) {
  sendQuote(quote);
}
```

## Архитектурные решения

### 1. Почему Quote допускает null для bid/ask?

**Решение:** Поддержка односторонних котировок.

**Обоснование:**
- В реальных рынках маркет-мейкеры могут выставлять только bid или только ask
- Односторонние котировки полезны для управления риском (например, закрытие позиции)
- Гибкость для различных стратегий

**Альтернативы:**
- Отдельные классы BidQuote/AskQuote — излишняя сложность
- Всегда требовать обе стороны — ограничивает функциональность

### 2. Почему timestamp обновляется при withAdjustment?

**Решение:** Новая котировка = новое время.

**Обоснование:**
- Скорректированная котировка — это фактически новая котировка
- Timestamp нужен для определения stale quotes
- Помогает избежать adverse selection (торговли по устаревшим ценам)

### 3. Почему getSpread/getMidPrice throw вместо возврата null?

**Решение:** Fail-fast при некорректном использовании.

**Обоснование:**
- Вызов getSpread() на односторонней котировке — программная ошибка
- TypeScript проверки не помогут в runtime
- Разработчик должен явно проверить `isTwoSided()` перед вызовом

**Альтернативы:**
- Возвращать `null` — тихие ошибки, сложнее отлаживать
- Возвращать `Option<number>` — дополнительная сложность без преимуществ

### 4. Почему timestamp не участвует в equals()?

**Решение:** Равенство котировок определяется ценами и размерами, не временем.

**Обоснование:**
- Две котировки с одинаковыми ценами/размерами — это одинаковые котировки
- Timestamp — это metadata, не бизнес-данные
- Позволяет сравнивать "эквивалентность" котировок игнорируя время

### 5. Почему crossesMarket принимает отдельные bid/ask вместо другого Quote?

**Решение:** Гибкость и простота.

**Обоснование:**
- Orderbook может быть односторонним (только bid или только ask)
- Не требуется создавать Quote объект для проверки crossing
- Явное указание market bid/ask делает логику понятнее

### 6. Почему нет методов updateBid/updateAsk?

**Решение:** Иммутабельность value objects.

**Обоснование:**
- Value objects должны быть immutable (DDD principle)
- Изменение цен = новая котировка = новый объект
- Иммутабельность упрощает reasoning и предотвращает bugs
- Используйте `withAdjustment()` или `Quote.create()` для создания новых котировок

## TypeScript Definition

```typescript
/**
 * Quote — котировка маркет-мейкера
 */
export class Quote {
  /**
   * Цена покупки (null для ask-only котировки)
   */
  public readonly bid: Price | null;

  /**
   * Цена продажи (null для bid-only котировки)
   */
  public readonly ask: Price | null;

  /**
   * Объём на bid
   */
  public readonly bidSize: Quantity;

  /**
   * Объём на ask
   */
  public readonly askSize: Quantity;

  /**
   * Временная метка котировки
   */
  public readonly timestamp: Date;

  /**
   * Создаёт Quote
   *
   * @param bid - Цена bid (null для котировки только ask)
   * @param ask - Цена ask (null для котировки только bid)
   * @param bidSize - Объём bid
   * @param askSize - Объём ask
   * @param timestamp - Временная метка (по умолчанию: текущее время)
   * @returns Result с Quote или InvalidQuoteError
   */
  public static create(
    bid: Price | null,
    ask: Price | null,
    bidSize: Quantity,
    askSize: Quantity,
    timestamp?: Date
  ): Result<Quote, InvalidQuoteError>;

  /**
   * Вычисляет спред (ask - bid)
   * @returns Result с числом спреда или InvalidQuoteError для односторонней котировки
   */
  public getSpread(): Result<number, InvalidQuoteError>;

  /**
   * Вычисляет среднюю цену ((bid + ask) / 2)
   * @returns Result с Price или InvalidQuoteError для односторонней котировки
   */
  public getMidPrice(): Result<Price, InvalidQuoteError>;

  /**
   * Проверяет, является ли котировка двухсторонней
   */
  public isTwoSided(): boolean;

  /**
   * Проверяет, является ли котировка только bid
   */
  public isBidOnly(): boolean;

  /**
   * Проверяет, является ли котировка только ask
   */
  public isAskOnly(): boolean;

  /**
   * Проверяет, пересечётся ли котировка с ценами стакана
   *
   * @param orderbookBid - Лучший bid из стакана
   * @param orderbookAsk - Лучший ask из стакана
   * @returns True если котировка исполнится немедленно
   */
  public crossesMarket(
    orderbookBid: Price | null,
    orderbookAsk: Price | null
  ): boolean;

  /**
   * Создаёт копию с скорректированными ценами
   *
   * @param bidAdjustment - Величина для добавления/вычитания из bid
   * @param askAdjustment - Величина для добавления/вычитания из ask
   * @returns Result с Quote или InvalidQuoteError
   */
  public withAdjustment(bidAdjustment: number, askAdjustment: number): Result<Quote, InvalidQuoteError>;

  /**
   * Строковое представление
   */
  public toString(): string;

  /**
   * Проверяет равенство с другой котировкой
   * (timestamp игнорируется)
   */
  public equals(other: Quote): boolean;

  /**
   * Сериализует котировку в JSON
   * @returns JSON-представление котировки
   */
  public toJSON(): {
    bid: number | null;
    ask: number | null;
    bidSize: number;
    askSize: number;
    timestamp: string;
  };

  /**
   * Десериализует котировку из JSON
   * @param json - JSON-объект с данными котировки
   * @returns Result с Quote или InvalidQuoteError
   */
  public static fromJSON(json: {
    bid: number | null;
    ask: number | null;
    bidSize: number;
    askSize: number;
    timestamp: string;
  }): Result<Quote, InvalidQuoteError>;
}

/**
 * Ошибка невалидной котировки
 */
export class InvalidQuoteError extends TradingError {
  public static readonly code = 'INVALID_QUOTE';
}
```

---

**См. также:**
- [Price](./price.md) — Цены в prediction markets
- [Quantity](./quantity.md) — Количество контрактов/акций
- [Spread](./spread.md) — Bid-ask spread
- [Money](./money.md) — Денежные суммы
