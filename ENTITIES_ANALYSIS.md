# Анализ Entities: Зависимости, Место, Domain Логика

## 🔍 Текущее состояние

### Структура проекта
```
/Users/menvil/Projects/polymarket/
├── packages/
│   ├── domain/
│   │   ├── entities/          # ✅ Есть 7 файлов
│   │   ├── value-objects/     # ✅ Есть 6 файлов
│   │   ├── events/            # ❌ ПУСТАЯ папка
│   │   ├── ports/             # ❌ ПУСТАЯ папка
│   │   └── types/             # ❌ ПУСТАЯ папка
│   └── core/                  # ❓ Неизвестно что внутри
├── CLAUDE.md
└── REFACTORING_PLAN.md
```

### Entities файлы
1. `Market.ts` - Рынок предсказаний (бинарный)
2. `Order.ts` - Торговый ордер
3. `Orderbook.ts` - Стакан заявок (bid/ask уровни)
4. `Position.ts` - Aggregate позиция (множество лотов)
5. `PositionLot.ts` - Единичный лот (FIFO)
6. `Trade.ts` - Исполненная сделка
7. `index.ts` - Barrel export

---

## 📊 Анализ зависимостей

### Market.ts
```typescript
import { MarketNotFoundError } from '../../shared/errors/TradingError.js';
```
**Зависимости:**
- ❌ `../../shared/` - НЕ СУЩЕСТВУЕТ в проекте

**Статус:** 🔴 BROKEN IMPORT

---

### Order.ts
```typescript
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { OrderValidationError } from '../../shared/errors/TradingError.js';
import type { ExecutionEvent, OrderAccepted } from '../events/ExecutionEvent.js';
import { OrderExecutionState, isAllowedTransition } from '../execution/OrderExecutionState.js';
import type { Result } from '../../shared/types/Result.js';
import { Ok, Err } from '../../shared/types/Result.js';
```
**Зависимости:**
- ✅ `../value-objects/` - Есть (Price, Quantity)
- ❌ `../../shared/errors/` - НЕ СУЩЕСТВУЕТ
- ❌ `../events/ExecutionEvent.js` - events папка ПУСТАЯ
- ❌ `../execution/OrderExecutionState.js` - execution НЕ СУЩЕСТВУЕТ
- ❌ `../../shared/types/Result.js` - НЕ СУЩЕСТВУЕТ

**Статус:** 🔴 МНОЖЕСТВЕННЫЕ BROKEN IMPORTS

---

### Orderbook.ts
```typescript
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { Spread } from '../value-objects/Spread.js';
```
**Зависимости:**
- ✅ `../value-objects/` - Все есть (Price, Quantity, Spread)

**Статус:** ✅ ВАЛИДНЫЙ

---

### Position.ts
```typescript
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { Money } from '../value-objects/Money.js';
import { PositionLot, Side } from './PositionLot.js';
import { TradingError } from '../../shared/errors/TradingError.js';
```
**Зависимости:**
- ✅ `../value-objects/` - Все есть (Price, Quantity, Money)
- ✅ `./PositionLot.js` - Есть
- ❌ `../../shared/errors/` - НЕ СУЩЕСТВУЕТ

**Статус:** 🟡 ЧАСТИЧНО ВАЛИДНЫЙ (1 broken import)

---

### PositionLot.ts
```typescript
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { Money } from '../value-objects/Money.js';
import { TradingError } from '../../shared/errors/TradingError.js';
```
**Зависимости:**
- ✅ `../value-objects/` - Все есть (Price, Quantity, Money)
- ❌ `../../shared/errors/` - НЕ СУЩЕСТВУЕТ

**Статус:** 🟡 ЧАСТИЧНО ВАЛИДНЫЙ (1 broken import)

---

### Trade.ts
```typescript
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { TradingError } from '../../shared/errors/TradingError.js';
```
**Зависимости:**
- ✅ `../value-objects/` - Все есть (Price, Quantity)
- ❌ `../../shared/errors/` - НЕ СУЩЕСТВУЕТ

**Статус:** 🟡 ЧАСТИЧНО ВАЛИДНЫЙ (1 broken import)

---

## 📋 Сводка зависимостей

### Существующие зависимости (валидные)
```
entities/
  ↓ зависят от
value-objects/ (Price, Quantity, Money, Spread)
  ✅ ВСЕ ЕСТЬ в packages/domain/value-objects/
```

### Отсутствующие зависимости (broken)
```
entities/
  ↓ пытаются зависеть от
  ❌ ../../shared/errors/TradingError.js    - НЕ СУЩЕСТВУЕТ
  ❌ ../../shared/types/Result.js           - НЕ СУЩЕСТВУЕТ
  ❌ ../events/ExecutionEvent.js             - events/ ПУСТАЯ
  ❌ ../execution/OrderExecutionState.js     - execution/ НЕ СУЩЕСТВУЕТ
```

---

## ❓ Является ли это Domain логикой?

### ✅ ДА, это Domain логика

**Почему entities = Domain:**

1. **Entity имеет идентичность**
   - Market имеет `id` (condition ID)
   - Order имеет `id`
   - Position имеет `tokenId` + `side`
   - Trade имеет `id`
   - ✅ Все entities имеют уникальную идентичность

2. **Entity имеет lifecycle**
   - Order: PENDING → OPEN → FILLED/CANCELED
   - Market: ACTIVE → CLOSED → RESOLVED
   - Position: empty → с лотами → закрыта
   - ✅ Все entities имеют lifecycle

3. **Entity содержит бизнес-правила**
   - Market: `canTrade()` проверяет ACTIVE && !isExpired()
   - Order: `canCancel()` проверяет PENDING || OPEN
   - Position: FIFO алгоритм в `removeLot()`
   - ✅ Содержат domain правила

4. **Entity неизменяема (immutable)**
   - Все свойства `readonly`
   - Методы возвращают новые экземпляры
   - ✅ Следуют functional programming принципам

**Вывод:** Entities правильно находятся в `packages/domain/entities/`

---

## 🏗️ Правильное ли место для entities?

### Текущее место
```
packages/domain/entities/
```

### Проблема текущей структуры

**❌ Entities в папке domain, но зависят от вещей ВНЕ domain:**
```
entities/
  ↓
../../shared/    # ВНЕ packages/domain/
```

**Это нарушает принцип:** Domain не должен зависеть от вещей вне Domain!

### ✅ Правильная структура

#### Вариант 1: Всё в domain (рекомендуется)
```
packages/domain/
├── entities/              # Domain Entities
├── value-objects/         # Domain Value Objects
├── errors/                # Domain Errors (TradingError)
│   └── TradingError.ts
├── types/                 # Domain Types (Result<T, E>)
│   └── Result.ts
├── events/                # Domain Events
│   └── ExecutionEvent.ts
└── state-machines/        # Domain FSM
    └── OrderExecutionState.ts
```

**Принцип:** Всё что нужно entities находится В domain

#### Вариант 2: Entities как отдельный пакет
```
packages/
├── entities/              # Изолированный пакет
│   ├── package.json       # deps: [@polymarket/value-objects, @polymarket/errors]
│   └── src/
│       ├── Market.ts
│       ├── Order.ts
│       └── ...
├── value-objects/         # Изолированный пакет
│   └── package.json       # deps: []
├── errors/                # Изолированный пакет
│   └── package.json       # deps: []
└── domain-core/           # Aggregate пакет
    └── package.json       # deps: [entities, value-objects, errors]
```

**Принцип:** Entities - отдельный пакет с явными зависимостями

---

## 🎯 Что НЕ является Domain логикой в entities

### Order.ts - ПЕРЕГРУЖЕН ❌

```typescript
// ❌ Event Sourcing логика - НЕ domain entity
public applyExecutionEvent(event: ExecutionEvent): Result<Order, string>
public static fromOrderAccepted(event: OrderAccepted): Result<Order, string>

// ❌ FSM transitions - НЕ domain entity
private mapStatusToExecutionState(status: OrderStatus): OrderExecutionState

// ❌ Application логика - НЕ domain entity
private _calculateWeightedAveragePrice(...): number
```

**Проблема:** Order.ts содержит ~780 строк, из них:
- ~150 строк - чистая entity логика ✅
- ~630 строк - event sourcing + FSM ❌

**Должно быть:**
- `Order.ts` (entity) - 50-70 строк
- `OrderProjector.ts` (service) - event sourcing логика
- `OrderStateMachine.ts` (service) - FSM transitions

---

### Orderbook.ts - КАЛЬКУЛЯТОР ❌

```typescript
// ❌ Аналитика - НЕ entity
public getMicroprice(): Price | null
public getImbalance(levels: number = 5): number
public getTotalBidVolume(levels?: number): Quantity
public getTotalAskVolume(levels?: number): Quantity
```

**Проблема:** Orderbook.ts содержит ~570 строк, из них:
- ~100 строк - чистая entity логика (хранение данных) ✅
- ~470 строк - вычислительная логика (анализ, метрики) ❌

**Должно быть:**
- `Orderbook.ts` (entity) - 80-100 строк (только данные + базовые accessors)
- `OrderbookAnalyzer.ts` (service) - вся аналитическая логика

---

### Portfolio.ts - ТРЕБУЕТ ВНЕШНИЕ ДАННЫЕ ❌

```typescript
// ❌ Требует внешнее состояние (рыночные цены)
public getTotalValue(marketPrices: Map<string, Price>): Money
public getTotalUnrealizedPnL(marketPrices: Map<string, Price>): Money
```

**Проблема:** Entity не должна требовать внешние данные для вычислений

**Должно быть:**
- `Portfolio.ts` (entity) - управление позициями + кэш
- `PortfolioValuationService.ts` (service) - расчёты с рыночными ценами

---

## 📐 Критерии: Что МОЖЕТ быть в Entity

### ✅ Domain Entity может содержать:

1. **Идентичность** (id, уникальный ключ)
   ```typescript
   public readonly id: string;
   public readonly tokenId: string;
   ```

2. **Состояние** (данные)
   ```typescript
   public readonly status: OrderStatus;
   public readonly quantity: Quantity;
   ```

3. **Валидация** (инварианты)
   ```typescript
   public validate(): void {
     if (!this.quantity.isPositive()) {
       throw new Error('Quantity must be positive');
     }
   }
   ```

4. **Query методы** (readonly, без побочных эффектов)
   ```typescript
   public isFilled(): boolean
   public canCancel(): boolean
   public getRemainingSize(): Quantity
   ```

5. **Immutable mutations** (возвращают новый экземпляр)
   ```typescript
   public withStatus(status: OrderStatus): Order
   public addLot(lot: PositionLot): Position
   ```

6. **Простые вычисления** (используют только своё состояние)
   ```typescript
   public getNotional(): number {
     return this.price.value * this.size.value;
   }
   ```

---

## 🚫 Что НЕ МОЖЕТ быть в Entity

### ❌ Domain Entity НЕ должна содержать:

1. **Application логику** (event sourcing, projections)
   ```typescript
   // ❌ Убрать из Order.ts
   public applyExecutionEvent(event: ExecutionEvent): Result<Order, string>
   ```

2. **Сложные вычисления** (алгоритмы, анализ)
   ```typescript
   // ❌ Убрать из Orderbook.ts
   public getMicroprice(): Price | null
   public getImbalance(levels: number): number
   ```

3. **Внешние зависимости** (требование данных извне)
   ```typescript
   // ❌ Убрать из Portfolio.ts
   public getTotalValue(marketPrices: Map<string, Price>): Money
   ```

4. **FSM логику** (управление переходами состояний)
   ```typescript
   // ❌ Убрать из Order.ts
   private mapStatusToExecutionState(...): OrderExecutionState
   ```

5. **Зависимость от Infrastructure** (DB, API, etc.)
   ```typescript
   // ❌ НЕ ДОЛЖНО БЫТЬ
   public async save(): Promise<void>
   public static async findById(id: string): Promise<Order>
   ```

---

## 🎯 План рефакторинга entities

### Фаза 1: Исправить структуру папок (1 день)

```bash
# Создать недостающие папки в domain
mkdir -p packages/domain/errors
mkdir -p packages/domain/types
mkdir -p packages/domain/events
mkdir -p packages/domain/state-machines
mkdir -p packages/domain/services
```

**Создать файлы:**
1. `packages/domain/errors/TradingError.ts`
2. `packages/domain/types/Result.ts`
3. `packages/domain/events/ExecutionEvent.ts`
4. `packages/domain/state-machines/OrderExecutionState.ts`

**Исправить все imports в entities:**
- `../../shared/errors/` → `../errors/`
- `../../shared/types/` → `../types/`
- `../execution/` → `../state-machines/`

---

### Фаза 2: Упростить перегруженные entities (2 дня)

#### 2.1. Упростить Order.ts (50-70 строк)

**Убрать:**
```typescript
// Убрать в OrderProjectionService
public applyExecutionEvent(event: ExecutionEvent): Result<Order, string>
public static fromOrderAccepted(event: OrderAccepted): Result<Order, string>
private _calculateWeightedAveragePrice(...): number

// Убрать в OrderStateMachine
private mapStatusToExecutionState(...): OrderExecutionState
```

**Оставить:**
```typescript
// Состояние
public readonly id: string;
public readonly status: OrderStatus;
public readonly price: Price;
public readonly size: Quantity;

// Валидация
public validate(): void

// Query методы
public isFilled(): boolean
public isOpen(): boolean
public canCancel(): boolean
public getNotional(): number

// Immutable mutations
public withStatus(status: OrderStatus): Order
public withFill(size: Quantity, price: Price): Order
```

---

#### 2.2. Упростить Orderbook.ts (80-100 строк)

**Убрать:**
```typescript
// Убрать в OrderbookAnalyzer
public getMicroprice(): Price | null
public getImbalance(levels: number): number
public getTotalBidVolume(levels?: number): Quantity
public getTotalAskVolume(levels?: number): Quantity
public toObject(): object
```

**Оставить:**
```typescript
// Данные
public readonly bids: readonly OrderbookLevel[];
public readonly asks: readonly OrderbookLevel[];
public readonly timestamp: Date;

// Базовые accessors
public getBestBid(): Price | null
public getBestAsk(): Price | null
public getSpread(): Spread | null
public getMidPrice(): Price | null

// Простые проверки
public isEmpty(): boolean
public hasLiquidity(): boolean
public isStale(maxAgeMs: number): boolean
```

---

#### 2.3. Упростить Portfolio.ts (НЕ entity - это Aggregate!) ⚠️

**Важно:** Portfolio НЕ entity, это **Aggregate Root**!

**Решение:** Переместить в отдельную папку
```
packages/domain/
├── entities/           # Простые entities
│   ├── Market.ts
│   ├── Order.ts
│   ├── Trade.ts
│   └── ...
└── aggregates/         # Aggregates (управляют entities)
    └── Portfolio.ts    # Aggregate Root (управляет Position entities)
```

**Убрать:**
```typescript
// Убрать в PortfolioValuationService
public getTotalValue(marketPrices: Map<string, Price>): Money
public getTotalUnrealizedPnL(marketPrices: Map<string, Price>): Money
```

---

### Фаза 3: Тесты (1 день)

**Создать тесты для упрощённых entities:**
- `Order.test.ts` (20+ тестов)
- `Orderbook.test.ts` (15+ тестов)
- `Market.test.ts` (10+ тестов)
- `Position.test.ts` (25+ тестов)
- `PositionLot.test.ts` (15+ тестов)
- `Trade.test.ts` (10+ тестов)

**Coverage требование:** 90%+ для entities

---

### Фаза 4: Документация (0.5 дня)

**Обновить TSDoc комментарии:**
- Убрать упоминания удалённых методов
- Добавить примеры для оставшихся методов
- Добавить `@remarks` с принципами (что может/не может entity)

**Создать:**
- `docs/domain/entities/README.md` - принципы entities
- `docs/domain/entities/responsibilities.md` - что может/не может entity

---

## 📊 Итоговая структура

```
packages/domain/
├── entities/                  # Простые Domain Entities (идентичность + lifecycle)
│   ├── Market.ts              # 70-90 строк
│   ├── Order.ts               # 50-70 строк
│   ├── Orderbook.ts           # 80-100 строк
│   ├── Position.ts            # 150-200 строк (aggregate)
│   ├── PositionLot.ts         # 100-120 строк ✅ уже хорош
│   ├── Trade.ts               # 100-120 строк ✅ уже хорош
│   └── index.ts
│
├── aggregates/                # Domain Aggregates (управляют entities)
│   └── Portfolio.ts           # 120-150 строк (aggregate root)
│
├── value-objects/             # Domain Value Objects (без идентичности)
│   ├── Price.ts
│   ├── Quantity.ts
│   ├── Money.ts
│   ├── Spread.ts
│   └── index.ts
│
├── errors/                    # Domain Errors
│   └── TradingError.ts
│
├── types/                     # Domain Types
│   └── Result.ts
│
├── events/                    # Domain Events
│   └── ExecutionEvent.ts
│
├── state-machines/            # FSM логика
│   └── OrderExecutionState.ts
│
├── services/                  # Domain Services (сложная логика)
│   ├── OrderProjectionService.ts
│   ├── OrderbookAnalyzer.ts
│   └── PortfolioValuationService.ts
│
└── __tests__/                 # Тесты зеркалируют структуру
    ├── entities/
    ├── aggregates/
    ├── value-objects/
    └── services/
```

---

## 🎯 Критерии успеха

### ✅ После рефакторинга

1. **Нет broken imports**
   ```bash
   # Все imports работают
   npm run build  # ✅ проходит без ошибок
   ```

2. **Entities упрощены**
   - Order.ts: 50-70 строк (сейчас ~780)
   - Orderbook.ts: 80-100 строк (сейчас ~570)
   - Portfolio.ts: 120-150 строк (сейчас ~610)

3. **Все зависимости в domain**
   ```
   entities/ → value-objects/ ✅
   entities/ → errors/ ✅
   entities/ → types/ ✅

   НЕТ зависимостей вне domain ✅
   ```

4. **Coverage 90%+**
   ```bash
   npm run test:coverage
   # entities/: 92% ✅
   ```

5. **Документация актуальна**
   - TSDoc для всех методов ✅
   - Примеры в коде ✅
   - Markdown документация ✅

---

## 📈 Оценка времени

- **Фаза 1:** 1 день (исправить структуру папок + imports)
- **Фаза 2:** 2 дня (упростить entities)
- **Фаза 3:** 1 день (тесты)
- **Фаза 4:** 0.5 дня (документация)

**Итого:** ~4.5 дня

---

## 🚀 С чего начать?

### Шаг 1: Создать недостающие файлы
```bash
# Создать TradingError
cat > packages/domain/errors/TradingError.ts << 'EOF'
export class TradingError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'TradingError';
  }
}

export class MarketNotFoundError extends TradingError {
  constructor(marketId: string) {
    super(`Market not found: ${marketId}`, 'MARKET_NOT_FOUND');
  }
}

export class OrderValidationError extends TradingError {
  constructor(message: string, public readonly field?: string) {
    super(message, 'ORDER_VALIDATION_ERROR');
  }
}

export class InsufficientFundsError extends TradingError {
  constructor(
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Insufficient funds: requested ${requested}, available ${available}`,
      'INSUFFICIENT_FUNDS'
    );
  }
}
EOF
```

### Шаг 2: Создать Result
```bash
cat > packages/domain/types/Result.ts << 'EOF'
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
EOF
```

### Шаг 3: Исправить imports
```bash
# Заменить в всех entities файлах
find packages/domain/entities -name "*.ts" -exec sed -i '' 's|../../shared/errors/|../errors/|g' {} \;
find packages/domain/entities -name "*.ts" -exec sed -i '' 's|../../shared/types/|../types/|g' {} \;
```

### Шаг 4: Запустить сборку
```bash
npm run build
# Должно пройти без ошибок ✅
```

Готов начинать?
