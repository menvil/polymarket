/**
 * @module @polymarket/logger
 * @description Structured logging utilities для Polymarket trading system
 *
 * @remarks
 * Модуль предоставляет абстракции для structured logging с поддержкой
 * детерминированных timestamps через dependency injection (IClock).
 *
 * ## Основные компоненты
 *
 * - **ILogger**: интерфейс логгера с методами trace/debug/info/warn/error/fatal/child
 * - **LogLevel**: enum уровней важности (TRACE/DEBUG/INFO/WARN/ERROR/FATAL)
 * - **ConsoleLogger**: JSON structured logging (для CI/CD, парсинга)
 * - **ColorConsoleLogger**: цветной human-readable вывод (для dev, бэктестов)
 * - **NoOpLogger**: пустая реализация для unit-тестов
 *
 * ## Принципы
 *
 * - **Structured logging**: все сообщения включают контекст (key-value)
 * - **Dependency injection**: время берется из IClock (детерминизм для бэктестов)
 * - **Type-safe**: контекст типизирован как Record<string, unknown>
 * - **Фильтрация**: логируются только сообщения >= настроенного уровня
 * - **Child loggers**: поддержка контекстных логгеров с bindings
 *
 * ## Уровни логирования
 *
 * TRACE < DEBUG < INFO < WARN < ERROR < FATAL
 *
 * ## Зависимости
 *
 * - **@polymarket/time**: для детерминированных timestamps через IClock
 *
 * ## Архитектура
 *
 * ```
 * foundation/logger (этот модуль)
 *   ↓ используется в
 * infrastructure/adapters/PinoLoggerAdapter (production)
 *   ↓ используется в
 * domain/services (бизнес-логика)
 * ```
 *
 * @example
 * Бэктесты (ColorConsoleLogger + PaperClock):
 * ```typescript
 * import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
 * import { PaperClock } from '@polymarket/time';
 *
 * const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
 * const logger = new ColorConsoleLogger(clock, LogLevel.DEBUG);
 *
 * logger.info('Backtest started');
 * // [2024-01-01T00:00:00.000Z] [INFO] Backtest started
 *
 * clock.tick(60000); // +1 минута симуляции
 * logger.info('First trade executed', { price: 0.55, quantity: 100 });
 * // [2024-01-01T00:01:00.000Z] [INFO] First trade executed { price: 0.55, quantity: 100 }
 * ```
 *
 * @example
 * CI/CD тесты (ConsoleLogger JSON):
 * ```typescript
 * import { ConsoleLogger, LogLevel } from '@polymarket/logger';
 * import { PaperClock } from '@polymarket/time';
 *
 * const clock = new PaperClock(new Date('2024-01-01'));
 * const logger = new ConsoleLogger(clock, LogLevel.INFO);
 *
 * logger.info('Test started', { testId: 'test-123' });
 * // {"timestamp":"2024-01-01T00:00:00.000Z","level":"INFO","message":"Test started","testId":"test-123"}
 * ```
 *
 * @example
 * Production (PinoLoggerAdapter в infrastructure):
 * ```typescript
 * // infrastructure/adapters/PinoLoggerAdapter.ts
 * import { PinoLoggerAdapter } from '@/infrastructure/adapters/PinoLoggerAdapter';
 * import { LiveClock } from '@polymarket/time';
 * import pino from 'pino';
 *
 * const logger = new PinoLoggerAdapter(
 *   pino({
 *     transport: {
 *       targets: [
 *         { target: 'pino-pretty', level: 'debug' }, // Dev console
 *         { target: 'pino-datadog', level: 'info' }  // Production Datadog
 *       ]
 *     }
 *   }),
 *   new LiveClock()
 * );
 * ```
 *
 * @example
 * Child loggers с контекстом:
 * ```typescript
 * const logger = new ColorConsoleLogger(clock, LogLevel.INFO);
 * const mmLogger = logger.child({ service: 'MarketMaker' });
 * const riskLogger = logger.child({ service: 'RiskManager' });
 *
 * mmLogger.info('Quote sent'); // [INFO] [service=MarketMaker] Quote sent
 * riskLogger.warn('Limit exceeded'); // [WARN] [service=RiskManager] Limit exceeded
 * ```
 *
 * @example
 * Unit-тесты без логирования:
 * ```typescript
 * import { NoOpLogger } from '@polymarket/logger';
 *
 * describe('OrderService', () => {
 *   it('should place order', () => {
 *     const logger = new NoOpLogger(); // Без вывода в консоль
 *     const service = new OrderService(logger);
 *     // Тест без засорения консоли логами
 *   });
 * });
 * ```
 */

export type { ILogger } from './ILogger.js';
export { LogLevel, shouldLog } from './LogLevel.js';
export { ConsoleLogger } from './ConsoleLogger.js';
export { ColorConsoleLogger } from './ColorConsoleLogger.js';
export { NoOpLogger } from './NoOpLogger.js';
