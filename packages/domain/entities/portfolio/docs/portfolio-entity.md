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

### 5. `tokenReservations` — резервации outcome-токенов для SELL ордеров

**Проблема**: При размещении SELL ордера outcome-токены не резервировались. Это приводило к:
- `BalancePolicy` видел полную позицию без учёта открытых SELL ордеров → **двойная продажа**
- При отмене SELL ничего не освобождалось
- При fill SELL резервация не снималась

**Решение**: `tokenReservations: ReadonlyMap<InstrumentId, Decimal>` — симметрично `balance.reserved` для USDC.

```typescript
// Баланс USDC (BUY):
balance.available()  // USDC доступно
balance.reserved()   // USDC под открытые BUY ордера

// Токены (SELL):
availableTokenQuantity(id)          // токены доступно (= position.qty - reserved)
tokenReservations.get(id)           // токены под открытые SELL ордера
```

Не используется `Quantity` VO (требует значение >= 0.0001) — для Map достаточно `Decimal`.

### 6. Структурная типизация для позиций (IPosition)

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

### 7. `applyCredit()` вместо прямой манипуляции с балансом

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

### USDC (BUY ордера)

```
reserveForOrder(amount)    →  available -= amount, reserved += amount
releaseReservation(amount) →  available += amount, reserved -= amount
applyDebit(amount)         →  reserved -= amount  (исполнение BUY fill)
applyCredit(amount)        →  available += amount (зачисление при SELL fill)
```

| Метод | Сценарий использования |
|-------|----------------------|
| `reserveForOrder(amount)` | Размещение BUY ордера — заморозить USDC |
| `releaseReservation(amount)` | Отмена BUY ордера — вернуть USDC |
| `applyDebit(amount)` | BUY fill — списать из reserved |
| `applyCredit(amount)` | SELL fill — зачислить выручку |

### Outcome-токены (SELL ордера)

```
reserveTokensForOrder(id, qty)   →  tokenReservations[id] += qty
releaseTokenReservation(id, qty) →  tokenReservations[id] -= qty
availableTokenQuantity(id)       →  position.qty - tokenReservations[id]
```

| Метод | Сценарий использования |
|-------|----------------------|
| `reserveTokensForOrder(id, qty)` | Размещение SELL ордера — заморозить токены |
| `releaseTokenReservation(id, qty)` | SELL fill или отмена SELL — освободить токены |
| `availableTokenQuantity(id)` | Проверка доступного объёма перед новым SELL |

**Жизненный цикл SELL ордера (симметрия с BUY):**

```
BUY order placed:    reserveForOrder(USDC)             → balance.reserved += notional
BUY fill received:   applyDebit(USDC)                  → balance.reserved -= notional
BUY order cancelled: releaseReservation(USDC)          → balance.reserved -= notional

SELL order placed:    reserveTokensForOrder(id, qty)   → tokenReservations[id] += qty
SELL fill received:   releaseTokenReservation(id, qty)  → tokenReservations[id] -= qty
SELL order cancelled: releaseTokenReservation(id, qty)  → tokenReservations[id] -= qty
```

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

### Токенные резервации (SELL ордера)

```typescript
// Позиция: 100 токенов
const withPosition = portfolio.upsertPosition(openPosition); // quantity = 100

// Размещение SELL ордера — зарезервировать 80 токенов
const reserved = withPosition.reserveTokensForOrder(instrumentId, new Decimal(80));
if (reserved.ok) {
  const p = reserved.value;
  p.availableTokenQuantity(instrumentId).toNumber(); // 20 (100 - 80)
  p.tokenReservations.get(instrumentId)?.toNumber(); // 80
}

// Отмена SELL ордера — освободить 80 токенов
const released = reserved.value.releaseTokenReservation(instrumentId, new Decimal(80));
if (released.ok) {
  released.value.availableTokenQuantity(instrumentId).toNumber(); // 100
  released.value.tokenReservations.size; // 0 (запись удалена)
}

// Проверка перед новым ордером (BalancePolicy)
const available = portfolio.availableTokenQuantity(instrumentId);
if (available.gte(orderSize)) {
  // можно размещать SELL ордер
}
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
