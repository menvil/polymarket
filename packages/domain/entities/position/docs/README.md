# Position Entity

> Доменная сущность для управления торговыми позициями (DDD-архитектура)

## Содержание

- [Обзор](#обзор)
- [Архитектура](#архитектура)
- [Использование](#использование)
- [API Reference](#api-reference)
- [FIFO/LIFO Алгоритмы](#fifolifo-алгоритмы)
- [P&L Расчеты](#pnl-расчеты)

## Обзор

Position представляет торговую позицию по конкретному инструменту.
Реализует DDD-принципы: `lots[]` — единственный источник истины,
`quantity` и `averageEntryPrice` — производные геттеры.

### Ключевые особенности

- ✅ **Immutable Entity** — все изменения возвращают новый экземпляр
- ✅ **lots = единственный источник истины** — `quantity`/`averageEntryPrice` derived
- ✅ **Entity контролирует мутацию** — `position.close()` → `applyClose()` → новый экземпляр
- ✅ **Нет циклических зависимостей** — `lot-closing.ts` не импортирует Position
- ✅ **FIFO/LIFO** — `position.close(qty, price, 'FIFO'|'LIFO', closedAt)`
- ✅ **Result Pattern** — явная обработка ошибок
- ✅ **Рост позиции** — `position.addLots(newLots, addedAt)` с обновлением `openedQuantity`
- ✅ **Аудит-след** — `openedAt` (неизменён) + `updatedAt` (обновляется при close/addLots)
- ✅ **Без fees** — комиссии принадлежат Fill/Ledger, не Position

## Архитектура

### Dependency Graph (без циклов)

```
PositionLot.ts  → value-objects only
lot-closing.ts  → PositionLot.ts, value-objects     (НЕТ импорта Position!)
Position.ts     → PositionLot.ts, lot-closing.ts
fifo-lifo.ts    → Position.ts                       (thin wrappers)
```

### Структура пакета

```
src/
├── Position.ts                # Главная entity + CloseResult
├── core/
│   └── PositionLot.ts         # Value Object для лота
└── algorithms/
    ├── lot-closing.ts         # Pure computation (нет Position)
    ├── fifo-lifo.ts           # Thin wrappers: closeFIFO, closeLIFO
    └── index.ts               # Публичный API алгоритмов
```

### Статус позиции через lots и openedQuantity

| Условие | Статус |
|---------|--------|
| `lots.length === 0` | `CLOSED` |
| `lots.length > 0 && quantity < openedQuantity` | `PARTIALLY_CLOSED` |
| `lots.length > 0 && quantity === openedQuantity` | `OPEN` |

> **Почему не realizedPnL для PARTIALLY_CLOSED?**
> При закрытии по цене входа (`closePrice == entryPrice`) → `realizedPnL = 0`,
> но позиция всё равно частично закрыта.
> `openedQuantity > quantity` — корректный и надёжный индикатор.

### Гарантии сортировки

Лоты хранятся в ASC-порядке по `timestamp`. Конструктор Position сортирует лоты **при каждом создании** — включая `applyClose()` и `addLots()`. Это единственная точка контроля инварианта.

Сложность: O(n log n) при каждом `close()`. Для типичного числа лотов (10-50) это незначимо.

`closeFIFO` и `closeLIFO` работают корректно потому что `this.lots` всегда гарантированно в ASC-порядке.

## Использование

### Создание позиции

```typescript
import { Position, PositionLot } from '@polymarket/position';
import { Quantity, Price, Timestamp } from '@polymarket/value-objects';
import { asPositionId, asInstrumentId, parseAccountId, AssetIdHelpers } from '@polymarket/ids';
import Decimal from 'decimal.js';

const lot = PositionLot.create({
  quantity: Quantity.of(new Decimal(100)),
  entryPrice: Price.of(new Decimal(0.65)),
  timestamp: Timestamp.now(),
});

const now = Timestamp.now();
const result = Position.create({
  id: asPositionId('pos-123')!,
  accountId: parseAccountId('venue:POLYMARKET:account-456')!,
  instrumentId: asInstrumentId('market-abc-token-yes')!,
  asset: AssetIdHelpers.USDC,
  side: 'LONG',
  openedAt: now,
  // updatedAt необязателен — defaults to openedAt
  lots: [lot],
  // quantity и averageEntryPrice НЕ передаются — они вычислены из lots
});

if (result.ok) {
  const position = result.value;
  console.log(position.quantity.value().toNumber());          // 100 (derived)
  console.log(position.averageEntryPrice.value().toNumber()); // 0.65 (derived)
  console.log(position.getStatus()); // 'OPEN'
  console.log(position.openedAt === now); // true
}
```

### Закрытие позиции (FIFO/LIFO)

```typescript
// Через Position.close() напрямую
const closeResult = position.close(
  Quantity.of(new Decimal(60)),
  Price.of(new Decimal(0.75)),
  'FIFO',
  Timestamp.now(), // closedAt записывается в updatedAt
);

// Или через thin wrappers
import { closeFIFO, closeLIFO } from '@polymarket/position';

const result = closeFIFO(position, closeQty, closePrice, Timestamp.now());

if (result.ok) {
  const { position: newPosition, realizedPnL, closedLots } = result.value;
  console.log(newPosition.quantity.value().toNumber()); // 40
  console.log(realizedPnL.value().toNumber()); // 8.5
  console.log(newPosition.getStatus()); // 'PARTIALLY_CLOSED'
  console.log(newPosition.openedAt === position.openedAt); // true (не изменился)
}
```

### Рост позиции (addLots)

```typescript
const newLots = [
  PositionLot.create({
    quantity: Quantity.of(new Decimal(50)),
    entryPrice: Price.of(new Decimal(0.70)),
    timestamp: Timestamp.now(),
  }),
];

const result = position.addLots(newLots, Timestamp.now());

if (result.ok) {
  const grown = result.value;
  console.log(grown.quantity.value().toNumber());       // 150 (100 + 50)
  console.log(grown.openedQuantity.value().toNumber()); // 150 (увеличился!)
  // openedAt не изменился, updatedAt = addedAt
}
```

### P&L Расчеты

```typescript
// Unrealized P&L
const currentPrice = Price.of(new Decimal(0.75));
const unrealizedPnL = position.getUnrealizedPnL(currentPrice);
// LONG: (0.75 - 0.65) * 100 = 10.0

// Total P&L (realized + unrealized)
const totalPnL = position.getTotalPnL(currentPrice);
```

## API Reference

### `PositionParams`

> **Важно:** `quantity` и `averageEntryPrice` **отсутствуют** — они вычислены из `lots`.
> `fees` **отсутствует** — комиссии принадлежат Fill/Ledger.

| Поле | Тип | Обязательность | Описание |
|------|-----|---------------|----------|
| `id` | `PositionId` | ✅ | Уникальный идентификатор |
| `accountId` | `AccountId` | ✅ | ID аккаунта |
| `instrumentId` | `InstrumentId` | ✅ | ID инструмента |
| `asset` | `AssetId` | ✅ | ID актива (USDC) |
| `side` | `'LONG' \| 'SHORT'` | ✅ | Сторона |
| `openedAt` | `Timestamp` | ✅ | Время открытия (неизменён) |
| `updatedAt` | `Timestamp` | ❌ | Время последней операции (defaults to openedAt) |
| `lots` | `PositionLot[]` | ✅ | Лоты (может быть `[]`) |
| `openedQuantity` | `Quantity` | ❌ | Исходный размер (defaults to sum(lots)) |
| `realizedPnL` | `SignedQuantity` | ❌ | Накопленный P&L |

### `Position` — Instance Methods

#### `get quantity(): Quantity`

Вычисляет сумму quantity всех лотов. Возвращает `Quantity.ZERO` при `lots = []`.

#### `get averageEntryPrice(): Price`

Вычисляет средневзвешенную цену входа. Возвращает `Price.MIN` при `lots = []`.

#### `getStatus(): PositionStatus`

| Условие | Результат |
|---------|----------|
| `lots.length === 0` | `'CLOSED'` |
| `quantity < openedQuantity` | `'PARTIALLY_CLOSED'` |
| `quantity === openedQuantity` | `'OPEN'` |

#### `close(closeQuantity, closePrice, strategy, closedAt): Result<CloseResult, ValidationError>`

Закрывает часть или всю позицию. `closedAt` записывается в `updatedAt` нового экземпляра.

- `strategy: 'FIFO'` — старые лоты первые
- `strategy: 'LIFO'` — новые лоты первые

**Валидации:**
- `strategy` должна быть строго `'FIFO'` или `'LIFO'` (runtime-проверка; невалидная стратегия → `Err`)
- `closeQuantity > 0`
- `lots.length > 0`
- `closeQuantity <= position.quantity`

#### `addLots(newLots, addedAt): Result<Position, ValidationError>`

Добавляет лоты к позиции (увеличение). `addedAt` записывается в `updatedAt`.

- `openedQuantity` увеличивается на сумму новых лотов
- Лоты объединяются и сортируются по timestamp ASC

**Валидации:**
- `newLots.length > 0`
- Нет лотов с `quantity = 0`

#### `getUnrealizedPnL(currentPrice): SignedQuantity`

- **LONG**: `(currentPrice - averageEntryPrice) * quantity`
- **SHORT**: `-(currentPrice - averageEntryPrice) * quantity`
- Возвращает ZERO для закрытой позиции.

#### `toJSON(): Record<string, unknown>`

Decimal-поля (`quantity`, `openedQuantity`, `averageEntryPrice`, `realizedPnL`) сериализуются как **string** для сохранения точности.
`openedAt` и `updatedAt` — epoch ms (number).

### `CloseResult`

```typescript
interface CloseResult {
  readonly position: Position;          // новая позиция после закрытия
  readonly realizedPnL: SignedQuantity; // P&L от данного закрытия (не накопленный)
  readonly closedLots: readonly ClosedLotInfo[];
}
```

### `PositionLot`

```typescript
class PositionLot {
  readonly quantity: Quantity;
  readonly entryPrice: Price;
  readonly timestamp: Timestamp;
  readonly fee?: Fee;   // комиссия лота (опционально, для исторических данных)

  getNotional(): Decimal;  // quantity * entryPrice — возвращает Decimal!
  toObject(): { quantity: string; entryPrice: string; timestamp: number; fee?: string };
}
```

## FIFO/LIFO Алгоритмы

### Пример: FIFO

```typescript
// Позиция: 3 лота
// Lot 1: 50 @ 0.60 (timestamp: 100)
// Lot 2: 30 @ 0.65 (timestamp: 200)
// Lot 3: 20 @ 0.70 (timestamp: 300)

const result = closeFIFO(
  position,
  Quantity.of(new Decimal(60)),
  Price.of(new Decimal(0.75)),
  Timestamp.now(),
);

// Закроется: Lot 1 (50) + 10 из Lot 2
// Realized P&L: (0.75-0.60)*50 + (0.75-0.65)*10 = 8.5
// Остаток: Lot 2 (20 @ 0.65) + Lot 3 (20 @ 0.70)
```

### Пример: LIFO

```typescript
const result = closeLIFO(
  position,
  Quantity.of(new Decimal(60)),
  Price.of(new Decimal(0.75)),
  Timestamp.now(),
);

// Закроется: Lot 3 (20) + Lot 2 (30) + 10 из Lot 1
// Realized P&L: (0.75-0.70)*20 + (0.75-0.65)*30 + (0.75-0.60)*10 = 5.5
// Остаток: Lot 1 (40 @ 0.60)
// Порядок remainingLots после close(): ASC (автоматически обращён из DESC)
```

### Алгоритм computeClose (lot-closing.ts)

```
computeClose(orderedLots, side, closeQuantity, closePrice)
  ↓
Валидации: qty > 0, lots.length > 0, qty <= totalLots
  ↓
Итерация по orderedLots:
  - lotSize <= remaining → закрыть полностью, remaining -= lotSize
  - lotSize > remaining → частичное закрытие, remaining = 0
  ↓
LotCloseComputation { remainingLots, totalRealizedPnL, closedLots }
```

## P&L Расчеты

### Формулы

| Тип | LONG | SHORT |
|-----|------|-------|
| **Realized** (лот) | `(closePrice - entryPrice) * closedQty` | `-(closePrice - entryPrice) * closedQty` |
| **Unrealized** | `(currentPrice - avgEntry) * qty` | `-(currentPrice - avgEntry) * qty` |
| **Total** | `realizedPnL + unrealizedPnL` | `realizedPnL + unrealizedPnL` |

### Накопление realizedPnL

При каждом `close()` realizedPnL **накапливается** в новом экземпляре:

```typescript
// applyClose() внутри Position:
const newRealizedPnL = this.realizedPnL.value().plus(computation.totalRealizedPnL);
```

## Почему fees убраны из Position?

Комиссии (fees) принадлежат **Fill** (исполнению ордера), а не Position:

- **Position** отражает рыночный риск: сколько, по какой цене, с каким P&L
- **Fill** отражает операционные детали: orderId, цена исполнения, комиссия, ликвидность
- **Ledger** агрегирует Fee-потоки из Fill для портфельного учёта

Хранение `fees` в Position было архитектурной фикцией — значение никогда не обновлялось
в `applyClose()`, создавая иллюзию данных там, где их нет.

## См. также

- [Order Entity](../../order/docs/order.md)
- [Value Objects](../../../value-objects/docs/README.md)
- [IDs Package](../../../../foundation/ids/README.md)
