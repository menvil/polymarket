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

### 2. `ReadonlyMap<InstrumentId, Position>` вместо строковых ключей

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
getTotalValue(prices: Map<InstrumentId, OutcomePrice>): Money

// Функции из @polymarket/portfolio (ЕСТЬ):
getTotalValue(portfolio.getPositions(), getPrice, 'USDC')
```

### 5. `tokenBalances` — токены по инструментам, доступные и зарезервированные

**Проблема**: При размещении SELL ордера outcome-токены не резервировались. Это приводило к:

- `BalancePolicy` видел полную позицию без учёта открытых SELL ордеров → **двойная продажа**
- При отмене SELL ничего не освобождалось
- При fill SELL резервация не снималась

**Решение**: `tokenBalances: ReadonlyMap<InstrumentId, TokenBalance>` — симметрично
`balance.available`/`balance.reserved` для USDC.

```typescript
// Баланс USDC (BUY):
balance.available()  // USDC доступно
balance.reserved()   // USDC под открытые BUY ордера

// Токены (SELL):
availableTokens(id)  // токены доступно
reservedTokens(id)   // токены под открытые SELL ордера
```

**Хранятся ОБЕ части, а не одна.** Прежний `availableTokenQuantity(id)`
вычислял доступное как `position.quantity − reserved` и при отрицательном
результате молча зажимал в ноль — то есть нарушенный инвариант не просто не
ловился, а маскировался.

### Инвариант агрегата

```text
Position.quantity == TokenBalance.available + TokenBalance.reserved
```

Проверяется в единственной точке сборки состояния — и в мутаторах, и в
`Portfolio.create()`. Второе существенно: иначе оставался бы публичный вход,
через который агрегат собирается сразу несогласованным, а первая же мутация
отвергала бы состояние, которое сама не создавала.

Резервация — перекладывание, а не расход: количество позиции при ней не
меняется.

**Этап 3 плана миграции**: внутреннее хранилище переведено с голого `Decimal` на `Quantity`
VO — по ADR (`docs/architecture/boundary-contract.md`, Решение 1) `Decimal` легитимен
только внутри `value-objects`/`math`. `Quantity.of()` не имеет инварианта на минимальное
значение (только NaN/finite/non-negative — прежняя формулировка "требует >= 0.0001" была
неточной, путала с диапазоном `OutcomePrice`), поэтому оборачивание безопасно для любого
неотрицательного остатка резервации.

Прежняя оговорка про `Decimal` на публичных сигнатурах устарела вместе с теми
вызывающими: `reserveTokens()`/`releaseTokens()` принимают `Quantity`, а
`availableTokens()`/`reservedTokens()` его возвращают. Тех «30+ вызывающих в
`apps/bot/strategies` и `application/use-cases`» больше не существует — контур
уехал в `legacy-bot/trading-contour-reference/`.

### 6. Канонический `Position`, а не интерфейс

Здесь описывалась структурная типизация через интерфейс `IPosition`, чтобы
`Portfolio` не зависел от пакета позиции напрямую.

**Решение отменено.** У интерфейса была ровно одна реализация — `SimplePosition`,
плоская пара «количество + средняя цена» без лотов. Абстракция при единственной
реализации ничего не давала, зато позволяла тестам подставлять структурные
заглушки и проверять `Portfolio` против объекта, которого в проде не существует.

Теперь портфель хранит канонический `Position` — с лотами, FIFO-закрытием и
VWAP:

```typescript
readonly positions: ReadonlyMap<InstrumentId, Position>;
```

Экономику позиции считает сама позиция: закрытие лотов, `realizedPnL`,
`averageEntryPrice`. Портфель отвечает за согласованность денег, позиций и
токенов — и ни за что сверх этого.

Вернуть интерфейс стоит только если появится реальная граница подмены; принцип
«у сущности должен быть интерфейс» сам по себе такой границей не является.

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
reserveTokens(id, qty)  →  available -= qty, reserved += qty
releaseTokens(id, qty)  →  reserved -= qty, available += qty
availableTokens(id)     →  хранимая часть, НЕ вычисляемая
reservedTokens(id)      →  хранимая часть
```

| Метод | Сценарий использования |
|-------|----------------------|
| `reserveTokens(id, qty)` | Размещение SELL ордера — заморозить токены |
| `releaseTokens(id, qty)` | Отмена SELL — освободить токены |
| `applyFill(fill, positionId)` | Исполнение — деньги, позиция и токены разом |
| `availableTokens(id)` / `reservedTokens(id)` | Чтение хранимых частей |

**Жизненный цикл SELL ордера (симметрия с BUY):**

```
BUY order placed:    reserveForOrder(USDC)             → balance.reserved += notional
BUY fill received:   applyDebit(USDC)                  → balance.reserved -= notional
BUY order cancelled: releaseReservation(USDC)          → balance.reserved -= notional

SELL order placed:    reserveTokens(id, qty)  → available -= qty, reserved += qty
SELL fill received:   applyFill(fill, ...)    → reserved -= size, позиция -= size
SELL order cancelled: releaseTokens(id, qty)  → reserved -= qty, available += qty
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
// Позиция появляется ТОЛЬКО из исполнения: публичного upsertPosition нет.
const bought = portfolio.applyFill(buyFill, positionId); // quantity = 100, available = 100

// Размещение SELL ордера — зарезервировать 80 токенов
const reserved = bought.value.reserveTokens(instrumentId, Quantity.of(new Decimal(80)));
if (reserved.ok) {
  const p = reserved.value;
  p.availableTokens(instrumentId).value().toNumber(); // 20
  p.reservedTokens(instrumentId).value().toNumber();  // 80
  // Позиция не изменилась: резервация — перекладывание, а не расход.
  p.getPosition(instrumentId)?.quantity.value().toNumber(); // 100
}

// Отмена SELL ордера — освободить 80 токенов
const released = reserved.value.releaseTokens(instrumentId, Quantity.of(new Decimal(80)));
if (released.ok) {
  released.value.availableTokens(instrumentId).value().toNumber(); // 100
  released.value.reservedTokens(instrumentId).value().toNumber();  // 0
}
```

### Оценка стоимости

```typescript
import { getTotalValue, getTotalUnrealizedPnL } from '@polymarket/portfolio';

const prices = new Map<InstrumentId, OutcomePrice>([
  [instrumentId, currentPrice],
]);

const getPrice = (id: InstrumentId): OutcomePrice | undefined => prices.get(id);

// getPrice может вернуть undefined — getTotalValue и getTotalUnrealizedPnL
// пропускают позиции без котировки
const totalValue = getTotalValue(portfolio.getPositions(), getPrice, 'USDC');
const totalPnL   = getTotalUnrealizedPnL(portfolio.getPositions(), getPrice);
```

---

## Позиции в портфеле — только канонический `Position`

Здесь описывался структурный интерфейс `IPosition`, которому `Position` якобы
«уже удовлетворял», и рассуждение о том, что менять ничего не надо.

**Интерфейс удалён.** Единственной его реализацией был `SimplePosition` —
блендированная пара «количество + средняя цена». Проверка показала не то, что
`Position` совместим с интерфейсом, а то, что интерфейс не нужен: подставлять
под него оказалось нечего, кроме заглушек в тестах.

```typescript
readonly positions: ReadonlyMap<InstrumentId, Position>;
```

Лоты, FIFO-закрытие и `realizedPnL` принадлежат `Position` и наружу через
портфель не выставляются: портфель отвечает за согласованность денег, позиций и
токенов, а не за экономику каждой позиции.

## Lot-based учёт: где он живёт

Раздел описывал подключение лотов в `PortfolioService` через `instanceof
Position` — обход того, что `IPosition` не выставлял `lots[]`. Ни сервиса, ни
интерфейса больше нет: `PortfolioService` уехал в
`legacy-bot/trading-contour-reference/`, `IPosition` удалён.

Учёт лотов принадлежит `Position` и вызывается из `Portfolio.applyFill()` —
единственного публичного пути, которым позиция вообще меняется:

- **BUY** — новый `PositionLot` по цене филла, `Position.create(...)` для первой
  покупки или `position.addLots([lot], timestamp)` дальше. Количество лота
  ВАЛОВОЕ: комиссию площадка удерживает деньгами, а не шарами
  (`docs/guides/polymarket-fee-settlement.md`).
- **SELL** — `position.close(quantity, price, 'FIFO', timestamp)`. FIFO выбран
  единственным режимом как стандартная бухгалтерская конвенция; потребителя,
  требующего LIFO, не нашлось. Результат включает `realizedPnL`.

Портфель экономику не пересчитывает: деньги он берёт из `fill.getNetCashFlow()`,
количество — валовым, а лоты закрывает сама позиция. Разделение то же, что и в
инварианте: портфель отвечает за согласованность, позиция — за свою экономику.

### Почему `averageEntryPrice` может разойтись со старой моделью — не баг

Blended-pool модель (`SimplePosition`) хранит один пул с единой средней ценой; partial close
уменьшает `quantity`, но не трогает `averageEntryPrice`. Lot-based модель (FIFO) закрывает
конкретные лоты в порядке добавления — если закрытые и оставшиеся лоты куплены по разным
ценам, средняя цена оставшихся лотов после close математически отличается от средней цены
всех лотов до close. Полный числовой пример (лот 50@0.60 + лот 50@0.70, SELL 30 → blended
avg остаётся 0.65, FIFO avg становится ≈0.6714) и практические правила валидации —
в [`docs/architecture/position-accounting.md`](../../../../../docs/architecture/position-accounting.md).
