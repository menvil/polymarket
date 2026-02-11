# @polymarket/logger

Structured logging utilities для Polymarket trading system с поддержкой детерминированных timestamps.

## ✨ Ключевые особенности

- ✅ **Structured logging** - поддержка структурированных логов с контекстом
  - **ConsoleLogger**: JSON формат (машиночитаемый, для production/CI)
  - **ColorConsoleLogger**: Human-readable формат с цветами (для разработки/backtests)
- ✅ **Детерминированные timestamps** - через IClock dependency injection
- ✅ **Type-safe** - контекст типизирован как Record<string, unknown>
- ✅ **6 уровней логирования** - TRACE, DEBUG, INFO, WARN, ERROR, FATAL
- ✅ **Child loggers** - поддержка контекстных логгеров с bindings
- ✅ **Fail-safe** - никогда не бросает исключения, даже при circular references
- ✅ **Protected fields** - системные поля (timestamp, level, message) защищены от переопределения
- ✅ **Минимальный overhead в тестах** - NoOpLogger не выполняет IO операций
- ✅ **Высокое покрытие тестами** - 97%+ coverage, 174 теста

## 📦 Установка

```bash
npm install @polymarket/logger
```

## 🎯 Архитектура

```text
foundation/logger (этот модуль)
  - ILogger интерфейс
  - ConsoleLogger (JSON)
  - ColorConsoleLogger (цветной)
  - NoOpLogger (для тестов)
    ↓ используется в
infrastructure/adapters
  - PinoLoggerAdapter (production)
    ↓ используется в
domain/services (бизнес-логика)
```

## 🚀 Быстрый старт

### Бэктесты (ColorConsoleLogger + PaperClock)

```typescript
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { PaperClock } from '@polymarket/time';

const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
const logger = new ColorConsoleLogger(clock, LogLevel.DEBUG);

logger.info('Backtest started');
// [2024-01-01T00:00:00.000Z] [INFO] Backtest started

clock.tick(60000); // +1 минута симуляции
logger.info('First trade executed', { price: 0.55, quantity: 100 });
// [2024-01-01T00:01:00.000Z] [INFO] First trade executed { price: 0.55, quantity: 100 }

logger.warn('Position limit approaching', { current: 450, limit: 500 });
// [2024-01-01T00:01:00.000Z] [WARN] Position limit approaching { current: 450, limit: 500 }
```

### Production (ConsoleLogger JSON + LiveClock)

```typescript
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';

const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);

logger.info('Server started', { port: 3000, env: 'production' });
// {"timestamp":"2024-01-15T10:30:45.123Z","level":"INFO","message":"Server started","port":3000,"env":"production"}

logger.warn('High latency detected', { latency: 2500, threshold: 1000 });
// {"timestamp":"2024-01-15T10:30:46.456Z","level":"WARN","message":"High latency detected","latency":2500,"threshold":1000}

try {
  await connectDatabase();
} catch (error) {
  logger.error('Database connection failed', error as Error, {
    host: 'localhost',
    port: 5432,
  });
}
// {"timestamp":"2024-01-15T10:30:47.789Z","level":"ERROR","message":"Database connection failed","host":"localhost","port":5432,"error":{"message":"Connection refused","name":"Error","stack":"..."}}
```

### No Logging (для unit-тестов)

```typescript
import { NoOpLogger } from '@polymarket/logger';

describe('OrderService', () => {
  it('should place order', () => {
    const logger = new NoOpLogger(); // Никакого вывода в консоль
    const service = new OrderService(logger);

    logger.info('This will not be logged');
    logger.error('This will not be logged either');

    expect(service.placeOrder({ price: 0.65 })).toBeDefined();
  });
});
```

## 📖 API Reference

### ILogger

Интерфейс логгера совместимый с Pino и другими популярными библиотеками.

```typescript
interface ILogger {
  trace(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
  fatal(message: string, error?: Error, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): ILogger;
}
```

### LogLevel

Уровни важности сообщений (от детального к критичному).

```typescript
enum LogLevel {
  TRACE = 'TRACE', // Трассировка выполнения (вход/выход функций)
  DEBUG = 'DEBUG', // Детальная отладка
  INFO = 'INFO',   // Информация (по умолчанию в production)
  WARN = 'WARN',   // Предупреждения
  ERROR = 'ERROR', // Ошибки
  FATAL = 'FATAL', // Критические ошибки (приводят к остановке)
}
```

**Фильтрация:**

Логируются только сообщения с уровнем >= настроенного:

- `LogLevel.TRACE` - логирует всё (TRACE, DEBUG, INFO, WARN, ERROR, FATAL)
- `LogLevel.DEBUG` - логирует DEBUG, INFO, WARN, ERROR, FATAL
- `LogLevel.INFO` - логирует INFO, WARN, ERROR, FATAL (production default)
- `LogLevel.WARN` - логирует WARN, ERROR, FATAL
- `LogLevel.ERROR` - логирует ERROR, FATAL
- `LogLevel.FATAL` - логирует только FATAL

### ConsoleLogger (JSON structured)

Логирование в консоль в JSON формате для машиночитаемого парсинга.

```typescript
class ConsoleLogger implements ILogger {
  constructor(
    clock: IClock,
    level: LogLevel = LogLevel.INFO,
    bindings?: Record<string, unknown>
  );

  trace(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
  fatal(message: string, error?: Error, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): ILogger;
}
```

**Использование:**

```typescript
// CI/CD тесты - JSON для парсинга
const logger = new ConsoleLogger(new PaperClock(new Date()), LogLevel.INFO);
logger.info('Test started', { testId: 'test-123' });
// {"timestamp":"2024-01-01T00:00:00.000Z","level":"INFO","message":"Test started","testId":"test-123"}
```

### ColorConsoleLogger (human-readable)

Цветной human-readable вывод для локальной разработки и бэктестов.

```typescript
class ColorConsoleLogger implements ILogger {
  constructor(
    clock: IClock,
    level: LogLevel = LogLevel.INFO,
    bindings?: Record<string, unknown>,
    options?: ColorConsoleLoggerOptions
  );

  // ... те же методы что и ConsoleLogger
}

interface ColorConsoleLoggerOptions {
  useColors?: boolean;      // по умолчанию true
  showTimestamp?: boolean;  // по умолчанию true
  showMetadata?: boolean;   // по умолчанию true
}
```

**Использование:**

```typescript
// Бэктесты - цветной для удобства чтения
const logger = new ColorConsoleLogger(paperClock, LogLevel.DEBUG);
logger.info('Order placed', { orderId: 'order-123', price: 0.65 });
// [2024-01-01T00:00:00.000Z] [INFO] Order placed { orderId: 'order-123', price: 0.65 }

// Без цветов (для CI/CD если нужен human-readable формат)
const noColorLogger = new ColorConsoleLogger(
  clock,
  LogLevel.INFO,
  {},
  { useColors: false }
);
```

### NoOpLogger

Пустая реализация для unit-тестов без вывода.

```typescript
class NoOpLogger implements ILogger {
  constructor();
  // Все методы ничего не делают (zero overhead)
}
```

## 💡 Примеры использования

### Child loggers с контекстом

```typescript
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { PaperClock } from '@polymarket/time';

const clock = new PaperClock(new Date('2024-01-01'));
const logger = new ColorConsoleLogger(clock, LogLevel.INFO);

// Создаём дочерние логгеры с контекстом
const mmLogger = logger.child({ service: 'MarketMaker', marketId: '0xabc' });
const riskLogger = logger.child({ service: 'RiskManager' });

mmLogger.info('Quote sent', { bid: 0.54, ask: 0.56 });
// [INFO] [service=MarketMaker marketId=0xabc] Quote sent { bid: 0.54, ask: 0.56 }

riskLogger.warn('Position limit approaching', { position: 450 });
// [WARN] [service=RiskManager] Position limit approaching { position: 450 }

// Вложенные child loggers
const orderLogger = mmLogger.child({ orderId: 'order-123' });
orderLogger.debug('Validating order');
// [DEBUG] [service=MarketMaker marketId=0xabc orderId=order-123] Validating order
```

### Все 6 уровней логирования

```typescript
const logger = new ColorConsoleLogger(clock, LogLevel.TRACE);

// TRACE - трассировка выполнения
logger.trace('Entering handleOrderbookUpdate', {
  marketId: '0xabc',
  bidsCount: 10
});

// DEBUG - детальная отладка
logger.debug('Processing orderbook', {
  market: '0xabc',
  bids: 10,
  asks: 12
});

// INFO - информация о нормальной работе
logger.info('Order placed successfully', {
  orderId: 'order-123',
  price: 0.65,
  quantity: 100
});

// WARN - предупреждения
logger.warn('Position limit approaching', {
  currentPosition: 450,
  limit: 500
});

// ERROR - ошибки
logger.error('Failed to cancel order', new Error('Timeout'), {
  orderId: 'order-456'
});

// FATAL - критические ошибки (приводят к остановке)
logger.fatal('Cannot connect to exchange', new Error('Connection refused'), {
  exchange: 'Polymarket',
  retryAttempts: 5
});
process.exit(1); // После FATAL обычно завершаем процесс
```

### Dependency Injection в сервисах

```typescript
import type { ILogger } from '@polymarket/logger';

class OrderService {
  constructor(private readonly logger: ILogger) {}

  placeOrder(orderId: string, price: number, quantity: number): void {
    this.logger.info('Placing order', { orderId, price, quantity });

    try {
      // Place order logic
      this.logger.info('Order placed successfully', { orderId });
    } catch (error) {
      this.logger.error('Failed to place order', error as Error, {
        orderId,
        price,
        quantity,
      });
      throw error;
    }
  }
}

// Бэктест - ColorConsoleLogger с детерминированным временем
const backtestLogger = new ColorConsoleLogger(
  new PaperClock(new Date('2024-01-01')),
  LogLevel.DEBUG
);
const backtestService = new OrderService(backtestLogger);

// Production - PinoLoggerAdapter (см. infrastructure/adapters)
const prodLogger = new PinoLoggerAdapter(pino(), new LiveClock());
const prodService = new OrderService(prodLogger);

// Unit-тесты - NoOpLogger
const testLogger = new NoOpLogger();
const testService = new OrderService(testLogger);
```

### Разные режимы Clock

```typescript
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock, PaperClock, ReplayClock } from '@polymarket/time';

// LIVE режим - реальное время (production)
const liveLogger = new ColorConsoleLogger(new LiveClock(), LogLevel.INFO);
liveLogger.info('Order placed');
// [2024-01-15T10:30:45.123Z] [INFO] Order placed

// PAPER режим - управляемое время (бэктесты)
const paperClock = new PaperClock(new Date('2024-01-01'));
const paperLogger = new ColorConsoleLogger(paperClock, LogLevel.DEBUG);
paperLogger.info('Backtest event 1');
// [2024-01-01T00:00:00.000Z] [INFO] Backtest event 1

paperClock.tick(5000); // +5 секунд симуляции
paperLogger.info('Backtest event 2');
// [2024-01-01T00:00:05.000Z] [INFO] Backtest event 2

// REPLAY режим - время из событий (replay исторических данных)
const replayClock = new ReplayClock(new Date(0));
const replayLogger = new ColorConsoleLogger(replayClock, LogLevel.INFO);

historicalEvents.forEach((event) => {
  replayClock.update(event.timestamp); // Обновить время из события
  replayLogger.info('Event processed', { eventId: event.id });
  // Timestamp будет event.timestamp - детерминированно!
});
```

### Error Logging с полным stack trace

```typescript
const logger = new ColorConsoleLogger(clock, LogLevel.ERROR);

try {
  await fetchMarketData();
} catch (error) {
  logger.error('Failed to fetch market data', error as Error, {
    marketId: 'market-123',
    retryAttempt: 3,
    maxRetries: 5,
  });
}

// Output включает error.message и stack trace:
// [ERROR] Failed to fetch market data { error: "Network timeout", stack: "Error: Network timeout...", marketId: "market-123", ... }
```

## 🏗️ Production: PinoLoggerAdapter

Для production используйте Pino через adapter в infrastructure layer:

```typescript
// infrastructure/adapters/PinoLoggerAdapter.ts
import pino from 'pino';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import { LiveClock } from '@polymarket/time';

export class PinoLoggerAdapter implements ILogger {
  constructor(
    private readonly pino: pino.Logger,
    private readonly clock: IClock
  ) {}

  trace(message: string, context?: Record<string, unknown>): void {
    this.pino.trace({ ...context, time: this.clock.now().getTime() }, message);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.pino.debug({ ...context, time: this.clock.now().getTime() }, message);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.pino.info({ ...context, time: this.clock.now().getTime() }, message);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.pino.warn({ ...context, time: this.clock.now().getTime() }, message);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    const pinoContext = {
      ...context,
      ...(error && { err: error }), // Pino автоматически сериализует err
      time: this.clock.now().getTime(),
    };
    this.pino.error(pinoContext, message);
  }

  fatal(message: string, error?: Error, context?: Record<string, unknown>): void {
    const pinoContext = {
      ...context,
      ...(error && { err: error }),
      time: this.clock.now().getTime(),
    };
    this.pino.fatal(pinoContext, message);
  }

  child(bindings: Record<string, unknown>): ILogger {
    return new PinoLoggerAdapter(this.pino.child(bindings), this.clock);
  }
}

// Использование в production
const logger = new PinoLoggerAdapter(
  pino({
    level: 'info',
    transport: {
      targets: [
        // Dev: цветной вывод в консоль
        {
          target: 'pino-pretty',
          level: 'debug',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
        // Production: структурированный JSON в Datadog
        {
          target: 'pino-datadog',
          level: 'info',
          options: {
            apiKey: process.env.DD_API_KEY,
            ddsource: 'nodejs',
            service: 'polymarket-trading',
          },
        },
      ],
    },
  }),
  new LiveClock()
);

logger.info('Trading bot started', { version: '1.0.0' });
```

## 🧪 Тестирование

```bash
npm test              # Запуск тестов
npm run test:coverage # Покрытие тестами (96.58%)
npm run test:watch    # Watch режим
```

## 📊 Best Practices

### ✅ Правильно

```typescript
// 1. Используйте ILogger через dependency injection
class Service {
  constructor(private readonly logger: ILogger) {}
}

// 2. Используйте structured context
logger.info('Order placed', { orderId: '123', price: 0.65 });

// 3. Логируйте ошибки с Error объектом
logger.error('Operation failed', error, { context: 'value' });

// 4. Используйте NoOpLogger в unit-тестах
const logger = new NoOpLogger(); // Без засорения консоли

// 5. Используйте PaperClock для детерминированных бэктестов
const clock = new PaperClock(new Date('2024-01-01'));
const logger = new ColorConsoleLogger(clock, LogLevel.DEBUG);

// 6. Используйте child() для контекста
const orderLogger = logger.child({ orderId: 'order-123' });
orderLogger.info('Processing'); // автоматически включает orderId

// 7. ColorConsoleLogger для бэктестов (читаемость)
const backtestLogger = new ColorConsoleLogger(paperClock, LogLevel.DEBUG);

// 8. ConsoleLogger JSON для CI/CD (парсинг)
const ciLogger = new ConsoleLogger(paperClock, LogLevel.INFO);

// 9. PinoLoggerAdapter для production
const prodLogger = new PinoLoggerAdapter(pino(), new LiveClock());
```

### ❌ Неправильно

```typescript
// 1. НЕ создавайте logger напрямую в классе
class Service {
  private logger = new ConsoleLogger(new LiveClock()); // ❌
}

// 2. НЕ логируйте без контекста когда он доступен
logger.info('Order placed'); // ❌ Нет orderId!

// 3. НЕ теряйте Error объект
logger.error('Operation failed', undefined, { message: err.message }); // ❌

// 4. НЕ используйте LiveClock в бэктестах
const logger = new ConsoleLogger(new LiveClock()); // ❌ Недетерминировано

// 5. НЕ повторяйте контекст - используйте child()
logger.info('Step 1', { orderId: '123' });
logger.info('Step 2', { orderId: '123' }); // ❌ Повтор
logger.info('Step 3', { orderId: '123' }); // ❌ Повтор
// Вместо этого:
const orderLogger = logger.child({ orderId: '123' });
orderLogger.info('Step 1'); // ✅
orderLogger.info('Step 2'); // ✅
```

## 🤝 Связанные пакеты

- `@polymarket/time` - IClock абстракции для детерминированного времени
- `@polymarket/errors` - Типы ошибок для логирования
- `pino` - Production logger (используется через adapter в infrastructure)

## 📄 License

MIT
