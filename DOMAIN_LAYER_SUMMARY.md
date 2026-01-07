# Domain Layer - Итоговая сводка

## ✅ Создан полный Domain-слой по DDD архитектуре

Извлечен из монолитного файла `polymarket-mm-bot-v3.js` (3600+ строк) и структурирован по принципам Domain-Driven Design.

---

## 📦 Структура Domain-слоя

```
src/domain/
├── value-objects/           # Immutable значения без identity
│   ├── Money.ts            # Денежные суммы с валютой
│   ├── Price.ts            # Цены [0.01, 0.99] с валидацией
│   ├── Quantity.ts         # Количество акций с tick size
│   ├── Percentage.ts       # Проценты [0, 100] с арифметикой
│   ├── Spread.ts           # Bid-Ask spread с расчетами
│   └── index.ts            # Barrel export
│
├── entities/                # Сущности с identity
│   ├── Market.ts           # Рынок Polymarket
│   ├── Order.ts            # Лимитный ордер
│   ├── Position.ts         # Позиция по токену с FIFO
│   ├── PositionLot.ts      # Отдельный лот для учета
│   └── index.ts            # Barrel export
│
├── aggregates/              # Агрегаты (consistency boundaries)
│   ├── Portfolio.ts        # Портфель (cash + positions)
│   ├── RiskExposure.ts     # Управление рисками
│   ├── TradingSession.ts   # Корневой агрегат сессии
│   └── index.ts            # Barrel export
│
└── index.ts                 # Main entry point

shared/errors/
└── TradingError.ts          # Типизированные ошибки домена
```

---

## 📊 Статистика

| Категория | Файлов | Строк кода | Описание |
|-----------|--------|------------|----------|
| **Value Objects** | 5 | ~1,800 | Immutable значения |
| **Entities** | 4 | ~1,600 | Сущности с identity |
| **Aggregates** | 3 | ~2,200 | Consistency boundaries |
| **Errors** | 1 | ~100 | Типизированные ошибки |
| **Index files** | 5 | ~100 | Barrel exports |
| **ИТОГО** | 18 | **~5,800** | Полный Domain-слой |

---

## 🎯 Value Objects (Immutable)

### 1. **Money** (`Money.ts`)
- Представляет денежные суммы с валютой (USDC)
- Арифметические операции: `add()`, `subtract()`, `multiply()`, `divide()`
- Сравнения: `isGreaterThan()`, `isLessThan()`, `equals()`
- Валидация: неотрицательные суммы, проверка валюты

### 2. **Price** (`Price.ts`)
- Цена в диапазоне [0.01, 0.99] для prediction markets
- Округление к tick size: `toTick()`, `floorToTick()`, `ceilToTick()`
- Операции: `add()`, `subtract()`, `multiply()`
- Конвертация: `toPercentage()`, `toString()`

### 3. **Quantity** (`Quantity.ts`)
- Количество акций/токенов
- Округление к tick size (default 0.1)
- Арифметические операции с валидацией
- Проверки: `isZero()`, `isPositive()`

### 4. **Percentage** (`Percentage.ts`)
- Проценты в диапазоне [0, 100]
- Конвертация: `toDecimal()` (0-1), `toBasisPoints()`
- Метод `of(value)` для расчета процента от суммы
- Операции: `add()`, `subtract()`, `multiply()`, `divide()`

### 5. **Spread** (`Spread.ts`)
- Bid-Ask spread с валидацией
- Расчеты: `width()`, `widthPercentage()`, `midpoint()`
- Операции: `tighten()`, `widen()`, `shift()`
- Проверки: `isZeroWidth()`, `isWide()`, `contains(price)`

---

## 🏗️ Entities (с Identity)

### 1. **Market** (`Market.ts`)
Представление рынка Polymarket:
- **Свойства**: `id`, `question`, `yesTokenId`, `noTokenId`, `expirationDate`, `status`, `resolvedOutcome`
- **Методы**:
  - `isExpired()` - проверка истечения срока
  - `timeToExpiry()` - время до экспирации в мс
  - `isResolved()`, `isActive()` - проверки статуса
  - `canTrade()` - можно ли торговать
  - `getTokenId(outcome)` - получить tokenId для YES/NO

### 2. **Order** (`Order.ts`)
Лимитный ордер с lifecycle:
- **Свойства**: `id`, `tokenId`, `side` (BUY/SELL), `price`, `size`, `status`, `timestamp`
- **Статусы**: PENDING → OPEN → FILLED/CANCELED/REJECTED
- **Методы**:
  - `validate()` - полная валидация бизнес-правил (8 проверок)
  - `isFilled()`, `isOpen()`, `isPending()`, `canCancel()`
  - `getNotional()` - price × size
  - `getRemainingSize()`, `getFillPercentage()`
  - `withStatus()`, `withFill()` - immutable обновления

### 3. **Position** (`Position.ts`)
Агрегированная позиция по токену:
- **Свойства**: `tokenId`, `side` (YES/NO), `totalQuantity`, `averageEntryPrice`, `lots[]`, `unrealizedPnL`
- **FIFO Accounting**: массив `PositionLot` для налогового учета
- **Методы**:
  - `addLot()` - добавить лот, пересчитать average entry price
  - `removeLot()` - FIFO удаление из конкретного лота
  - `calculateUnrealizedPnL(currentPrice)` - P&L по всем лотам
  - `getOldestLot()` - получить первый лот (FIFO)
  - `isEmpty()`, `getTotalCost()`, `getLotCount()`

### 4. **PositionLot** (`PositionLot.ts`)
Отдельный лот для FIFO учета:
- **Свойства**: `lotId`, `tokenId`, `side`, `quantity`, `entryPrice`, `timestamp`
- **Методы**:
  - `calculateCost()` - quantity × entryPrice
  - `calculateUnrealizedPnL(currentPrice)` - P&L с учетом YES/NO инверсии
  - `close(quantity)` - FIFO удаление части лота
  - `isClosed()` - проверка полного закрытия

---

## 🎭 Aggregates (Consistency Boundaries)

### 1. **Portfolio** (`Portfolio.ts`)
**Aggregate Root** для управления портфелем:

**Свойства:**
- `cash` (Money) - доступный баланс
- `reservedCash` (Money) - зарезервировано в ордерах
- `positions` (ReadonlyMap<string, Position>) - позиции по токенам
- Computed: `yesShares`, `noShares`, `netPosition`, `grossPosition`

**Ключевые методы:**
- `addPosition(tokenId, side, lot)` - добавить/обновить позицию
- `removePosition(tokenId, quantity)` - FIFO закрытие позиций
- `reserveCash(amount)` - зарезервировать для ордера
- `releaseCash(amount)` - освободить при отмене
- `deductCash(amount)` - вычесть при исполнении BUY
- `addCash(amount)` - добавить при исполнении SELL
- `calculateTotalValue(prices)` - стоимость портфеля
- `calculateUnrealizedPnL(prices)` - общий P&L
- `canAffordOrder(price, size)` - проверка баланса
- `validateInvariants()` - проверка бизнес-правил

**Инварианты:**
1. Available cash >= 0
2. Reserved cash >= 0
3. Reserved cash <= total cash
4. Все позиции валидны

### 2. **RiskExposure** (`RiskExposure.ts`)
**Aggregate** для управления рисками:

**Свойства:**
- `status` (NORMAL | WARNING | DEFENSIVE | PANIC)
- `mode` (QUOTE | SKEW | UNWIND | PANIC)
- `defensiveMode` (boolean)
- `urgency` (0-1)
- `stateReason`, `stateEnterTime`

**Методы:**
- `checkLimits(portfolio, maxNet, maxGross)` - проверка лимитов
- `calculateUrgency(timeToExpiry, netPosition, maxPosition)` - расчет срочности (60% время, 40% позиция)
- `updateMode(newMode, reason)` - смена торгового режима
- `shouldPanic(unrealizedPnL, lossThreshold)` - проверка паники
- Проверки: `isNormal()`, `isWarning()`, `isDefensive()`, `isPanic()`

**Переходы состояний:**
```
NORMAL → WARNING → DEFENSIVE → PANIC
QUOTE  → SKEW    → UNWIND    → PANIC
```

### 3. **TradingSession** (`TradingSession.ts`)
**Root Aggregate** для всей торговой сессии:

**Свойства:**
- `sessionId` - уникальный ID
- `market` - Market entity
- `portfolio` - Portfolio aggregate
- `riskExposure` - RiskExposure aggregate
- `activeOrders` - Map<orderId, Order>
- `startTime`, `lastUpdateTime`

**Жизненный цикл ордера:**
```typescript
// 1. Размещение
session = session.placeOrder(order);
// → Резервирует cash (BUY), добавляет в activeOrders

// 2. Исполнение
session = session.fillOrder(orderId, fillSize, fillPrice);
// → Создает PositionLot, обновляет Portfolio, удаляет если полностью исполнен

// 3. Отмена
session = session.cancelOrder(orderId);
// → Освобождает reserved cash, удаляет из activeOrders
```

**Методы:**
- `placeOrder(order)` - размещение с резервированием cash
- `fillOrder(orderId, fillSize, fillPrice)` - исполнение с FIFO учетом
- `cancelOrder(orderId)` - отмена с освобождением cash
- `updateRisk(prices, timeToExpiry, limits)` - обновление risk exposure
- `canPlaceOrder(order)` - валидация против всех правил
- `getActiveOrdersForToken(tokenId)` - фильтр ордеров
- `validateSessionInvariants()` - проверка всех инвариантов

**Инварианты сессии:**
1. Market активен и можно торговать
2. Portfolio инварианты соблюдены
3. RiskExposure инварианты соблюдены
4. Reserved cash = сумма BUY ордеров
5. Все ордера принадлежат рынку сессии
6. Время валидно (start < lastUpdate)

---

## ❌ Типизированные ошибки

Все ошибки наследуются от `TradingError`:

```typescript
class TradingError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
}
```

**Список ошибок:**
1. `InsufficientFundsError` - недостаточно средств
2. `OrderValidationError` - невалидный ордер
3. `PositionLimitExceededError` - превышен лимит позиции
4. `MarketNotFoundError` - рынок не найден
5. `InvalidPriceError` - цена вне диапазона [0.01, 0.99]
6. `InvalidQuantityError` - невалидное количество
7. `ExchangeError` - ошибка биржи
8. `InvalidPercentageError` - процент вне [0, 100]
9. `InvalidSpreadError` - bid > ask
10. `InsufficientPositionError` - недостаточно позиции
11. `LotNotFoundError` - лот не найден
12. `InsufficientLotQuantityError` - недостаточно в лоте

---

## 🔧 Использование

### Простой импорт всех типов:

```typescript
import {
  // Value Objects
  Money, Price, Quantity, Percentage, Spread,
  
  // Entities
  Market, Order, Position, PositionLot,
  
  // Aggregates
  Portfolio, RiskExposure, TradingSession,
  
  // Errors
  InsufficientFundsError, OrderValidationError
} from '@domain';
```

### Пример создания торговой сессии:

```typescript
// 1. Создать рынок
const market = Market.create({
  id: 'market-123',
  question: 'Will Bitcoin reach $100k in 2025?',
  yesTokenId: 'token-yes',
  noTokenId: 'token-no',
  expirationDate: new Date('2025-12-31'),
  status: 'ACTIVE',
  resolvedOutcome: null
});

// 2. Создать сессию с начальным балансом
const session = TradingSession.create(
  market,
  Money.fromUSDC(10000)
);

// 3. Создать и разместить ордер
const order = Order.create({
  id: 'order-1',
  tokenId: market.yesTokenId,
  side: 'BUY',
  price: Price.fromNumber(0.65),
  size: Quantity.fromNumber(10),
  status: 'PENDING',
  timestamp: new Date()
});

const withOrder = session.placeOrder(order);
// → Cash зарезервирован: 0.65 × 10 = $6.50

// 4. Исполнить ордер
const filled = withOrder.fillOrder(
  'order-1',
  Quantity.fromNumber(10),
  Price.fromNumber(0.65)
);
// → PositionLot создан, Portfolio обновлен

// 5. Проверить портфель
console.log(filled.portfolio.cash.amount);          // 3.50 (10000 - 6.50)
console.log(filled.portfolio.yesShares.value);      // 10
console.log(filled.portfolio.netPosition);          // 10

// 6. Обновить risk exposure
const prices = new Map([
  [market.yesTokenId, Price.fromNumber(0.70)]
]);
const limits = {
  maxNetPosition: 50,
  maxGrossPosition: 100,
  maxLossThreshold: Money.fromUSDC(100)
};

const withRisk = filled.updateRisk(prices, 86400000, limits);
console.log(withRisk.riskExposure.status);    // 'NORMAL'
console.log(withRisk.riskExposure.mode);      // 'QUOTE'
```

---

## 📐 Design Principles

### 1. **Immutability**
Все Value Objects, Entities и Aggregates immutable:
```typescript
const price1 = Price.fromNumber(0.5);
const price2 = price1.add(0.1);  // Возвращает НОВЫЙ Price
console.log(price1.value);        // 0.5 (не изменился)
console.log(price2.value);        // 0.6
```

### 2. **Factory Methods**
Private конструкторы + static factory methods:
```typescript
// ❌ Нельзя
const order = new Order(...);

// ✅ Правильно
const order = Order.create({...});
```

### 3. **Rich Domain Model**
Бизнес-логика в сущностях, не в сервисах:
```typescript
// ✅ Логика в домене
if (order.canCancel()) {
  session = session.cancelOrder(order.id);
}

// ❌ Анемичная модель
if (order.status === 'OPEN' || order.status === 'PENDING') {
  // логика в сервисе
}
```

### 4. **Aggregate Boundaries**
Четкие boundaries для транзакционной целостности:
- `Portfolio` - граница для cash + positions
- `RiskExposure` - граница для risk state
- `TradingSession` - корневой агрегат для всей сессии

### 5. **FIFO Accounting**
Соответствие налоговым требованиям:
```typescript
// Покупки создают лоты
const lot1 = new PositionLot('lot-1', tokenId, 'YES', qty1, price1, date1);
const lot2 = new PositionLot('lot-2', tokenId, 'YES', qty2, price2, date2);

// Продажи закрывают oldest first
position = position.addLot(lot1).addLot(lot2);
position = position.removeLot(lot1.lotId, sellQty);  // FIFO!
```

---

## ✅ Полное соответствие требованиям

- ✅ Все сущности **иммутабельные** (readonly свойства)
- ✅ Бизнес-правила и **инварианты в методах** сущностей
- ✅ Value Objects отделены: Money, Price, Quantity, Percentage, Spread
- ✅ Aggregates: Portfolio, RiskExposure, TradingSession
- ✅ Все ошибки **типизированы** и наследуются от TradingError
- ✅ **Полная TSDoc документация** (@param, @returns, @throws, @example, @remarks)
- ✅ **Валидация** во всех factory methods
- ✅ **Компилируется без ошибок** (`npm run type-check` ✓)

---

## 🚀 Следующие шаги

Domain-слой готов! Теперь можно:

1. **Application Layer** - создать Use Cases (PlaceOrderHandler, QuoteGenerationHandler)
2. **Domain Services** - pricing, risk, inventory (FairValueService, RiskAssessmentService)
3. **Strategies** - торговые стратегии (TwoSidedMarketMaker, UnwindStrategy)
4. **Unit Tests** - тесты для всех Value Objects, Entities, Aggregates
5. **Infrastructure** - адаптеры для Polymarket API, repositories, UI

Domain-слой теперь является **single source of truth** для бизнес-логики! 🎉
