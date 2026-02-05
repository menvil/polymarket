/**
 * Реализация часов с ручным управлением временем
 *
 * @remarks
 * Используется для тестирования и PAPER режима симуляции.
 * Позволяет полностью контролировать время: устанавливать абсолютные значения
 * или продвигать время на заданное количество миллисекунд.
 *
 * ## Применение
 *
 * - **PAPER режим**: стратегия работает с симулированными данными
 * - **Unit-тесты**: тесты с контролируемым временем
 * - **Integration-тесты**: тесты с симуляцией течения времени
 *
 * ## Методы управления
 *
 * - `setTime(timestamp)`: установить конкретное время
 * - `tick(ms)`: продвинуть время на указанное количество миллисекунд
 *
 * ## Характеристики
 *
 * - Время не движется само по себе
 * - Полный контроль над временными метками
 * - Детерминировано (одинаковые операции = одинаковый результат)
 *
 * @example
 * Базовое использование:
 * ```typescript
 * const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
 * console.log(clock.now()); // 2024-01-01T00:00:00Z
 *
 * // Продвинуть время на 1 секунду
 * clock.tick(1000);
 * console.log(clock.now()); // 2024-01-01T00:00:01Z
 *
 * // Установить абсолютное время
 * clock.setTime(new Date('2024-02-01T00:00:00Z'));
 * console.log(clock.now()); // 2024-02-01T00:00:00Z
 * ```
 *
 * @example
 * Использование в unit-тестах:
 * ```typescript
 * const clock = new PaperClock(new Date('2024-01-01'));
 * const ctx = new StrategyContextImpl(mockAdapter, 'PAPER', clock);
 *
 * // Тестирование с контролируемым временем
 * const intents = strategy.onStart(ctx);
 *
 * // Симуляция прохождения времени
 * clock.tick(60000); // 1 минута
 *
 * // Проверка временных меток в telemetry
 * expect(telemetry[0].timestamp).toEqual(new Date('2024-01-01T00:01:00Z'));
 * ```
 *
 * @example
 * Использование в PAPER режиме:
 * ```typescript
 * const clock = new PaperClock(new Date());
 * const ctx = new StrategyContextImpl(adapter, 'PAPER', clock);
 *
 * const runner = new StrategyRunner(strategy, ctx, executor, eventBus, 1000, logger);
 * runner.start();
 *
 * // Продвинуть время для активации логики, зависящей от времени
 * clock.tick(5000); // 5 секунд
 * ```
 */

import type { IClock } from './IClock.js';

export class PaperClock implements IClock {
  /**
   * Создает часы с управляемым временем
   *
   * @param currentTimestamp - Начальная временная метка
   *
   * @remarks
   * Устанавливает начальное время, которое затем можно изменить
   * через методы `setTime()` или `tick()`.
   *
   * @example
   * ```typescript
   * const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
   * ```
   */
  constructor(private currentTimestamp: Date) {}

  /**
   * Возвращает текущее управляемое время
   *
   * @returns Текущая временная метка
   *
   * @remarks
   * Возвращает время, установленное через `setTime()` или продвинутое через `tick()`.
   * Время не изменяется само по себе, только при явном вызове методов управления.
   *
   * @example
   * ```typescript
   * const clock = new PaperClock(new Date('2024-01-01'));
   * const time1 = clock.now();
   * const time2 = clock.now();
   * // time1 === time2 (время не движется само)
   * ```
   */
  now(): Date {
    return this.currentTimestamp;
  }

  /**
   * Устанавливает абсолютное время
   *
   * @param timestamp - Новая временная метка
   *
   * @remarks
   * Заменяет текущее время на указанное.
   * Полезно для тестов, требующих конкретных временных меток.
   *
   * @example
   * ```typescript
   * const clock = new PaperClock(new Date('2024-01-01'));
   * clock.setTime(new Date('2024-01-01T12:00:00Z'));
   * console.log(clock.now()); // 2024-01-01T12:00:00Z
   * ```
   */
  setTime(timestamp: Date): void {
    this.currentTimestamp = timestamp;
  }

  /**
   * Продвигает время на указанное количество миллисекунд
   *
   * @param ms - Количество миллисекунд для продвижения
   *
   * @remarks
   * Увеличивает текущее время на заданное количество миллисекунд.
   * Полезно для тестов, симулирующих прохождение времени.
   *
   * @example
   * ```typescript
   * const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
   * const start = clock.now();
   *
   * clock.tick(1000); // Продвинуть на 1 секунду
   *
   * const end = clock.now();
   * expect(end.getTime() - start.getTime()).toBe(1000);
   * ```
   */
  tick(ms: number): void {
    this.currentTimestamp = new Date(this.currentTimestamp.getTime() + ms);
  }
}
