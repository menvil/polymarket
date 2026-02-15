# Архитектура проекта Polymarket

## Текущая структура

```
packages/
├── foundation/          # Layer 0: Базовые утилиты (без зависимостей)
│   ├── errors/         # Типы ошибок
│   ├── math/           # Математические операции
│   ├── result/         # Result<T, E> для Railway-Oriented Programming
│   └── time/           # ✅ IClock и реализации (ПРАВИЛЬНОЕ место)
│
├── domain/             # Layer 1-2: Domain layer
│   ├── value-objects/  # Domain primitives (Money, Price, Quantity, Quote)
│   ├── entities/       # Domain entities (Order, Market, Portfolio)
│   ├── events/         # Domain events
│   ├── ports/          # Интерфейсы для infrastructure
│   └── types/          # Domain типы
│
└── core/               # Layer 3: Application layer (пустой сейчас)
```

## Layered Architecture (Clean Architecture)

### Layer 0: Foundation (Базовый слой)

**Назначение:** Переиспользуемые утилиты без бизнес-логики

**Характеристики:**

- ✅ Zero dependencies на другие слои
- ✅ Нет бизнес-логики
- ✅ Чистые функции и утилиты
- ✅ Переиспользуемость в любых проектах

**Текущие модули:**

- `@polymarket/errors` - базовые классы ошибок
- `@polymarket/math` - математические операции над Decimal
- `@polymarket/result` - Result<T, E> для Railway-Oriented Programming
- `@polymarket/time` - абстракции времени (IClock, LiveClock, PaperClock, ReplayClock)

**Правило:** Модуль в foundation НЕ должен зависеть от domain или core

### Layer 1: Domain Primitives (Value Objects)

**Назначение:** Неизменяемые domain-специфичные примитивы

**Характеристики:**

- ✅ Immutable
- ✅ Инварианты в конструкторе
- ✅ Бизнес-логика внутри value object
- ✅ Зависит ТОЛЬКО от foundation

**Текущие модули:**

- `@polymarket/value-objects`
  - Money, Price, Quantity, Quote, Balance, Spread, Percentage

**Зависимости:**

```
value-objects → foundation (errors, math, result, time)
```

### Layer 2: Domain Core (Entities & Events)

**Назначение:** Бизнес-сущности и события

**Характеристики:**

- ✅ Mutable state
- ✅ Identity (ID)
- ✅ Бизнес-логика и правила
- ✅ Зависит от value-objects и foundation

**Текущие модули:**

- `@polymarket/entities` (Order, Market, Portfolio, Position, Trade)
- `@polymarket/events` (domain events)
- `@polymarket/ports` (интерфейсы для infrastructure)

**Зависимости:**

```
entities → value-objects → foundation
events → value-objects → foundation
ports → entities → value-objects → foundation
```

### Layer 3: Application/Infrastructure

**Назначение:** Технические сервисы, адаптеры, use cases

**Сейчас:** `core/` пустой

**Что может быть:**

- Application Services (use cases)
- Infrastructure Services (адаптеры к внешним системам)
- Observability (logging, telemetry, metrics)

## Где разместить Logger и Telemetry?

### 🟢 Logger → `packages/foundation/logger`

**Почему foundation?**

- ✅ Это базовая утилита
- ✅ Используется на ВСЕХ слоях
- ✅ Нет бизнес-логики
- ✅ Нет domain-специфичных зависимостей
- ✅ Аналогично time, result, errors

**Зависимости:**

```typescript
@polymarket/logger
  → @polymarket/time (для timestamps)
  → @polymarket/result (опционально, для Result-based API)
```

**Структура:**

```
packages/foundation/logger/
├── src/
│   ├── ILogger.ts          # Интерфейс логгера
│   ├── ConsoleLogger.ts    # Реализация для консоли
│   ├── FileLogger.ts       # Реализация для файлов
│   ├── NoOpLogger.ts       # Пустая реализация для тестов
│   ├── LogLevel.ts         # Enum уровней
│   └── index.ts
├── __tests__/
└── docs/
```

**Пример API:**

```typescript
interface ILogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
}

// С dependency injection времени
class ConsoleLogger implements ILogger {
  constructor(
    private readonly clock: IClock,
    private readonly level: LogLevel = LogLevel.INFO
  ) {}

  info(message: string, context?: Record<string, unknown>): void {
    const timestamp = this.clock.now();
    console.log(JSON.stringify({
      timestamp: timestamp.toISOString(),
      level: 'INFO',
      message,
      ...context,
    }));
  }
}
```

### 🟡 Telemetry → `packages/infrastructure/telemetry` или `packages/observability/telemetry`

**Почему НЕ foundation?**

- ❌ Зависит от domain-специфичных типов (Order, Trade, Market)
- ❌ Содержит бизнес-логику (метрики трейдинга)
- ❌ Может использовать сторонние библиотеки (prometheus, datadog)
- ❌ Это infrastructure concern, не foundation utility

**Зависимости:**

```typescript
@polymarket/telemetry
  → @polymarket/entities (Order, Trade, Market)
  → @polymarket/value-objects (Money, Price, Quantity)
  → @polymarket/logger (для логирования)
  → @polymarket/time (для timestamps)
  → external libraries (prometheus-client, opentelemetry)
```

**Структура:**

```
packages/infrastructure/telemetry/
├── src/
│   ├── ITelemetryCollector.ts    # Интерфейс
│   ├── MetricsCollector.ts       # Сбор метрик
│   ├── TracingCollector.ts       # Distributed tracing
│   ├── PerformanceCollector.ts   # Performance metrics
│   ├── adapters/
│   │   ├── PrometheusAdapter.ts
│   │   ├── DatadogAdapter.ts
│   │   └── OpenTelemetryAdapter.ts
│   └── index.ts
├── __tests__/
└── docs/
```

**Пример API:**

```typescript
interface ITelemetryCollector {
  recordOrderPlaced(order: Order, timestamp: Date): void;
  recordOrderFilled(order: Order, fillPrice: Price, timestamp: Date): void;
  recordTrade(trade: Trade, timestamp: Date): void;
  recordMarketUpdate(market: Market, timestamp: Date): void;

  getMetrics(): Metrics;
  flush(): Promise<void>;
}

// Использует domain types
class MetricsCollector implements ITelemetryCollector {
  constructor(
    private readonly logger: ILogger,
    private readonly clock: IClock
  ) {}

  recordOrderPlaced(order: Order, timestamp: Date): void {
    // Логика сбора метрик, специфичная для трейдинга
    this.metrics.ordersPlaced.inc();
    this.metrics.orderValue.observe(order.totalValue.amount);

    this.logger.info('Order placed', {
      orderId: order.id,
      price: order.price.value,
      quantity: order.quantity.value,
      timestamp: timestamp.toISOString(),
    });
  }
}
```

## Рекомендуемая итоговая структура

```
packages/
├── foundation/              # Layer 0: Базовые утилиты
│   ├── errors/             # ✅ Типы ошибок
│   ├── math/               # ✅ Математика
│   ├── result/             # ✅ Result<T, E>
│   ├── time/               # ✅ IClock и реализации (ПРАВИЛЬНО!)
│   └── logger/             # 🟢 ДОБАВИТЬ СЮДА
│
├── domain/                  # Layer 1-2: Domain layer
│   ├── value-objects/      # ✅ Money, Price, Quantity, Quote
│   ├── entities/           # ✅ Order, Market, Portfolio
│   ├── events/             # ✅ Domain events
│   ├── ports/              # ✅ Интерфейсы
│   └── types/              # ✅ Domain типы
│
├── infrastructure/          # Layer 3: Infrastructure
│   ├── telemetry/          # 🟡 СОЗДАТЬ - метрики и трейсинг
│   ├── persistence/        # Репозитории, БД
│   ├── messaging/          # Event bus, pub/sub
│   └── adapters/           # Адаптеры к внешним системам
│
└── application/             # Layer 3: Application
    ├── use-cases/          # Use cases (стратегии)
    └── services/           # Application services
```

## Dependency Flow

```
┌─────────────────────────────────────────────────────────┐
│                    Application Layer                     │
│                  (use-cases, services)                   │
└────────────────┬───────────────────────────┬─────────────┘
                 │                           │
        ┌────────▼────────┐         ┌────────▼──────────┐
        │ Infrastructure  │         │   Domain Core     │
        │   (telemetry,   │────────▶│ (entities, events)│
        │  persistence)   │         └────────┬──────────┘
        └─────────────────┘                  │
                 │                           │
                 │                  ┌────────▼──────────┐
                 │                  │ Domain Primitives │
                 │                  │ (value-objects)   │
                 │                  └────────┬──────────┘
                 │                           │
        ┌────────▼───────────────────────────▼─────────┐
        │              Foundation Layer                 │
        │  (errors, result, math, time, logger)        │
        └──────────────────────────────────────────────┘
```

## Критерии размещения модуля

### ✅ Foundation если

- [ ] Нет зависимостей на domain
- [ ] Нет бизнес-логики
- [ ] Переиспользуемо в любом проекте
- [ ] Базовая утилита

**Примеры:** errors, result, math, time, logger

### ✅ Domain если

- [ ] Содержит бизнес-логику
- [ ] Специфично для трейдинговой системы
- [ ] Использует domain термины (Order, Price, Market)

**Примеры:** value-objects, entities, events

### ✅ Infrastructure если

- [ ] Зависит от внешних библиотек
- [ ] Адаптер к внешним системам
- [ ] Технический сервис (логирование метрик, персистентность)
- [ ] Использует domain типы

**Примеры:** telemetry, persistence, messaging

## Ответы на вопросы

### 1. Правильное ли место для time в foundation?

**✅ ДА, абсолютно правильно!**

**Причины:**

- ✅ Базовая утилита без бизнес-логики
- ✅ Используется на всех слоях
- ✅ Нет зависимостей на domain
- ✅ Аналогично errors, result, math

**Альтернативы:** НЕТ лучших вариантов

### 2. Куда положить logger?

**✅ `packages/foundation/logger`**

**Причины:**

- ✅ Базовая утилита
- ✅ Используется везде (foundation, domain, infrastructure)
- ✅ Нет бизнес-логики
- ✅ Зависит только от time (тоже foundation)

### 3. Куда положить telemetry?

**✅ `packages/infrastructure/telemetry` (рекомендуется)**

или

**🟡 `packages/observability/telemetry` (альтернатива)**

**Причины:**

- ✅ Зависит от domain types (Order, Trade, Market)
- ✅ Содержит бизнес-логику метрик
- ✅ Может использовать внешние библиотеки
- ✅ Это infrastructure concern

**НЕ foundation потому что:**

- ❌ Зависит от domain-специфичных типов
- ❌ Не переиспользуемо в других проектах
- ❌ Содержит бизнес-логику

## Следующие шаги

1. ✅ `@polymarket/time` остается в `foundation/` - **правильное место**

2. 🟢 Создать `@polymarket/logger` в `foundation/logger/`
   - ILogger интерфейс
   - ConsoleLogger, FileLogger, NoOpLogger
   - Зависит от @polymarket/time

3. 🟡 Создать `@polymarket/telemetry` в `infrastructure/telemetry/`
   - ITelemetryCollector интерфейс
   - MetricsCollector, TracingCollector
   - Зависит от domain types и logger

4. 📁 Создать папки infrastructure/ и application/

   ```bash
   mkdir -p packages/infrastructure/telemetry
   mkdir -p packages/application/use-cases
   ```

## Заключение

**Текущее размещение @polymarket/time правильное.**

Foundation - это именно то место где должны находиться базовые утилиты без бизнес-логики, такие как time, logger, result, math.

Telemetry же - это infrastructure concern, который зависит от domain типов, и должен находиться в infrastructure layer.
