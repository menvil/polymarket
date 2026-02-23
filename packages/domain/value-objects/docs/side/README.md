# Side Value Object

**Side** — value object для представления направления торговой операции в системе.

## 📌 Концепция

Side описывает **направление торговой сделки** (кто агрессор):
- **BUY** — покупка (taker покупает, aggressive buyer)
- **SELL** — продажа (taker продаёт, aggressive seller)

### Отличие от OutcomeKey

❗ **Важно**: Side (BUY/SELL) ≠ OutcomeKey (UP/DOWN)

| Концепт | Значения | Использование |
|---------|----------|---------------|
| **Side** | BUY / SELL | Направление сделки (кто агрессор) |
| **OutcomeKey** | UP / DOWN | Сторона outcome токена |

**Пример:**
```typescript
// Order на покупку UP токена
order = {
  side: 'BUY',        // Направление: покупаем
  tokenId: 'token-UP' // Токен: UP outcome
}

// Trade продажи DOWN токена
trade = {
  side: 'SELL',         // Направление: продаём
  tokenId: 'token-DOWN' // Токен: DOWN outcome
}
```

## 🏗️ Архитектура

Side следует паттерну других Value Objects:

```
side/
├── core/
│   └── Side.ts              # Type + core utilities
├── facade/
│   └── SideService.ts       # Public API
├── adapters/
│   ├── SideSerializer.ts    # JSON conversion
│   └── SideFormatter.ts     # Display formatting
├── errors/
│   └── SideErrorReason.ts   # Error types
└── index.ts                 # Main export
```

### Слои

1. **Core** — базовый type и pure functions
2. **Facade** — публичный API с Result pattern
3. **Adapters** — сериализация и форматирование
4. **Errors** — типизированные причины ошибок

## 📖 API

### Core

```typescript
import { Side, ALL_SIDES } from '@polymarket/value-objects';

type Side = 'BUY' | 'SELL';
const ALL_SIDES: readonly Side[] = ['BUY', 'SELL'];
```

### Facade (SideService)

#### Создание с валидацией

```typescript
import { SideService } from '@polymarket/value-objects';

// Из string
const result = SideService.fromString('BUY');
if (result.ok) {
  const side: Side = result.value; // 'BUY'
}

// Из unknown (для API parsing)
const userInput: unknown = 'SELL';
const result2 = SideService.fromUnknown(userInput);
if (result2.ok) {
  const side: Side = result2.value; // Type-safe
}

// Type guard (без Result)
if (SideService.isValid('BUY')) {
  console.log('Valid side');
}
```

#### Утилиты

```typescript
// Противоположная сторона
SideService.opposite('BUY');  // → 'SELL'
SideService.opposite('SELL'); // → 'BUY'

// Проверка совместимости для matching
SideService.canMatch('BUY', 'SELL');  // → true ✅
SideService.canMatch('BUY', 'BUY');   // → false ❌

// Сравнение
SideService.equals('BUY', 'BUY');   // → true
SideService.equals('BUY', 'SELL');  // → false

// Все значения
SideService.getAllValues(); // → ['BUY', 'SELL']
```

### Adapters

#### SideSerializer

```typescript
import { SideSerializer } from '@polymarket/value-objects';

// Сериализация
const json = SideSerializer.toJSON('BUY'); // 'BUY'

// Десериализация
const result = SideSerializer.fromJSON('SELL');
if (result.ok) {
  const side = result.value; // 'SELL'
}

// Парсинг unknown
const parsed: unknown = JSON.parse('{"side":"BUY"}');
const result2 = SideSerializer.fromUnknown((parsed as any).side);
```

#### SideFormatter

```typescript
import { SideFormatter } from '@polymarket/value-objects';

// Display strings
SideFormatter.toDisplay('BUY');     // → 'Buy'
SideFormatter.toUpperCase('BUY');   // → 'BUY'
SideFormatter.toLowerCase('BUY');   // → 'buy'

// Визуальные индикаторы
SideFormatter.toEmoji('BUY');       // → '🟢'
SideFormatter.toColor('BUY');       // → 'green'
SideFormatter.toHexColor('BUY');    // → '#22c55e'

// Logging
SideFormatter.toLogString('BUY');   // → '🟢 BUY'

// С размером
SideFormatter.withSize('BUY', 100); // → 'Buy 100'
```

## 🎯 Использование

### Order Entity

```typescript
import { Order } from '@polymarket/entities/order';
import { Side } from '@polymarket/value-objects';

const result = Order.create({
  id: 'order-123',
  side: 'BUY', // Side
  price: Price.fromValue(0.65).value!,
  size: Quantity.fromValue(100).value!,
  // ...
});
```

### Trade Entity

```typescript
import { Trade } from '@polymarket/entities';
import { Side } from '@polymarket/value-objects';

const result = Trade.create({
  id: 'trade-1',
  side: 'SELL', // Side
  price: Price.fromValue(0.70).value!,
  size: Quantity.fromValue(50).value!,
  // ...
});
```

### Order Matching

```typescript
import { SideService } from '@polymarket/value-objects';

function canExecuteTrade(order: Order, trade: Trade): boolean {
  // Проверяем совместимость сторон
  if (!SideService.canMatch(order.side, trade.side)) {
    return false;
  }

  // Другие проверки (market, token, price)...
  return true;
}
```

### UI Components

```typescript
import { SideFormatter } from '@polymarket/value-objects';

// React component
function OrderRow({ order }) {
  return (
    <div>
      <span style={{ color: SideFormatter.toColor(order.side) }}>
        {SideFormatter.toEmoji(order.side)}
        {SideFormatter.toDisplay(order.side)}
      </span>
      <span>{SideFormatter.withSize(order.side, order.size.value)}</span>
    </div>
  );
}
```

## ⚠️ Ошибки

### SideErrorReason

```typescript
import { SideErrorReason } from '@polymarket/value-objects';

enum SideErrorReason {
  INVALID_VALUE = 'INVALID_VALUE', // Неверное значение ('buy', 'INVALID')
  INVALID_TYPE = 'INVALID_TYPE',   // Неверный тип (number, null, etc)
}

// Использование
const result = SideService.fromString('invalid');
if (!result.ok) {
  if (result.error.context?.reason === SideErrorReason.INVALID_VALUE) {
    console.error('Invalid side value');
  }
}
```

### Error Context

Все ошибки включают полный context через `wrapOp`:

```typescript
const result = SideService.fromString('INVALID');
if (!result.ok) {
  console.log(result.error.context);
  // {
  //   op: 'fromString',
  //   opChain: 'SideService.fromString',
  //   value: 'INVALID',
  //   expectedValues: ['BUY', 'SELL'],
  //   reason: 'INVALID_VALUE'
  // }
}
```

## 🧪 Тестирование

```typescript
import { SideService, SideFormatter } from '@polymarket/value-objects';

describe('Side integration', () => {
  it('should create, format, and serialize side', () => {
    // Create
    const result = SideService.fromString('BUY');
    expect(result.ok).toBe(true);

    const side = result.value!;

    // Format
    expect(SideFormatter.toDisplay(side)).toBe('Buy');
    expect(SideFormatter.toEmoji(side)).toBe('🟢');

    // Utilities
    expect(SideService.opposite(side)).toBe('SELL');
    expect(SideService.canMatch(side, 'SELL')).toBe(true);

    // Serialize
    const json = SideSerializer.toJSON(side);
    expect(json).toBe('BUY');
  });
});
```

## 📚 Примеры

### Hedging Strategy

```typescript
import { SideService } from '@polymarket/value-objects';

function createHedgeOrder(originalOrder: Order): OrderParams {
  return {
    side: SideService.opposite(originalOrder.side), // Противоположная сторона
    size: originalOrder.size,
    price: originalOrder.price,
    // ...
  };
}
```

### Market Pressure Analysis

```typescript
import { SideService } from '@polymarket/value-objects';

function analyzeBuySellPressure(trades: Trade[]) {
  const buyVolume = trades
    .filter(t => t.side === 'BUY')
    .reduce((sum, t) => sum + t.size.value, 0);

  const sellVolume = trades
    .filter(t => t.side === 'SELL')
    .reduce((sum, t) => sum + t.size.value, 0);

  return {
    buyPressure: buyVolume / (buyVolume + sellVolume),
    sellPressure: sellVolume / (buyVolume + sellVolume),
  };
}
```

### Dynamic UI Styling

```typescript
import { SideFormatter } from '@polymarket/value-objects';

// CSS-in-JS
const orderStyles = {
  color: SideFormatter.toHexColor(order.side),
  fontWeight: 'bold',
};

// Tailwind classes
const colorClass = order.side === 'BUY' ? 'text-green-500' : 'text-red-500';
```

## 🔄 Миграция

Side заменяет дублирующиеся типы:

### До миграции

```typescript
// OrderSide в order/value-objects/OrderSide.ts
export type OrderSide = 'BUY' | 'SELL';

// TradeSide в entities/Trade.ts
export type TradeSide = 'BUY' | 'SELL';
```

### После миграции

```typescript
// Единый Side в value-objects
import { Side } from '@polymarket/value-objects';

// В Order
public readonly side: Side;

// В Trade
public readonly side: Side;
```

## ✅ Преимущества

1. **DRY** — нет дублирования кода
2. **Единый источник истины** — одна концепция, один тип
3. **Полная архитектура** — facade, adapters, serialization
4. **Type-safe** — строгая типизация через TypeScript
5. **Result pattern** — безопасная обработка ошибок
6. **Comprehensive API** — utilities, formatting, validation
7. **Консистентность** — следует паттернам других VOs

## 🔗 См. также

- [OutcomeToken](../outcome-token/README.md) — токены UP/DOWN
- [Price](../price/README.md) — цена сделки
- [Quantity](../quantity/README.md) — количество
- [Order Entity](../../../entities/order/README.md) — использование Side
- [Trade Entity](../../../entities/docs/trade.md) — использование Side
