/**
 * Пустая реализация логгера (No Operation)
 *
 * @remarks
 * Используется в тестах и сценариях когда логирование не требуется.
 * Все методы ничего не делают, что делает логгер "невидимым".
 *
 * ## Применение
 *
 * - **Unit-тесты**: когда логи не нужны и засоряют вывод
 * - **Benchmarking**: когда нужно измерить производительность без overhead логирования
 * - **Null Object Pattern**: предоставить логгер без реального логирования
 *
 * ## Характеристики
 *
 * - Нулевой overhead (пустые методы)
 * - Нет dependency на IClock (не нужен)
 * - Реализует ILogger интерфейс
 *
 * @example
 * Использование в тестах:
 * ```typescript
 * import { NoOpLogger } from '@polymarket/logger';
 *
 * describe('OrderService', () => {
 *   it('should place order', () => {
 *     const logger = new NoOpLogger(); // Без логов в выводе тестов
 *     const service = new OrderService(logger);
 *
 *     const order = service.placeOrder({ price: 0.65, quantity: 100 });
 *     expect(order.id).toBeDefined();
 *   });
 * });
 * ```
 *
 * @example
 * Null Object Pattern:
 * ```typescript
 * import { NoOpLogger } from '@polymarket/logger';
 * import type { ILogger } from '@polymarket/logger';
 *
 * class Service {
 *   constructor(
 *     private readonly logger: ILogger = new NoOpLogger() // Default logger
 *   ) {}
 *
 *   doSomething(): void {
 *     this.logger.info('Doing something'); // Ничего не логируется если не передан другой logger
 *   }
 * }
 *
 * // Без логирования
 * const service1 = new Service();
 * service1.doSomething(); // Тихо
 *
 * // С логированием
 * const service2 = new Service(new ConsoleLogger(clock, LogLevel.INFO));
 * service2.doSomething(); // Логируется
 * ```
 */

import type { ILogger } from './ILogger.js';

export class NoOpLogger implements ILogger {
  /**
   * Создает no-op logger
   *
   * @remarks
   * Конструктор пустой, так как логгер не имеет состояния
   * и не зависит от внешних ресурсов.
   *
   * @example
   * ```typescript
   * const logger = new NoOpLogger();
   * logger.info('This will not be logged'); // Ничего не происходит
   * ```
   */
  constructor() {}

  /**
   * Ничего не делает
   *
   * @param _message - Игнорируется
   * @param _context - Игнорируется
   */
  trace(_message: string, _context?: Record<string, unknown>): void {
    // No operation
  }

  /**
   * Ничего не делает
   *
   * @param _message - Игнорируется
   * @param _context - Игнорируется
   */
  debug(_message: string, _context?: Record<string, unknown>): void {
    // No operation
  }

  /**
   * Ничего не делает
   *
   * @param _message - Игнорируется
   * @param _context - Игнорируется
   */
  info(_message: string, _context?: Record<string, unknown>): void {
    // No operation
  }

  /**
   * Ничего не делает
   *
   * @param _message - Игнорируется
   * @param _context - Игнорируется
   */
  warn(_message: string, _context?: Record<string, unknown>): void {
    // No operation
  }

  /**
   * Ничего не делает
   *
   * @param _message - Игнорируется
   * @param _context - Игнорируется
   */
  error(_message: string, _context?: Record<string, unknown>): void {
    // No operation
  }

  /**
   * Ничего не делает
   *
   * @param _message - Игнорируется
   * @param _context - Игнорируется
   */
  fatal(_message: string, _context?: Record<string, unknown>): void {
    // No operation
  }

  /**
   * Возвращает новый NoOpLogger (игнорирует bindings)
   *
   * @param _bindings - Игнорируется
   * @returns Новый экземпляр NoOpLogger
   *
   * @remarks
   * Child logger для NoOpLogger также ничего не делает.
   * Возвращаем новый экземпляр для соответствия интерфейсу.
   */
  child(_bindings: Record<string, unknown>): ILogger {
    return new NoOpLogger();
  }
}
