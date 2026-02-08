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
   * @throws {Error} Если переданная дата невалидна
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
  constructor(private currentTimestamp: Date) {
    if (!this.isValidDate(currentTimestamp)) {
      throw new Error('PaperClock: Invalid Date provided to constructor');
    }
  }

  /**
   * Возвращает текущее управляемое время
   *
   * @returns Копия текущей временной метки
   *
   * @remarks
   * Возвращает **копию** времени, установленного через `setTime()` или продвинутого через `tick()`.
   * Время не изменяется само по себе, только при явном вызове методов управления.
   *
   * Важно: возвращается копия, чтобы предотвратить мутацию внутреннего состояния.
   *
   * @example
   * ```typescript
   * const clock = new PaperClock(new Date('2024-01-01'));
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
   * Устанавливает абсолютное время
   *
   * @param timestamp - Новая временная метка
   *
   * @throws {Error} Если переданная дата невалидна
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
    if (!this.isValidDate(timestamp)) {
      throw new Error('PaperClock.setTime(): Invalid Date provided');
    }
    this.currentTimestamp = timestamp;
  }

  /**
   * Продвигает время на указанное количество миллисекунд
   *
   * @param ms - Количество миллисекунд для продвижения
   *
   * @throws {Error} Если ms не является конечным числом или результат невалиден
   *
   * @remarks
   * Увеличивает текущее время на заданное количество миллисекунд.
   * Полезно для тестов, симулирующих прохождение времени.
   *
   * Валидация:
   * - ms должно быть конечным числом (не NaN, не Infinity)
   * - Результирующая дата должна быть валидной
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
    if (!Number.isFinite(ms)) {
      throw new Error('PaperClock.tick(): ms must be a finite number');
    }

    const newTime = this.currentTimestamp.getTime() + ms;
    const newDate = new Date(newTime);

    if (!this.isValidDate(newDate)) {
      throw new Error('PaperClock.tick(): would result in invalid Date');
    }

    this.currentTimestamp = newDate;
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
