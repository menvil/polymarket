# Layered Architecture - Polymarket

## Визуализация слоев

```
┌─────────────────────────────────────────────────────────────────┐
│                     APPLICATION LAYER                            │
│                                                                  │
│  packages/application/                                           │
│  ├── use-cases/        Trading strategies, order placement      │
│  └── services/         Application services, orchestration      │
│                                                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ depends on
┌──────────────────────────▼──────────────────────────────────────┐
│                   INFRASTRUCTURE LAYER                           │
│                                                                  │
│  packages/infrastructure/                                        │
│  ├── telemetry/        📊 Metrics, tracing, monitoring          │
│  ├── persistence/      💾 Repositories, database adapters       │
│  ├── messaging/        📨 Event bus, pub/sub                    │
│  └── adapters/         🔌 External systems (exchange APIs)      │
│                                                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ depends on
┌──────────────────────────▼──────────────────────────────────────┐
│                      DOMAIN LAYER                                │
│                                                                  │
│  Layer 2: Domain Core                                            │
│  packages/domain/                                                │
│  ├── entities/         Order, Market, Portfolio, Position       │
│  ├── events/           OrderPlaced, OrderFilled, TradeExecuted  │
│  └── ports/            Interfaces for infrastructure            │
│                                                                  │
│  Layer 1: Domain Primitives                                     │
│  packages/domain/                                                │
│  └── value-objects/    Money, Price, Quantity, Quote, Balance  │
│                                                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ depends on
┌──────────────────────────▼──────────────────────────────────────┐
│                     FOUNDATION LAYER                             │
│                                                                  │
│  packages/foundation/                                            │
│  ├── errors/           ❌ Error types and base classes          │
│  ├── result/           ✅ Result<T, E> Railway pattern          │
│  ├── math/             🔢 Decimal operations                    │
│  ├── time/             ⏰ IClock, LiveClock, PaperClock        │
│  └── logger/           📝 ILogger, ConsoleLogger (TODO)         │
│                                                                  │
│  🎯 Характеристики:                                             │
│  • Zero business logic                                          │
│  • No dependencies on upper layers                              │
│  • Reusable in any project                                      │
│  • Pure utilities                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Dependency Flow

```
┌──────────────────────────────────────────────────────┐
│                   Application                        │
└────────────┬───────────────────────┬──────────────────┘
             │                       │
    ┌────────▼────────┐     ┌────────▼─────────┐
    │ Infrastructure  │────▶│  Domain Core     │
    │                 │     │  (entities)      │
    └─────────────────┘     └────────┬─────────┘
             │                       │
             │              ┌────────▼─────────┐
             │              │ Domain Primitives│
             │              │ (value-objects)  │
             │              └────────┬─────────┘
             │                       │
    ┌────────▼───────────────────────▼─────────┐
    │          Foundation Layer                 │
    │   errors, result, math, time, logger     │
    └──────────────────────────────────────────┘

Direction: ⬆ All layers depend on Foundation
           ⬆ Infrastructure depends on Domain
           ⬆ Application depends on all
```

## Размещение модулей

### 🟢 Foundation (Layer 0)

| Модуль | Статус | Описание |
|--------|--------|----------|
| `@polymarket/errors` | ✅ Существует | Базовые классы ошибок |
| `@polymarket/result` | ✅ Существует | Result<T, E> для Railway pattern |
| `@polymarket/math` | ✅ Существует | Decimal операции |
| `@polymarket/time` | ✅ Существует | **IClock и реализации** |
| `@polymarket/logger` | 🟡 TODO | ILogger и реализации |

### 🔵 Domain (Layer 1-2)

| Модуль | Слой | Описание |
|--------|------|----------|
| `@polymarket/value-objects` | Layer 1 | Money, Price, Quantity, Quote |
| `@polymarket/entities` | Layer 2 | Order, Market, Portfolio |
| `@polymarket/events` | Layer 2 | Domain events |
| `@polymarket/ports` | Layer 2 | Интерфейсы для infrastructure |

### 🟡 Infrastructure (Layer 3)

| Модуль | Статус | Описание |
|--------|--------|----------|
| `@polymarket/telemetry` | 🟡 TODO | **Метрики и трейсинг** |
| `@polymarket/persistence` | 🟡 TODO | Репозитории, БД |
| `@polymarket/messaging` | 🟡 TODO | Event bus |
| `@polymarket/adapters` | 🟡 TODO | Внешние системы |

### 🟣 Application (Layer 3)

| Модуль | Статус | Описание |
|--------|--------|----------|
| `@polymarket/use-cases` | 🟡 TODO | Trading strategies |
| `@polymarket/services` | 🟡 TODO | Application services |

## Критерии размещения

### ✅ Поместить в Foundation если:

```typescript
// Проверочный список:
const shouldBeInFoundation = (module: Module): boolean => {
  return (
    module.hasNoDomainDependencies &&      // ✅ Нет domain зависимостей
    module.hasNoBusinessLogic &&           // ✅ Нет бизнес-логики
    module.isReusableInAnyProject &&       // ✅ Переиспользуемо везде
    module.isUtility                       // ✅ Это утилита
  );
};
```

**Примеры:**
- ✅ `time` - абстракция времени без бизнес-логики
- ✅ `logger` - логирование без domain типов
- ✅ `result` - обработка ошибок без бизнес-логики
- ✅ `math` - математика без domain контекста

### ❌ НЕ помещать в Foundation если:

```typescript
const shouldNotBeInFoundation = (module: Module): boolean => {
  return (
    module.dependsOnDomainTypes ||         // ❌ Зависит от Order, Trade
    module.hasBusinessLogic ||             // ❌ Метрики трейдинга
    module.usesExternalLibraries ||        // ❌ prometheus-client
    module.isDomainSpecific                // ❌ Специфично для trading
  );
};
```

**Примеры:**
- ❌ `telemetry` - использует Order, Trade, Market
- ❌ `persistence` - domain repositories
- ❌ `messaging` - domain events

## Примеры зависимостей

### ✅ Правильно: Foundation → Foundation

```typescript
// @polymarket/logger зависит от @polymarket/time
import type { IClock } from '@polymarket/time';

class ConsoleLogger {
  constructor(private readonly clock: IClock) {}

  info(message: string): void {
    const timestamp = this.clock.now(); // ✅ OK
    console.log(`[${timestamp.toISOString()}] ${message}`);
  }
}
```

### ❌ Неправильно: Foundation → Domain

```typescript
// @polymarket/logger НЕ должен зависеть от domain
import type { Order } from '@polymarket/entities'; // ❌ WRONG!

class Logger {
  logOrder(order: Order): void { // ❌ Domain dependency in Foundation!
    // ...
  }
}
```

### ✅ Правильно: Infrastructure → Domain + Foundation

```typescript
// @polymarket/telemetry может зависеть от domain и foundation
import type { Order } from '@polymarket/entities'; // ✅ OK
import type { ILogger } from '@polymarket/logger'; // ✅ OK
import type { IClock } from '@polymarket/time'; // ✅ OK

class MetricsCollector {
  constructor(
    private readonly logger: ILogger,
    private readonly clock: IClock
  ) {}

  recordOrder(order: Order): void { // ✅ OK - Infrastructure can use Domain
    const timestamp = this.clock.now();
    this.logger.info('Order recorded', { orderId: order.id });
  }
}
```

## Ответы на вопросы

### 1. Правильное ли место для time в foundation?

**✅ ДА, АБСОЛЮТНО ПРАВИЛЬНО!**

```
packages/foundation/time/  ← ПРАВИЛЬНО ✅
```

**Аргументы:**
- ✅ Нет бизнес-логики
- ✅ Используется везде (domain, infrastructure, application)
- ✅ Нет зависимостей на domain
- ✅ Аналогично errors, result, math

### 2. Куда положить logger?

**✅ packages/foundation/logger/**

```
packages/foundation/logger/  ← РЕКОМЕНДУЕТСЯ ✅
```

**Аргументы:**
- ✅ Базовая утилита для всех слоев
- ✅ Нет domain зависимостей
- ✅ Зависит только от time (тоже foundation)
- ✅ Переиспользуемо в любом проекте

### 3. Куда положить telemetry?

**✅ packages/infrastructure/telemetry/**

```
packages/infrastructure/telemetry/  ← РЕКОМЕНДУЕТСЯ ✅
```

**Аргументы:**
- ✅ Использует domain types (Order, Trade, Market)
- ✅ Содержит бизнес-логику метрик трейдинга
- ✅ Infrastructure concern
- ✅ Может зависеть от logger и time

**НЕ foundation потому что:**
- ❌ Зависит от @polymarket/entities
- ❌ Специфично для trading системы
- ❌ Не переиспользуемо в других проектах

## Следующие шаги

```bash
# 1. Logger в foundation
mkdir -p packages/foundation/logger

# 2. Telemetry в infrastructure
mkdir -p packages/infrastructure/telemetry

# 3. Application layer
mkdir -p packages/application/use-cases
mkdir -p packages/application/services
```

## Визуализация: Что куда идет

```
                    ┌─────────────────┐
                    │   Your Module   │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
        Does it depend          Does it have
        on Domain types?        business logic?
              │                             │
        ┌─────▼─────┐               ┌───────▼───────┐
        │    NO     │               │      NO       │
        └─────┬─────┘               └───────┬───────┘
              │                             │
        Is it a basic              Is it reusable
        utility?                   in any project?
              │                             │
        ┌─────▼─────┐               ┌───────▼───────┐
        │   YES     │               │     YES       │
        └─────┬─────┘               └───────┬───────┘
              │                             │
              └──────────────┬──────────────┘
                             │
                    ┌────────▼────────┐
                    │   FOUNDATION    │
                    └─────────────────┘


                    ┌─────────────────┐
                    │   Your Module   │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
        Does it use            Is it domain
        Order/Trade/Market?    specific?
              │                             │
        ┌─────▼─────┐               ┌───────▼───────┐
        │   YES     │               │     YES       │
        └─────┬─────┘               └───────┬───────┘
              │                             │
        Is it a                    Is it an
        technical service?         infrastructure
              │                    concern?
        ┌─────▼─────┐               ┌───────▼───────┐
        │   YES     │               │     YES       │
        └─────┬─────┘               └───────┬───────┘
              │                             │
              └──────────────┬──────────────┘
                             │
                    ┌────────▼────────┐
                    │ INFRASTRUCTURE  │
                    └─────────────────┘
```

## Заключение

**@polymarket/time в foundation - правильное решение! ✅**

Создавайте:
- `@polymarket/logger` рядом с time в foundation
- `@polymarket/telemetry` в новой папке infrastructure
