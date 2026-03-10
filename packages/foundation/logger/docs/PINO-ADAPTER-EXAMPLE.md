# PinoLoggerAdapter - Production Logger

Пример реализации Pino adapter для использования в production.

## 📍 Расположение

```text
infrastructure/adapters/PinoLoggerAdapter.ts
```

**Почему infrastructure, а не foundation?**

- PinoLoggerAdapter зависит от внешней библиотеки `pino` (npm package)
- Foundation layer должен быть **zero external dependencies**
- Adapters к внешним системам живут в infrastructure layer

## 📦 Установка зависимостей

```bash
npm install pino
npm install pino-pretty --save-dev  # Для цветного вывода в dev
```

Опционально для production:

```bash
npm install pino-datadog  # Для отправки в Datadog
npm install pino-cloudwatch  # Для отправки в CloudWatch
```

## 🎯 Реализация

### infrastructure/adapters/PinoLoggerAdapter.ts

```typescript
/**
 * Pino Logger Adapter - адаптер для production логирования
 *
 * @remarks
 * Адаптирует Pino logger к нашему ILogger интерфейсу.
 * Использует IClock для детерминированных timestamps (важно для paper trading).
 *
 * ## Особенности
 *
 * - Совместим с ILogger интерфейсом из @polymarket/logger
 * - Поддерживает IClock для детерминированного времени
 * - Корректная сериализация Error объектов через Pino { err: error }
 * - Поддержка child loggers с bindings
 * - Multiple transports (console, Datadog, CloudWatch, файлы)
 *
 * ## Использование
 *
 * ```typescript
 * const logger = new PinoLoggerAdapter(
 *   pino({ level: 'info' }),
 *   new LiveClock()
 * );
 *
 * logger.info('Order placed', { orderId: '123' });
 * ```
 */

import pino from 'pino';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';

export class PinoLoggerAdapter implements ILogger {
  /**
   * Создаёт Pino Logger Adapter
   *
   * @param pino - Экземпляр Pino logger
   * @param clock - Источник времени для timestamps
   *
   * @remarks
   * IClock используется для переопределения timestamp из Pino.
   * Это критично для paper trading режима где нужно детерминированное время.
   *
   * @example
   * ```typescript
   * import pino from 'pino';
   * import { LiveClock } from '@polymarket/time';
   *
   * const logger = new PinoLoggerAdapter(
   *   pino({ level: 'info' }),
   *   new LiveClock()
   * );
   * ```
   */
  constructor(
    private readonly pino: pino.Logger,
    private readonly clock: IClock
  ) {}

  /**
   * Логирует трассировочное сообщение (уровень TRACE)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @example
   * ```typescript
   * logger.trace('Entering handleOrderbookUpdate', {
   *   marketId: '0xabc',
   *   bidsCount: 10
   * });
   * ```
   */
  trace(message: string, context?: Record<string, unknown>): void {
    this.pino.trace(
      {
        ...context,
        time: this.clock.now().getTime(), // Переопределяем timestamp из IClock
      },
      message
    );
  }

  /**
   * Логирует отладочное сообщение (уровень DEBUG)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @example
   * ```typescript
   * logger.debug('Processing orderbook', {
   *   marketId: '0xabc',
   *   bids: 10,
   *   asks: 12
   * });
   * ```
   */
  debug(message: string, context?: Record<string, unknown>): void {
    this.pino.debug(
      {
        ...context,
        time: this.clock.now().getTime(),
      },
      message
    );
  }

  /**
   * Логирует информационное сообщение (уровень INFO)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @example
   * ```typescript
   * logger.info('Order placed successfully', {
   *   orderId: 'order-123',
   *   price: 0.65,
   *   quantity: 100
   * });
   * ```
   */
  info(message: string, context?: Record<string, unknown>): void {
    this.pino.info(
      {
        ...context,
        time: this.clock.now().getTime(),
      },
      message
    );
  }

  /**
   * Логирует предупреждение (уровень WARN)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @example
   * ```typescript
   * logger.warn('Position limit approaching', {
   *   currentPosition: 450,
   *   limit: 500
   * });
   * ```
   */
  warn(message: string, context?: Record<string, unknown>): void {
    this.pino.warn(
      {
        ...context,
        time: this.clock.now().getTime(),
      },
      message
    );
  }

  /**
   * Логирует ошибку (уровень ERROR)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст. Передавайте Error через `{ err: error }`
   *
   * @remarks
   * Pino нативно сериализует поле `err: Error` — автоматически включает
   * err.message, err.stack, err.type в структурированный лог.
   *
   * @example
   * ```typescript
   * try {
   *   await placeOrder(order);
   * } catch (error) {
   *   logger.error('Failed to place order', {
   *     err: error as Error,
   *     orderId: order.id,
   *   });
   * }
   * ```
   */
  error(message: string, context?: Record<string, unknown>): void {
    this.pino.error({ ...context, time: this.clock.now().getTime() }, message);
  }

  /**
   * Логирует критическую ошибку (уровень FATAL)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст. Передавайте Error через `{ err: error }`
   *
   * @remarks
   * FATAL используется для фатальных ошибок которые приводят к остановке.
   * После логирования FATAL обычно следует process.exit(1).
   *
   * @example
   * ```typescript
   * try {
   *   await connectToExchange();
   * } catch (error) {
   *   logger.fatal('Cannot connect to exchange', {
   *     err: error as Error,
   *     exchange: 'Polymarket',
   *     retryAttempts: 5,
   *   });
   *   process.exit(1);
   * }
   * ```
   */
  fatal(message: string, context?: Record<string, unknown>): void {
    this.pino.fatal({ ...context, time: this.clock.now().getTime() }, message);
  }

  /**
   * Создаёт дочерний логгер с привязанным контекстом
   *
   * @param bindings - Контекст который будет добавлен ко всем логам
   * @returns Новый логгер с добавленным контекстом
   *
   * @remarks
   * Дочерний логгер наследует конфигурацию родителя и добавляет свой контекст.
   *
   * @example
   * ```typescript
   * const logger = new PinoLoggerAdapter(pino(), new LiveClock());
   * const mmLogger = logger.child({ service: 'MarketMaker', marketId: '0xabc' });
   *
   * mmLogger.info('Quote sent', { price: 0.55 });
   * // Output включает: service="MarketMaker", marketId="0xabc", price=0.55
   * ```
   */
  child(bindings: Record<string, unknown>): ILogger {
    return new PinoLoggerAdapter(this.pino.child(bindings), this.clock);
  }
}
```

## 🚀 Использование

### Production (Live Trading)

```typescript
// src/index.ts
import pino from 'pino';
import { PinoLoggerAdapter } from './infrastructure/adapters/PinoLoggerAdapter.js';
import { LiveClock } from '@polymarket/time';

const logger = new PinoLoggerAdapter(
  pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      targets: [
        // Datadog для production
        {
          target: 'pino-datadog',
          level: 'info',
          options: {
            apiKey: process.env.DD_API_KEY,
            ddsource: 'nodejs',
            ddtags: `env:${process.env.NODE_ENV},service:polymarket-trading`,
            service: 'polymarket-trading',
          },
        },
      ],
    },
  }),
  new LiveClock()
);

logger.info('Trading bot started', {
  version: process.env.APP_VERSION,
  environment: process.env.NODE_ENV,
});

const mmLogger = logger.child({ service: 'MarketMaker' });
mmLogger.info('Market maker started', { marketId: '0xabc' });
```

### Development (Local)

```typescript
// src/index.dev.ts
import pino from 'pino';
import { PinoLoggerAdapter } from './infrastructure/adapters/PinoLoggerAdapter.js';
import { LiveClock } from '@polymarket/time';

const logger = new PinoLoggerAdapter(
  pino({
    level: 'debug',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    },
  }),
  new LiveClock()
);

logger.debug('Development mode', { config: 'dev.json' });
```

### Paper Trading (Детерминированное время)

```typescript
// src/index.paper.ts
import pino from 'pino';
import { PinoLoggerAdapter } from './infrastructure/adapters/PinoLoggerAdapter.js';
import { PaperClock } from '@polymarket/time';

const paperClock = new PaperClock(new Date('2024-01-01T00:00:00Z'));

const logger = new PinoLoggerAdapter(
  pino({
    level: 'debug',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss.l',
      },
    },
  }),
  paperClock // ✅ Детерминированное время!
);

logger.info('Paper trading started');
// Timestamp будет из PaperClock, не из Pino

paperClock.tick(60000); // +1 минута симуляции
logger.info('First event');
// Timestamp увеличился ровно на 1 минуту
```

### Multiple Transports (Console + Datadog + CloudWatch)

```typescript
import pino from 'pino';
import { PinoLoggerAdapter } from './infrastructure/adapters/PinoLoggerAdapter.js';
import { LiveClock } from '@polymarket/time';

const logger = new PinoLoggerAdapter(
  pino({
    level: 'trace',
    transport: {
      targets: [
        // Console для dev
        {
          target: 'pino-pretty',
          level: 'debug',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
          },
        },
        // Datadog для мониторинга
        {
          target: 'pino-datadog',
          level: 'info',
          options: {
            apiKey: process.env.DD_API_KEY,
            service: 'trading-bot',
          },
        },
        // CloudWatch для AWS
        {
          target: 'pino-cloudwatch',
          level: 'warn',
          options: {
            logGroupName: '/aws/trading-bot',
            logStreamName: process.env.INSTANCE_ID,
          },
        },
        // Файлы для аудита
        {
          target: 'pino/file',
          level: 'info',
          options: {
            destination: './logs/app.log',
            mkdir: true,
          },
        },
      ],
    },
  }),
  new LiveClock()
);
```

## 🧪 Тестирование PinoLoggerAdapter

```typescript
// infrastructure/adapters/__tests__/PinoLoggerAdapter.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import pino from 'pino';
import { PinoLoggerAdapter } from '../PinoLoggerAdapter.js';
import { PaperClock } from '@polymarket/time';

describe('PinoLoggerAdapter', () => {
  let pinoLogger: pino.Logger;
  let clock: PaperClock;
  let logger: PinoLoggerAdapter;
  let logs: any[];

  beforeEach(() => {
    logs = [];
    clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));

    // Mock Pino для захвата логов
    pinoLogger = pino({
      level: 'trace',
      // Захватываем логи в массив для тестирования
      transport: {
        target: 'pino/file',
        options: {
          destination: 1, // stdout
        },
      },
    });

    // Мокаем все методы Pino
    jest.spyOn(pinoLogger, 'trace');
    jest.spyOn(pinoLogger, 'debug');
    jest.spyOn(pinoLogger, 'info');
    jest.spyOn(pinoLogger, 'warn');
    jest.spyOn(pinoLogger, 'error');
    jest.spyOn(pinoLogger, 'fatal');

    logger = new PinoLoggerAdapter(pinoLogger, clock);
  });

  it('должен логировать с timestamp из IClock', () => {
    logger.info('Test message', { key: 'value' });

    expect(pinoLogger.info).toHaveBeenCalledWith(
      {
        key: 'value',
        time: clock.now().getTime(),
      },
      'Test message'
    );
  });

  it('должен обновлять timestamp при tick', () => {
    logger.info('First');
    const firstTime = clock.now().getTime();

    clock.tick(5000);
    logger.info('Second');
    const secondTime = clock.now().getTime();

    expect(secondTime).toBe(firstTime + 5000);
  });

  it('должен корректно обрабатывать Error через поле err', () => {
    const error = new Error('Test error');
    logger.error('Failed', { err: error, orderId: '123' });

    expect(pinoLogger.error).toHaveBeenCalledWith(
      {
        err: error, // Pino нативно сериализует поле err
        orderId: '123',
        time: clock.now().getTime(),
      },
      'Failed'
    );
  });

  it('должен создавать child logger', () => {
    jest.spyOn(pinoLogger, 'child');

    const childLogger = logger.child({ service: 'MarketMaker' });

    expect(pinoLogger.child).toHaveBeenCalledWith({ service: 'MarketMaker' });
    expect(childLogger).toBeInstanceOf(PinoLoggerAdapter);
  });

  it('должен поддерживать все 6 уровней', () => {
    logger.trace('trace');
    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');
    logger.fatal('fatal');

    expect(pinoLogger.trace).toHaveBeenCalled();
    expect(pinoLogger.debug).toHaveBeenCalled();
    expect(pinoLogger.info).toHaveBeenCalled();
    expect(pinoLogger.warn).toHaveBeenCalled();
    expect(pinoLogger.error).toHaveBeenCalled();
    expect(pinoLogger.fatal).toHaveBeenCalled();
  });
});
```

## 📊 Best Practices

### ✅ Правильно

```typescript
// 1. Используйте LiveClock для production
const logger = new PinoLoggerAdapter(pino(), new LiveClock());

// 2. Используйте PaperClock для paper trading (детерминированность!)
const logger = new PinoLoggerAdapter(pino(), new PaperClock(startDate));

// 3. Используйте child() для добавления контекста
const serviceLogger = logger.child({ service: 'MarketMaker' });
serviceLogger.info('Started'); // Автоматически включает service

// 4. Логируйте Error объекты через поле err в context
logger.error('Failed to place order', { err: error, orderId: '123' });

// 5. Используйте environment variables для конфигурации
const logger = new PinoLoggerAdapter(
  pino({
    level: process.env.LOG_LEVEL || 'info',
  }),
  new LiveClock()
);
```

### ❌ Неправильно

```typescript
// 1. НЕ передавайте только message ошибки — теряете stack trace
logger.error('Failed', { error: err.message }); // ❌ нет stack trace
// Вместо этого:
logger.error('Failed', { err }); // ✅ Pino сериализует message + stack + type

// 2. НЕ забывайте про IClock в paper trading
const logger = new PinoLoggerAdapter(pino(), new LiveClock()); // ❌ в paper mode
// Вместо этого:
const logger = new PinoLoggerAdapter(pino(), paperClock); // ✅

// 3. НЕ создавайте новый logger для каждого лога
function placeOrder() {
  const logger = new PinoLoggerAdapter(pino(), new LiveClock()); // ❌
  logger.info('Placing order');
}
```

## 🔗 Связанные ресурсы

- [Pino Documentation](https://getpino.io/)
- [Pino Pretty](https://github.com/pinojs/pino-pretty)
- [Pino Transports](https://getpino.io/#/docs/transports)
- [@polymarket/logger README](../README.md)
