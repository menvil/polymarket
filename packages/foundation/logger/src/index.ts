/**
 * @module @polymarket/logger
 * @description Structured logging utilities для Polymarket trading system
 *
 * @remarks
 * Модуль предоставляет абстракции для structured logging с поддержкой
 * детерминированных timestamps через dependency injection.
 *
 * ## Основные компоненты
 *
 * - **ILogger**: интерфейс логгера с методами debug/info/warn/error
 * - **LogLevel**: enum уровней важности (DEBUG/INFO/WARN/ERROR)
 * - **ConsoleLogger**: реализация для вывода в console (JSON формат)
 * - **NoOpLogger**: пустая реализация для тестов
 *
 * ## Принципы
 *
 * - **Structured logging**: все сообщения включают контекст (key-value)
 * - **Dependency injection**: время берется из IClock (детерминизм)
 * - **Type-safe**: контекст типизирован как Record<string, unknown>
 * - **Фильтрация**: логируются только сообщения >= настроенного уровня
 *
 * ## Зависимости
 *
 * - **@polymarket/time**: для детерминированных timestamps через IClock
 *
 * @example
 * Production использование (LIVE режим):
 * ```typescript
 * import { ConsoleLogger, LogLevel } from '@polymarket/logger';
 * import { LiveClock } from '@polymarket/time';
 *
 * const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);
 *
 * logger.info('Server started', { port: 3000, env: 'production' });
 * logger.warn('High latency', { latency: 2500, threshold: 1000 });
 * logger.error('Database error', dbError, { operation: 'insert' });
 * ```
 *
 * @example
 * Тестирование (PAPER режим):
 * ```typescript
 * import { ConsoleLogger, LogLevel } from '@polymarket/logger';
 * import { PaperClock } from '@polymarket/time';
 *
 * const clock = new PaperClock(new Date('2024-01-01'));
 * const logger = new ConsoleLogger(clock, LogLevel.DEBUG);
 *
 * logger.info('Test started');
 * // Output: {"timestamp":"2024-01-01T00:00:00.000Z","level":"INFO","message":"Test started"}
 *
 * clock.tick(1000); // Продвинуть время
 * logger.info('Test step completed');
 * // Output: {"timestamp":"2024-01-01T00:00:01.000Z","level":"INFO","message":"Test step completed"}
 * ```
 *
 * @example
 * Replay режим (детерминированные timestamps):
 * ```typescript
 * import { ConsoleLogger, LogLevel } from '@polymarket/logger';
 * import { ReplayClock } from '@polymarket/time';
 *
 * const clock = new ReplayClock(new Date(0));
 * const logger = new ConsoleLogger(clock, LogLevel.INFO);
 *
 * events.forEach((event) => {
 *   clock.update(event.timestamp);  // Обновить время из события
 *   logger.info('Event processed', { eventId: event.id });
 *   // Timestamp будет event.timestamp - детерминированно!
 * });
 * ```
 *
 * @example
 * Unit-тесты без логирования:
 * ```typescript
 * import { NoOpLogger } from '@polymarket/logger';
 *
 * describe('Service', () => {
 *   it('should work', () => {
 *     const logger = new NoOpLogger(); // Без вывода в консоль
 *     const service = new Service(logger);
 *     // Тест без засорения консоли логами
 *   });
 * });
 * ```
 */

export type { ILogger } from './ILogger.js';
export { LogLevel, shouldLog } from './LogLevel.js';
export { ConsoleLogger } from './ConsoleLogger.js';
export { NoOpLogger } from './NoOpLogger.js';
