/**
 * Реализация часов с фиксированным временем для воспроизведения событий
 *
 * @remarks
 * Используется в REPLAY режиме для детерминированного воспроизведения
 * исторических торговых событий. Время берется из временных меток событий
 * и остается зафиксированным до следующего обновления.
 *
 * ## Применение
 *
 * - **REPLAY режим**: воспроизведение исторических событий с биржи
 * - **Анализ**: тестирование стратегий на исторических данных
 * - **Отладка**: детерминированное воспроизведение для поиска проблем
 *
 * ## Принцип работы
 *
 * ReplayClock хранит зафиксированную временную метку, которая обновляется
 * системой воспроизведения перед обработкой каждого события.
 * Это обеспечивает детерминизм: повторное воспроизведение одних и тех же
 * событий всегда дает идентичные временные метки.
 *
 * ## Гарантии детерминизма
 *
 * - Один event stream → идентичные timestamps при каждом воспроизведении
 * - Telemetry полностью детерминирована (bit-for-bit)
 * - Отсутствие race conditions с временем
 *
 * ## Важно
 *
 * Система воспроизведения должна вызывать `update()` перед обработкой каждого события:
 * 1. `clock.update(event.timestamp)` - обновить время
 * 2. `strategy.onExecutionEvent(event, ctx)` - обработать событие
 *
 * @example
 * Базовое использование:
 * ```typescript
 * const clock = new ReplayClock(new Date('2024-01-01T00:00:00Z'));
 * console.log(clock.now()); // 2024-01-01T00:00:00Z (зафиксировано)
 *
 * // Система воспроизведения обновляет clock из событий
 * clock.update(event1.timestamp); // 2024-01-01T00:01:00Z
 * console.log(clock.now()); // 2024-01-01T00:01:00Z (зафиксировано)
 *
 * clock.update(event2.timestamp); // 2024-01-01T00:02:00Z
 * console.log(clock.now()); // 2024-01-01T00:02:00Z (зафиксировано)
 * ```
 *
 * @example
 * Использование в системе воспроизведения:
 * ```typescript
 * // Инициализация с начальной временной меткой (обычно epoch или первое событие)
 * const clock = new ReplayClock(new Date(0));
 * const ctx = new StrategyContextImpl(adapter, 'REPLAY', clock);
 *
 * // Воспроизведение событий
 * for (const event of executionEvents) {
 *   // Обновить clock ПЕРЕД обработкой события
 *   clock.update(event.timestamp);
 *
 *   // Обработать событие (telemetry будет использовать зафиксированное время)
 *   const intents = strategy.onExecutionEvent(event, ctx);
 *   executor.execute(intents, ctx);
 * }
 *
 * // Результат: timestamps в telemetry идентичны при каждом воспроизведении
 * ```
 */

import type { IClock } from './IClock.js';

export class ReplayClock implements IClock {
  /**
   * Создает часы для воспроизведения с начальной временной меткой
   *
   * @param currentTimestamp - Начальная временная метка
   *   (обычно new Date(0) или временная метка первого события)
   *
   * @throws {Error} Если переданная дата невалидна
   *
   * @remarks
   * Система воспроизведения создает ReplayClock и обновляет его
   * через `update()` при обработке каждого события.
   *
   * @example
   * ```typescript
   * // Начать с epoch
   * const clock = new ReplayClock(new Date(0));
   *
   * // Или с временной метки первого события
   * const clock = new ReplayClock(firstEvent.timestamp);
   * ```
   */
  constructor(currentTimestamp: Date) {
    if (!this.isValidDate(currentTimestamp)) {
      throw new Error('ReplayClock: Invalid Date provided to constructor');
    }
    // Создаем копию для инкапсуляции (защита от мутации снаружи)
    this.currentTimestamp = new Date(currentTimestamp.getTime());
  }

  private currentTimestamp: Date;

  /**
   * Возвращает текущую зафиксированную временную метку
   *
   * @returns Копия зафиксированной временной метки (НЕ Date.now()!)
   *
   * @remarks
   * Всегда возвращает **копию** зафиксированного времени, которое обновляется только
   * через вызов метода `update()` системой воспроизведения.
   * Это обеспечивает детерминизм воспроизведения.
   *
   * Важно: возвращается копия, чтобы предотвратить мутацию внутреннего состояния.
   *
   * @example
   * ```typescript
   * const clock = new ReplayClock(new Date('2024-01-01'));
   * const time1 = clock.now();
   * const time2 = clock.now();
   * // time1 !== time2 (разные объекты)
   * // time1.getTime() === time2.getTime() (но одинаковые значения)
   * ```
   */
  now(): Date {
    return new Date(this.currentTimestamp);
  }

  /**
   * Обновляет зафиксированное время из события
   *
   * @param timestamp - Временная метка из события
   *
   * @throws {Error} Если переданная дата невалидна
   *
   * @remarks
   * Этот метод вызывается системой воспроизведения перед обработкой каждого события.
   * Обновление времени перед обработкой обеспечивает детерминизм.
   *
   * ## Порядок вызова
   *
   * Система воспроизведения должна следовать этому порядку:
   * 1. `clock.update(event.timestamp)` - обновить время из события
   * 2. `strategy.onExecutionEvent(event, ctx)` - обработать событие
   *
   * Это гарантирует:
   * - `ctx.now()` всегда возвращает `event.timestamp`
   * - Временные метки в telemetry детерминированы
   * - Воспроизведение полностью повторяемо (bit-for-bit)
   *
   * @example
   * ```typescript
   * // Правильный порядок в системе воспроизведения
   * for (const event of executionEvents) {
   *   clock.update(event.timestamp); // Сначала обновить время
   *   strategy.onExecutionEvent(event, ctx); // Затем обработать событие
   * }
   * ```
   */
  update(timestamp: Date): void {
    if (!this.isValidDate(timestamp)) {
      throw new Error('ReplayClock.update(): Invalid Date provided');
    }
    // Создаем копию для инкапсуляции (защита от мутации снаружи)
    this.currentTimestamp = new Date(timestamp.getTime());
  }

  /**
   * Проверяет валидность Date
   *
   * @param date - Дата для проверки
   * @returns true если дата валидна
   *
   * @remarks
   * Валидная дата:
   * - Является экземпляром Date
   * - getTime() не возвращает NaN
   */
  private isValidDate(date: Date): boolean {
    return date instanceof Date && !isNaN(date.getTime());
  }
}
