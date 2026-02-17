/**
 * Реализация часов на основе системного времени
 *
 * @remarks
 * Используется в production окружении и LIVE режиме торговли.
 * Возвращает реальное системное время через Date.now().
 *
 * ## Применение
 *
 * - **LIVE режим**: стратегия работает на реальных рыночных данных
 * - **Production**: боевое окружение с реальным временем
 * - Время не мокается и не фиксируется
 *
 * ## Характеристики
 *
 * - Каждый вызов `now()` возвращает актуальное системное время
 * - Время постоянно движется вперед
 * - Не детерминировано (разные вызовы = разные значения)
 *
 * @example
 * Создание и использование LiveClock:
 * ```typescript
 * const clock = new LiveClock();
 * console.log(clock.now()); // Текущее системное время
 * ```
 *
 * @example
 * Использование в контексте стратегии:
 * ```typescript
 * const ctx = new StrategyContextImpl(
 *   executionAdapter,
 *   'LIVE',
 *   new LiveClock() // Реальное время для production
 * );
 *
 * // Каждый вызов ctx.now() вернет актуальное время
 * const orderTime = ctx.now();
 * ```
 */

import type { IClock } from './IClock.js';

export class LiveClock implements IClock {
  /**
   * Возвращает текущее системное время
   *
   * @returns Текущая временная метка на основе Date.now()
   *
   * @remarks
   * Каждый вызов создает новый объект Date с актуальным системным временем.
   * Подходит для production окружения, где требуется реальное время.
   *
   * @example
   * ```typescript
   * const clock = new LiveClock();
   * const time1 = clock.now();
   * // ... некоторое время проходит ...
   * const time2 = clock.now();
   * // time2 > time1 (время движется вперед)
   * ```
   */
  now(): Date {
    return new Date();
  }
}
