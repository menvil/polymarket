# Portfolio Entity

## Обзор

Portfolio — immutable aggregate root, управляющий балансом и открытыми позициями трейдера в системе Polymarket.

## Почему так сделано?

### 1. Balance VO вместо `cash + reservedCash`

**Проблема**: Прежний Portfolio хранил `cash: Money` и `reservedCash: Money` отдельно. Это дублировало логику инвариантов (available >= 0, reserved >= 0, одинаковая валюта) и требовало ручной синхронизации двух полей.

**Решение**: Единое `balance: Balance` инкапсулирует оба значения и предоставляет атомарные операции через `BalanceService`:

```typescript
// Вместо:
public readonly cash: Money;
public readonly reservedCash: Money;

// Стало:
public readonly balance: Balance;
// balance.available() — свободные средства
// balance.reserved() — зарезервированные средства
// balance.total()    — сумма (derived)
```

### 2. `ReadonlyMap<InstrumentId, IPosition>` вместо строковых ключей

**Проблема**: `positions: Record<string, Position>` допускал передачу любой строки как ключа. Ошибки (например, перепутать `orderId` с `instrumentId`) не ловились компилятором.

**Решение**: Typed ключ `InstrumentId` — branded type. Компилятор различает его от других строк.

### 3. `upsertPosition()` вместо `addPosition / updatePosition / removePosition`

**Проблема**: Три разных метода требовали знать текущее состояние позиции перед вызовом. Легко вызвать не тот метод.

**Решение**: Один `upsertPosition(position)` с логикой:
- Если `position.isClosed()` → удалить из карты
- Иначе → добавить/обновить по `instrumentId`

### 4. Валюация вынесена в отдельные функции

**Проблема**: Расчёт стоимости требует текущих котировок — внешних данных, которых нет в доменном состоянии Portfolio.

**Решение**: `getTotalValue` и `getTotalUnrealizedPnL` — standalone-функции, принимающие итерируемые позиции + провайдер цен:

```typescript
// В Portfolio (НЕТ):
getTotalValue(prices: Map<InstrumentId, Price>): Money

// Функции из @polymarket/portfolio (ЕСТЬ):
getTotalValue(portfolio.getPositions(), getPrice, 'USDC')
```

### 5. Структурная типизация для позиций (IPosition)

**Проблема**: Прямая зависимость от `Position` entity из другого package требовала, чтобы тот package был скомпилирован. При build errors в position — portfolio тоже не собирался.

**Решение**: Portfolio определяет единый интерфейс `IPosition` — контракт для управления и оценки стоимости:
```typescript
export interface IPosition {
  readonly instrumentId: InstrumentId;
  readonly quantity: { value(): Decimal };
  readonly side: 'LONG' | 'SHORT';
  readonly averageEntryPrice: { value(): Decimal };
  isClosed(): boolean;
  getUnrealizedPnL(currentPrice: Price): { value(): Decimal };
}
```
Реальный `Position` структурно совместим с `IPosition`. `getTotalValue` / `getTotalUnrealizedPnL` принимают `Iterable<IPosition>` без дополнительных интерфейсов или cast.

### 6. `applyCredit()` вместо прямой манипуляции с балансом

**Проблема**: Внешний код мог напрямую вычислять новый available и создавать Balance, обходя инварианты.

**Решение**: `applyCredit(amount)` — единственный способ зачислить средства. Делегирует в `BalanceService.credit()`.

---

## Структура

```
packages/domain/entities/portfolio/
└── src/
    ├── Portfolio.ts                    # Aggregate root
    ├── value-objects/
    │   ├── PortfolioId.ts              # Branded type
    │   └── index.ts
    ├── services/
    │   └── PortfolioValuationService.ts # getTotalValue, getTotalUnrealizedPnL
    └── index.ts
```

---

## Жизненный цикл баланса

```
reserveForOrder(amount)    →  available -= amount, reserved += amount
releaseReservation(amount) →  available += amount, reserved -= amount
applyDebit(amount)         →  reserved -= amount  (исполнение ордера)
applyCredit(amount)        →  available += amount (зачисление)
```

| Метод | Сценарий использования |
|-------|----------------------|
| `reserveForOrder(amount)` | Размещение ордера — заморозить средства |
| `releaseReservation(amount)` | Отмена ордера — вернуть средства |
| `applyDebit(amount)` | Исполнение ордера — списать из reserved |
| `applyCredit(amount)` | Получение средств (profit, пополнение) |

---

## Примеры использования

### Создание портфеля

```typescript
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import { Balance } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';
import Decimal from 'decimal.js';

const balance = Balance.withZeroReserved(
  Money.of(new Decimal(10000), 'USDC'),
  accountId,
  venueId
);

const result = Portfolio.create({
  id: asPortfolioId('portfolio-abc'),
  accountId,
  balance,
});

if (result.ok) {
  const portfolio = result.value;
  console.log(portfolio.balance.available().value()); // 10000
}
```

### Операции с балансом

```typescript
// Размещение ордера: зарезервировать 3000
const reserveResult = portfolio.reserveForOrder(Money.of(new Decimal(3000), 'USDC'));
if (reserveResult.ok) {
  const reserved = reserveResult.value;
  // available: 7000, reserved: 3000

  // Отмена ордера: вернуть средства
  const releaseResult = reserved.releaseReservation(Money.of(new Decimal(3000), 'USDC'));

  // Или исполнение: списать из reserved
  const debitResult = reserved.applyDebit(Money.of(new Decimal(3000), 'USDC'));
}

// Зачисление прибыли
const creditResult = portfolio.applyCredit(Money.of(new Decimal(500), 'USDC'));
```

### Управление позициями

```typescript
// Добавить/обновить позицию
const withPosition = portfolio.upsertPosition(openPosition);
console.log(withPosition.hasPosition(instrumentId)); // true

// Закрытая позиция — автоматически удаляется
const withClosed = portfolio.upsertPosition(closedPosition);
console.log(withClosed.hasPosition(closedPosition.instrumentId)); // false

// Запросить позицию
const position = portfolio.getPosition(instrumentId);
if (position) {
  console.log(position.instrumentId);
}

// Все позиции (IterableIterator)
for (const pos of portfolio.getPositions()) {
  console.log(pos.instrumentId);
}
console.log(portfolio.getPositionCount()); // 3
```

### Оценка стоимости

```typescript
import { getTotalValue, getTotalUnrealizedPnL } from '@polymarket/portfolio';

const prices = new Map<InstrumentId, Price>([
  [instrumentId, currentPrice],
]);

const getPrice = (id: InstrumentId): Price | undefined => prices.get(id);

// getPrice может вернуть undefined — getTotalValue и getTotalUnrealizedPnL
// пропускают позиции без котировки
const totalValue = getTotalValue(portfolio.getPositions(), getPrice, 'USDC');
const totalPnL   = getTotalUnrealizedPnL(portfolio.getPositions(), getPrice);
```

---

## IPosition — структурный интерфейс

Portfolio работает с любым объектом, реализующим единый `IPosition`:

```typescript
export interface IPosition {
  readonly instrumentId: InstrumentId;
  readonly quantity: { value(): Decimal };
  readonly side: 'LONG' | 'SHORT';
  readonly averageEntryPrice: { value(): Decimal };
  isClosed(): boolean;
  getUnrealizedPnL(currentPrice: Price): { value(): Decimal };
}
```

Единый контракт покрывает как управление позицией (`isClosed`, `instrumentId`),
так и оценку стоимости и риска (`quantity`, `side`, `getUnrealizedPnL`).
`getTotalValue` / `getTotalUnrealizedPnL` принимают `Iterable<IPosition>` напрямую — без промежуточных интерфейсов.

Реальный `Position` entity структурно совместим с `IPosition`.
