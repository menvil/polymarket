# @polymarket/adapters

Infrastructure adapters для интеграции с внешними сервисами.

## Описание

Этот пакет содержит адаптеры для интеграции foundation-слоя с внешними библиотеками и сервисами. Адаптеры реализуют интерфейсы из foundation пакетов, используя конкретные implementation от third-party библиотек.

## Почему Infrastructure Layer?

**Foundation layer** должен быть **zero external dependencies**. Все адаптеры к внешним библиотекам (`pino`, `datadog`, `cloudwatch`, etc.) должны находиться в infrastructure layer.

```
foundation/logger     → Интерфейсы (ILogger, LogLevel)
infrastructure/adapters → Реализации (PinoLoggerAdapter)
```

## Установка

```bash
npm install @polymarket/adapters
```

## Доступные Адаптеры

### PinoLoggerAdapter

Production-ready logger на базе [Pino](https://getpino.io/).

#### Особенности

- ✅ Реализует `ILogger` из `@polymarket/logger`
- ✅ **IClock integration**: timestamps генерируются через IClock (детерминированное время для paper trading)
- ✅ **Одно поле time**: правильная настройка Pino через custom timestamp function
- ✅ **Защита от коллизий**: автоматическая фильтрация системных полей Pino (time, msg, level, pid, hostname, err) из context и child bindings
- ✅ Корректная сериализация Error через `{ err: error }`
- ✅ Child loggers с bindings
- ✅ Multiple transports (console, Datadog, CloudWatch, файлы)

#### Быстрый старт

```typescript
import { PinoLoggerAdapter } from '@polymarket/adapters';
import { LiveClock } from '@polymarket/time';

const logger = new PinoLoggerAdapter(
  { level: 'info' },
  new LiveClock()
);

logger.info('Server started', { port: 3000 });
```

#### Production (Live Trading)

```typescript
import { PinoLoggerAdapter } from '@polymarket/adapters';
import { LiveClock } from '@polymarket/time';

const logger = new PinoLoggerAdapter(
  {
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      targets: [
        {
          target: 'pino-datadog',
          level: 'info',
          options: {
            apiKey: process.env.DD_API_KEY,
            service: 'polymarket-trading',
          },
        },
      ],
    },
  },
  new LiveClock()
);
```

#### Development (Human-readable)

```typescript
const logger = new PinoLoggerAdapter(
  {
    level: 'debug',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
      },
    },
  },
  new LiveClock()
);
```

#### Paper Trading (Детерминированное время)

```typescript
import { PaperClock } from '@polymarket/time';

const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));

const logger = new PinoLoggerAdapter(
  { level: 'debug' },
  clock // Детерминированные timestamps через IClock!
);

logger.info('Backtest started');
clock.tick(60000); // +1 минута симуляции
logger.info('First event'); // Timestamp увеличился на 1 минуту
```

#### Child Loggers с защитой от коллизий

```typescript
import { PinoLoggerAdapter } from '@polymarket/adapters';
import { LiveClock } from '@polymarket/time';

const logger = new PinoLoggerAdapter({ level: 'info' }, new LiveClock());

// Создание child logger с bindings
const apiLogger = logger.child({ service: 'api', version: '1.0' });
apiLogger.info('Request received', { endpoint: '/users' });
// Output: { time: ..., level: 30, msg: "Request received", service: "api", version: "1.0", endpoint: "/users" }

// Защита от коллизий: системные поля фильтруются
const badLogger = logger.child({
  time: 999,           // Отфильтровано! time будет из IClock
  msg: 'wrong',        // Отфильтровано! msg будет из параметра message
  level: 60,           // Отфильтровано! level будет соответствовать методу (info/error/etc)
  service: 'valid'     // Сохранено! Пользовательское поле
});

badLogger.info('Safe message');
// Output: { time: 1704067200000 (из IClock), level: 30 (INFO), msg: "Safe message", service: "valid" }
// Инвариант "одно поле time" защищен!
```

## API Reference

### PinoLoggerAdapter

```typescript
class PinoLoggerAdapter implements ILogger {
  constructor(
    options: pino.LoggerOptions,
    clock: IClock,
    destination?: pino.DestinationStream
  );

  trace(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  fatal(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): ILogger;
}
```

> **Примечание**: Конструктор внутренне также поддерживает `pino.Logger` вместо `options` (используется методом `child()` для создания дочерних логгеров). Пользователям API следует использовать только публичную сигнатуру с `pino.LoggerOptions`.

### Параметры

- **options** - Опции Pino logger (level, transport, etc.)
- **clock** - Источник времени (`LiveClock`, `PaperClock`, `ReplayClock`)
- **destination** - Опциональный destination stream (для тестов или кастомного вывода)

## Зависимости

### Production

- `@polymarket/logger` - Интерфейсы логирования
- `@polymarket/time` - Интерфейс IClock
- `pino` ^8.17.0 - High-performance logger

### Development

- `pino-pretty` ^10.0.0 - Human-readable formatter

### Optional (Production)

```bash
npm install pino-datadog    # Datadog integration
npm install pino-cloudwatch # AWS CloudWatch integration
```

## Тестирование

```bash
npm test              # Запустить тесты
npm run test:coverage # С coverage
npm run test:watch    # Watch mode
```

## Разработка

```bash
npm run build        # Компиляция TypeScript
npm run typecheck    # Type checking
npm run lint         # ESLint
npm run clean        # Очистка dist/
```

## Документация

Полная документация с примерами доступна в:

- `@polymarket/logger/docs/PINO-ADAPTER-EXAMPLE.md`

## License

MIT
