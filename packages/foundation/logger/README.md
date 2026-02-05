# @polymarket/logger

Structured logging utilities для Polymarket trading system с поддержкой детерминированных timestamps.

## ✨ Ключевые особенности

- ✅ **Structured logging** - все логи в JSON формате с контекстом
- ✅ **Детерминированные timestamps** - через IClock dependency injection
- ✅ **Type-safe** - контекст типизирован как Record<string, unknown>
- ✅ **Фильтрация по уровню** - DEBUG, INFO, WARN, ERROR
- ✅ **Zero overhead в тестах** - NoOpLogger для тихого логирования
- ✅ **Высокое покрытие тестами** - 100% coverage

## 📦 Установка

```bash
npm install @polymarket/logger
```

## 🚀 Быстрый старт

### Production (LIVE режим)

```typescript
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';

const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);

logger.info('Server started', { port: 3000, env: 'production' });
// Output: {"timestamp":"2024-01-15T10:30:45.123Z","level":"INFO","message":"Server started","port":3000,"env":"production"}

logger.warn('High latency detected', { latency: 2500, threshold: 1000 });
// Output: {"timestamp":"2024-01-15T10:30:46.456Z","level":"WARN","message":"High latency detected","latency":2500,"threshold":1000}

try {
  await connectDatabase();
} catch (error) {
  logger.error('Database connection failed', error as Error, {
    host: 'localhost',
    port: 5432,
  });
}
// Output: {"timestamp":"2024-01-15T10:30:47.789Z","level":"ERROR","message":"Database connection failed","host":"localhost","port":5432,"error":{"message":"Connection refused","name":"Error","stack":"..."}}
```

### Testing (PAPER режим)

```typescript
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { PaperClock } from '@polymarket/time';

const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
const logger = new ConsoleLogger(clock, LogLevel.DEBUG);

logger.info('Test started');
// Output: {"timestamp":"2024-01-01T00:00:00.000Z","level":"INFO","message":"Test started"}

clock.tick(1000); // Продвинуть время на 1 секунду

logger.info('Test step completed');
// Output: {"timestamp":"2024-01-01T00:00:01.000Z","level":"INFO","message":"Test step completed"}
```

### No Logging (для тестов)

```typescript
import { NoOpLogger } from '@polymarket/logger';

const logger = new NoOpLogger(); // Никакого вывода в консоль

logger.info('This will not be logged');
logger.error('This will not be logged either');
```

## 📖 API Reference

### ILogger

Интерфейс логгера.

```typescript
interface ILogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
}
```

### LogLevel

Уровни важности сообщений.

```typescript
enum LogLevel {
  DEBUG = 'DEBUG', // Детальная отладка
  INFO = 'INFO',   // Информация
  WARN = 'WARN',   // Предупреждения
  ERROR = 'ERROR', // Ошибки
}
```

### ConsoleLogger

Логирование в консоль в JSON формате.

```typescript
class ConsoleLogger implements ILogger {
  constructor(clock: IClock, level: LogLevel = LogLevel.INFO);

  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
}
```

**Параметры:**
- `clock` - Источник времени (IClock) для детерминированных timestamps
- `level` - Минимальный уровень логирования (по умолчанию INFO)

**Фильтрация:**
Логируются только сообщения с уровнем >= настроенного:
- `LogLevel.DEBUG` - логирует всё (DEBUG, INFO, WARN, ERROR)
- `LogLevel.INFO` - логирует INFO, WARN, ERROR
- `LogLevel.WARN` - логирует WARN, ERROR
- `LogLevel.ERROR` - логирует только ERROR

### NoOpLogger

Пустая реализация для тестов.

```typescript
class NoOpLogger implements ILogger {
  constructor();
  // Все методы ничего не делают
}
```

## 💡 Примеры использования

### Dependency Injection

```typescript
import type { ILogger } from '@polymarket/logger';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';

class OrderService {
  constructor(private readonly logger: ILogger) {}

  placeOrder(orderId: string, price: number, quantity: number): void {
    this.logger.info('Placing order', {
      orderId,
      price,
      quantity,
    });

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

// Production
const service = new OrderService(new ConsoleLogger(new LiveClock(), LogLevel.INFO));

// Testing
const testService = new OrderService(new NoOpLogger());
```

### Разные режимы Clock

```typescript
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock, PaperClock, ReplayClock } from '@polymarket/time';

// LIVE режим - реальное время
const liveLogger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);
liveLogger.info('Order placed');
// {"timestamp":"2024-01-15T10:30:45.123Z",...}

// PAPER режим - управляемое время
const paperClock = new PaperClock(new Date('2024-01-01'));
const paperLogger = new ConsoleLogger(paperClock, LogLevel.DEBUG);
paperLogger.info('Test message');
// {"timestamp":"2024-01-01T00:00:00.000Z",...}

paperClock.tick(5000);
paperLogger.info('Second message');
// {"timestamp":"2024-01-01T00:00:05.000Z",...}

// REPLAY режим - время из событий
const replayClock = new ReplayClock(new Date(0));
const replayLogger = new ConsoleLogger(replayClock, LogLevel.INFO);

events.forEach((event) => {
  replayClock.update(event.timestamp); // Обновить время из события
  replayLogger.info('Event processed', { eventId: event.id });
  // Timestamp будет event.timestamp - детерминированно!
});
```

### Фильтрация по уровню

```typescript
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';

// DEBUG уровень - логирует всё
const debugLogger = new ConsoleLogger(new LiveClock(), LogLevel.DEBUG);
debugLogger.debug('Debug message');   // ✅ Логируется
debugLogger.info('Info message');     // ✅ Логируется
debugLogger.warn('Warning message');  // ✅ Логируется
debugLogger.error('Error message');   // ✅ Логируется

// INFO уровень - только INFO и выше
const infoLogger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);
infoLogger.debug('Debug message');    // ❌ НЕ логируется
infoLogger.info('Info message');      // ✅ Логируется
infoLogger.warn('Warning message');   // ✅ Логируется
infoLogger.error('Error message');    // ✅ Логируется

// ERROR уровень - только ошибки
const errorLogger = new ConsoleLogger(new LiveClock(), LogLevel.ERROR);
errorLogger.debug('Debug message');   // ❌ НЕ логируется
errorLogger.info('Info message');     // ❌ НЕ логируется
errorLogger.warn('Warning message');  // ❌ НЕ логируется
errorLogger.error('Error message');   // ✅ Логируется
```

### Structured Context

```typescript
logger.info('Order processed', {
  orderId: 'order-123',
  user: {
    id: 'user-456',
    email: 'test@example.com',
  },
  items: [
    { productId: 'prod-1', quantity: 2, price: 10.5 },
    { productId: 'prod-2', quantity: 1, price: 25.0 },
  ],
  totalAmount: 46.0,
  currency: 'USD',
});

// Output (formatted):
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "level": "INFO",
  "message": "Order processed",
  "orderId": "order-123",
  "user": {
    "id": "user-456",
    "email": "test@example.com"
  },
  "items": [
    {"productId": "prod-1", "quantity": 2, "price": 10.5},
    {"productId": "prod-2", "quantity": 1, "price": 25.0}
  ],
  "totalAmount": 46.0,
  "currency": "USD"
}
```

### Error Logging

```typescript
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
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "level": "ERROR",
  "message": "Failed to fetch market data",
  "marketId": "market-123",
  "retryAttempt": 3,
  "maxRetries": 5,
  "error": {
    "message": "Network timeout",
    "name": "TimeoutError",
    "stack": "TimeoutError: Network timeout\n    at ..."
  }
}
```

## 🏗️ Архитектура

```
@polymarket/logger (foundation)
    ↓ зависит от
@polymarket/time (foundation)
```

## 🧪 Тестирование

```bash
npm test              # Запуск тестов
npm run test:coverage # Покрытие тестами
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

// 5. Используйте PaperClock для детерминированных тестов
const clock = new PaperClock(new Date('2024-01-01'));
const logger = new ConsoleLogger(clock, LogLevel.DEBUG);
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

// 4. НЕ используйте LiveClock в тестах
const logger = new ConsoleLogger(new LiveClock()); // ❌ Недетерминировано
```

## 🤝 Связанные пакеты

- `@polymarket/time` - IClock абстракции для детерминированного времени
- `@polymarket/errors` - Типы ошибок для логирования

## 📄 License

MIT
