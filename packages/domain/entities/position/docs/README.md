# Position Entity

> Доменная сущность для управления торговыми позициями

## Содержание

- [Обзор](#обзор)
- [Архитектура](#архитектура)
- [Использование](#использование)
- [API Reference](#api-reference)
- [FIFO/LIFO Алгоритмы](#fifolifo-алгоритмы)
- [P&L Расчеты](#pnl-расчеты)
- [Примеры](#примеры)

## Обзор

Position представляет открытую или закрытую торговую позицию по конкретному инструменту. Позиция может состоять из множества лотов (FIFO/LIFO), отслеживает P&L (realized и unrealized), и поддерживает частичное закрытие.

### Ключевые особенности

- ✅ **Immutable Entity** - все изменения возвращают новый экземпляр
- ✅ **Type-Safe IDs** - использует branded types (PositionId, AccountId, etc.)
- ✅ **FIFO/LIFO Tracking** - управление лотами для точного P&L
- ✅ **P&L Calculations** - realized, unrealized, total P&L
- ✅ **Result Pattern** - явная обработка ошибок
- ✅ **Value Objects** - Timestamp, Fee, Quantity, Price

## Архитектура

```
Position Entity
├── Core
│   └── Position.ts          # Главная entity
├── Value Objects
│   ├── PositionSide         # LONG | SHORT
│   ├── PositionStatus       # OPEN | PARTIALLY_CLOSED | CLOSED
│   └── PositionLot          # Лот для FIFO/LIFO
├── Algorithms
│   ├── FIFO                 # First-In-First-Out
│   └── LIFO                 # Last-In-First-Out
└── Tests
    └── Position.test.ts     # Comprehensive tests
```

## Использование

### Базовый пример

```typescript
import { Position } from '@polymarket/entities';
import { Quantity, Price, Timestamp } from '@polymarket/value-objects';
import { asPositionId, asAccountId, asInstrumentId, asAssetId } from '@polymarket/ids';

// Создание новой позиции
const result = Position.create({
  id: asPositionId('pos-123')!,
  accountId: asAccountId('account-456')!,
  instrumentId: asInstrumentId('market-abc-token-yes')!,
  asset: asAssetId('USDC')!,
  side: 'LONG',
  quantity: Quantity.of(new Decimal(100)),
  averageEntryPrice: Price.of(new Decimal(0.65)),
  timestamp: Timestamp.now(),
  lots: [],
});

if (result.ok) {
  const position = result.value();
  console.log(position.toString());
  // Position[pos-123]: LONG 100 @ 0.65 (OPEN)
}
```

### P&L Расчеты

```typescript
const position = result.value();

// Unrealized P&L
const currentPrice = Price.of(new Decimal(0.75));
const unrealizedPnL = position.getUnrealizedPnL(currentPrice);
console.log(unrealizedPnL.value().toNumber()); // 10.0 ((0.75 - 0.65) * 100)

// Total P&L (realized + unrealized)
const totalPnL = position.getTotalPnL(currentPrice);
console.log(totalPnL.value().toNumber());
```

### Работа с лотами

```typescript
import type { PositionLot } from '@polymarket/entities';

// Создание позиции с лотами
const lot1: PositionLot = {
  quantity: Quantity.of(new Decimal(50)),
  entryPrice: Price.of(new Decimal(0.60)),
  timestamp: Timestamp.now(),
};

const lot2: PositionLot = {
  quantity: Quantity.of(new Decimal(50)),
  entryPrice: Price.of(new Decimal(0.70)),
  timestamp: Timestamp.now(),
  fee: Fee.of(Quantity.of(new Decimal(1)), asAssetId('USDC')!),
};

const result = Position.create({
  // ... other params
  lots: [lot1, lot2],
  averageEntryPrice: Price.of(new Decimal(0.65)), // weighted average
});
```

## API Reference

### Position Class

#### Static Methods

##### `Position.create(params: PositionParams): Result<Position, ValidationError>`

Создает новую позицию с валидацией.

**Параметры:**
- `id: PositionId` - уникальный идентификатор
- `accountId: AccountId` - ID аккаунта владельца
- `instrumentId: InstrumentId` - ID инструмента (market + token)
- `asset: AssetId` - ID актива для расчетов (обычно USDC)
- `side: PositionSide` - направление (LONG/SHORT)
- `quantity: Quantity` - текущий размер позиции
- `averageEntryPrice: Price` - средняя цена входа
- `timestamp: Timestamp` - время создания/обновления
- `lots: PositionLot[]` - массив лотов для FIFO/LIFO
- `realizedPnL?: Quantity` - уже реализованный P&L (optional, default: 0)
- `fees?: Fee` - накопленные комиссии (optional, default: 0)

**Возвращает:**
- `Ok(Position)` - при успехе
- `Err(ValidationError)` - при ошибке валидации

**Валидации:**
- Все ID поля обязательны и должны быть валидными branded types
- Quantity, Price, Timestamp обязательны
- Lots может быть пустым массивом

**Пример:**

```typescript
const result = Position.create({
  id: asPositionId('pos-123')!,
  accountId: asAccountId('acc-456')!,
  instrumentId: asInstrumentId('market-abc')!,
  asset: asAssetId('USDC')!,
  side: 'LONG',
  quantity: Quantity.of(new Decimal(100)),
  averageEntryPrice: Price.of(new Decimal(0.65)),
  timestamp: Timestamp.now(),
  lots: [],
});

if (result.ok) {
  const position = result.value();
  // работа с позицией
} else {
  console.error(result.error.message);
}
```

#### Instance Methods

##### `getStatus(): PositionStatus`

Возвращает текущий статус позиции.

**Возвращает:**
- `'OPEN'` - позиция открыта (quantity > 0)
- `'PARTIALLY_CLOSED'` - частично закрыта (некоторые лоты закрыты)
- `'CLOSED'` - полностью закрыта (quantity === 0)

**Пример:**

```typescript
const status = position.getStatus();
console.log(status); // 'OPEN'
```

##### `isOpen(): boolean`

Проверяет открыта ли позиция.

**Возвращает:** `true` если quantity > 0

**Пример:**

```typescript
if (position.isOpen()) {
  console.log('Position is still open');
}
```

##### `isClosed(): boolean`

Проверяет закрыта ли позиция.

**Возвращает:** `true` если quantity === 0

**Пример:**

```typescript
if (position.isClosed()) {
  console.log('Position is fully closed');
}
```

##### `getUnrealizedPnL(currentPrice: Price): Quantity`

Вычисляет unrealized P&L (нереализованный профит/убыток).

**Параметры:**
- `currentPrice: Price` - текущая рыночная цена

**Возвращает:** Unrealized P&L как Quantity

**Формула:**
- **LONG**: `(currentPrice - averageEntryPrice) * quantity`
- **SHORT**: `-(currentPrice - averageEntryPrice) * quantity`

**Пример:**

```typescript
// LONG position: bought 100 @ 0.65
const currentPrice = Price.of(new Decimal(0.75));
const unrealizedPnL = position.getUnrealizedPnL(currentPrice);
// (0.75 - 0.65) * 100 = 10.0
```

##### `getTotalPnL(currentPrice: Price): Quantity`

Вычисляет total P&L (realized + unrealized).

**Параметры:**
- `currentPrice: Price` - текущая рыночная цена

**Возвращает:** Total P&L как Quantity

**Формула:**
- `realizedPnL + getUnrealizedPnL(currentPrice)`

**Пример:**

```typescript
// Position: realized 5, unrealized 10
const totalPnL = position.getTotalPnL(currentPrice);
// 5 + 10 = 15.0
```

##### `toJSON(): Record<string, unknown>`

Сериализует позицию в plain object для JSON.

**Возвращает:** Object с полями:
- `id, accountId, instrumentId, asset` - идентификаторы
- `side` - направление
- `quantity` - размер (number)
- `averageEntryPrice` - средняя цена (number)
- `timestamp` - epoch milliseconds
- `status` - текущий статус
- `realizedPnL` - реализованный P&L (number)
- `fees` - комиссии (объект)
- `lotsCount` - количество лотов

**Пример:**

```typescript
const json = position.toJSON();
console.log(JSON.stringify(json, null, 2));
```

##### `toString(): string`

Человекочитаемое представление позиции.

**Возвращает:** String вида `"Position[id]: side quantity @ price (status)"`

**Пример:**

```typescript
console.log(position.toString());
// Position[pos-123]: LONG 100 @ 0.65 (OPEN)
```

## FIFO/LIFO Алгоритмы

### Концепция

При частичном закрытии позиции важно определить **какие лоты закрываются первыми**, чтобы правильно рассчитать realized P&L.

### FIFO (First-In-First-Out)

**Алгоритм:** Закрывает самые старые лоты первыми.

**Когда использовать:**
- Более консервативный подход
- Соответствует бухгалтерским стандартам в некоторых юрисдикциях
- Предпочтительно для long-term позиций

**Пример:**

```typescript
// Открываем 3 лота
Lot 1: 50 @ 0.60 (timestamp: 100)
Lot 2: 30 @ 0.65 (timestamp: 200)
Lot 3: 20 @ 0.70 (timestamp: 300)
Total: 100 @ 0.64 (average)

// Закрываем 60 @ 0.75 с FIFO
// Закроется: Lot 1 (50 @ 0.60) + 10 из Lot 2 (10 @ 0.65)
Realized P&L:
  (0.75 - 0.60) * 50 = 7.5
  (0.75 - 0.65) * 10 = 1.0
  Total: 8.5

// Остается:
Lot 2: 20 @ 0.65
Lot 3: 20 @ 0.70
Total: 40 @ 0.675
```

**Реализация:**

```typescript
// TODO: будет реализовано в PositionManager
function closeFIFO(position: Position, closeQuantity: Quantity): {
  newPosition: Position;
  realizedPnL: Quantity;
} {
  // 1. Сортируем лоты по timestamp (старые первые)
  const sortedLots = [...position.lots].sort((a, b) =>
    a.timestamp.toEpochMs() - b.timestamp.toEpochMs()
  );

  // 2. Закрываем лоты по порядку
  let remaining = closeQuantity.value();
  let realizedPnL = new Decimal(0);
  const newLots: PositionLot[] = [];

  for (const lot of sortedLots) {
    if (remaining.isZero()) {
      newLots.push(lot);
      continue;
    }

    const lotSize = lot.quantity.value();
    if (lotSize.lte(remaining)) {
      // Закрываем лот полностью
      const pnl = calculateLotPnL(lot, closePrice);
      realizedPnL = realizedPnL.plus(pnl);
      remaining = remaining.minus(lotSize);
    } else {
      // Частичное закрытие лота
      const closedPart = remaining;
      const pnl = calculatePartialLotPnL(lot, closedPart, closePrice);
      realizedPnL = realizedPnL.plus(pnl);

      // Остаток лота
      newLots.push({
        ...lot,
        quantity: Quantity.of(lotSize.minus(closedPart)),
      });
      remaining = new Decimal(0);
    }
  }

  // 3. Создаем новую позицию
  return {
    newPosition: Position.create({
      ...position,
      quantity: position.quantity.value().minus(closeQuantity.value()),
      lots: newLots,
      realizedPnL: position.realizedPnL.value().plus(realizedPnL),
    }).value()!,
    realizedPnL: Quantity.of(realizedPnL),
  };
}
```

### LIFO (Last-In-First-Out)

**Алгоритм:** Закрывает самые новые лоты первыми.

**Когда использовать:**
- Более агрессивный подход
- Может уменьшить налоги в некоторых юрисдикциях
- Предпочтительно для day-trading

**Пример:**

```typescript
// Открываем 3 лота
Lot 1: 50 @ 0.60 (timestamp: 100)
Lot 2: 30 @ 0.65 (timestamp: 200)
Lot 3: 20 @ 0.70 (timestamp: 300)
Total: 100 @ 0.64 (average)

// Закрываем 60 @ 0.75 с LIFO
// Закроется: Lot 3 (20 @ 0.70) + Lot 2 (30 @ 0.65) + 10 из Lot 1 (10 @ 0.60)
Realized P&L:
  (0.75 - 0.70) * 20 = 1.0
  (0.75 - 0.65) * 30 = 3.0
  (0.75 - 0.60) * 10 = 1.5
  Total: 5.5

// Остается:
Lot 1: 40 @ 0.60
Total: 40 @ 0.60
```

**Реализация:**

```typescript
// TODO: будет реализовано в PositionManager
function closeLIFO(position: Position, closeQuantity: Quantity): {
  newPosition: Position;
  realizedPnL: Quantity;
} {
  // 1. Сортируем лоты по timestamp (новые первые)
  const sortedLots = [...position.lots].sort((a, b) =>
    b.timestamp.toEpochMs() - a.timestamp.toEpochMs()
  );

  // 2. Закрываем лоты по порядку (как в FIFO, но с обратным порядком)
  // ... аналогично FIFO
}
```

## P&L Расчеты

### Realized P&L

**Определение:** P&L от уже закрытых лотов.

**Формула:**
```typescript
realizedPnL = sum(
  (closePrice - lot.entryPrice) * lot.closedQuantity
) for each closed lot
```

**Когда изменяется:**
- При частичном закрытии позиции
- При полном закрытии позиции

### Unrealized P&L

**Определение:** P&L от открытых лотов по текущей цене.

**Формула:**
- **LONG**: `(currentPrice - averageEntryPrice) * quantity`
- **SHORT**: `-(currentPrice - averageEntryPrice) * quantity`

**Когда изменяется:**
- При изменении рыночной цены
- Рассчитывается on-demand (не хранится)

### Total P&L

**Определение:** Сумма realized и unrealized P&L.

**Формула:**
```typescript
totalPnL = realizedPnL + unrealizedPnL(currentPrice)
```

**Использование:**
- Для отображения в UI
- Для risk management
- Для отчетов

## Примеры

### Пример 1: Создание LONG позиции

```typescript
import { Position } from '@polymarket/entities';
import { Quantity, Price, Timestamp } from '@polymarket/value-objects';
import { asPositionId, asAccountId, asInstrumentId, asAssetId } from '@polymarket/ids';

const result = Position.create({
  id: asPositionId('pos-long-123')!,
  accountId: asAccountId('account-456')!,
  instrumentId: asInstrumentId('market-abc-token-yes')!,
  asset: asAssetId('USDC')!,
  side: 'LONG',
  quantity: Quantity.of(new Decimal(100)),
  averageEntryPrice: Price.of(new Decimal(0.65)),
  timestamp: Timestamp.now(),
  lots: [],
});

if (result.ok) {
  const position = result.value();
  console.log('Position created:', position.toString());
}
```

### Пример 2: SHORT позиция с лотами

```typescript
const lot1: PositionLot = {
  quantity: Quantity.of(new Decimal(50)),
  entryPrice: Price.of(new Decimal(0.70)),
  timestamp: Timestamp.fromEpochMs(Date.now() - 3600000), // 1 hour ago
};

const lot2: PositionLot = {
  quantity: Quantity.of(new Decimal(50)),
  entryPrice: Price.of(new Decimal(0.65)),
  timestamp: Timestamp.now(),
};

const result = Position.create({
  id: asPositionId('pos-short-456')!,
  accountId: asAccountId('account-789')!,
  instrumentId: asInstrumentId('market-xyz-token-no')!,
  asset: asAssetId('USDC')!,
  side: 'SHORT',
  quantity: Quantity.of(new Decimal(100)),
  averageEntryPrice: Price.of(new Decimal(0.675)), // weighted average
  timestamp: Timestamp.now(),
  lots: [lot1, lot2],
});
```

### Пример 3: Расчет P&L

```typescript
if (result.ok) {
  const position = result.value();

  // Текущая цена упала (хорошо для SHORT)
  const currentPrice = Price.of(new Decimal(0.60));

  // Unrealized P&L
  const unrealizedPnL = position.getUnrealizedPnL(currentPrice);
  console.log('Unrealized P&L:', unrealizedPnL.value().toNumber());
  // SHORT: -(0.60 - 0.675) * 100 = 7.5 (profit)

  // Total P&L (если есть realized)
  const totalPnL = position.getTotalPnL(currentPrice);
  console.log('Total P&L:', totalPnL.value().toNumber());
}
```

### Пример 4: Закрытая позиция

```typescript
const result = Position.create({
  id: asPositionId('pos-closed-789')!,
  accountId: asAccountId('account-123')!,
  instrumentId: asInstrumentId('market-def-token-yes')!,
  asset: asAssetId('USDC')!,
  side: 'LONG',
  quantity: Quantity.ZERO, // полностью закрыта
  averageEntryPrice: Price.of(new Decimal(0.65)),
  timestamp: Timestamp.now(),
  lots: [],
  realizedPnL: Quantity.of(new Decimal(15)), // заработали 15
});

if (result.ok) {
  const position = result.value();

  console.log('Status:', position.getStatus()); // 'CLOSED'
  console.log('Is closed:', position.isClosed()); // true
  console.log('Realized P&L:', position.realizedPnL.value().toNumber()); // 15

  // Unrealized будет 0 для закрытой позиции
  const currentPrice = Price.of(new Decimal(0.80));
  const unrealizedPnL = position.getUnrealizedPnL(currentPrice);
  console.log('Unrealized P&L:', unrealizedPnL.value().toNumber()); // 0
}
```

## Best Practices

### 1. Всегда используйте Result pattern

```typescript
const result = Position.create(params);

if (result.ok) {
  const position = result.value();
  // работа с позицией
} else {
  // обработка ошибки
  console.error(result.error.message);
  handleError(result.error);
}
```

### 2. Используйте branded types для ID

```typescript
// ✅ Правильно
const positionId = asPositionId('pos-123');
if (positionId) {
  // используем typed ID
}

// ❌ Неправильно
const positionId = 'pos-123' as PositionId;
```

### 3. Храните лоты для точного P&L

```typescript
// ✅ Правильно - сохраняем лоты
const lots: PositionLot[] = [
  { quantity, entryPrice, timestamp },
];

// ❌ Неправильно - только average price
// Потеряем информацию для FIFO/LIFO
```

### 4. Не мутируйте Position

```typescript
// ✅ Правильно - создаем новую позицию
const newPosition = Position.create({
  ...oldPosition,
  quantity: newQuantity,
}).value()!;

// ❌ Неправильно - мутация
position.quantity = newQuantity; // TypeScript error
```

### 5. Используйте Decimal для точности

```typescript
// ✅ Правильно
const quantity = Quantity.of(new Decimal('0.000001'));

// ❌ Неправильно - потеря точности
const quantity = Quantity.of(new Decimal(0.000001));
```

## Ограничения

1. **Immutability** - все изменения требуют создания нового экземпляра
2. **FIFO/LIFO** - базовая логика, полная реализация в PositionManager (TODO)
3. **Fees** - хранятся на уровне позиции и лотов, не автоматически учитываются в P&L
4. **Multi-Asset** - одна позиция = один asset, для портфолио нужен Portfolio entity

## См. также

- [Order Entity](../../order/docs/README.md) - торговые заявки
- [Value Objects](../../../value-objects/docs/README.md) - Quantity, Price, Timestamp, Fee
- [IDs Package](../../../foundation/ids/README.md) - branded types для идентификаторов
