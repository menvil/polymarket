/**
 * Интерфейс источника времени для трейдинговой системы
 *
 * @remarks
 * Определяет контракт для получения текущего времени в системе.
 * Время предоставляется как dependency injection, что обеспечивает детерминизм
 * и возможность тестирования.
 *
 * ## Архитектурный принцип
 *
 * Компоненты системы не должны создавать время самостоятельно.
 * Вместо этого они получают clock через конструктор и используют его для получения времени.
 * Это обеспечивает:
 * - Детерминированное воспроизведение событий (replay)
 * - Предсказуемое тестирование с контролируемым временем
 * - Единый источник времени для всей системы
 *
 * ## Реализации
 *
 * - **LiveClock**: использует реальное системное время (Date.now())
 *   - Для production окружения
 *   - Для LIVE режима торговли
 *
 * - **ReplayClock**: использует фиксированное время из событий
 *   - Для воспроизведения исторических данных
 *   - Для REPLAY режима анализа
 *   - Гарантирует идентичные timestamps при повторном воспроизведении
 *
 * - **PaperClock**: использует управляемое время
 *   - Для тестирования с контролируемым временем
 *   - Для PAPER режима симуляции
 *   - Позволяет вручную продвигать время
 *
 * @example
 * Правильное использование через dependency injection:
 * ```typescript
 * class StrategyContextImpl {
 *   constructor(
 *     private readonly clock: IClock
 *   ) {}
 *
 *   now(): Date {
 *     return this.clock.now(); // Детерминированное время
 *   }
 * }
 * ```
 *
 * @example
 * Использование разных реализаций:
 * ```typescript
 * // LIVE mode - реальное время
 * const liveClock = new LiveClock();
 * const liveCtx = new StrategyContextImpl(adapter, 'LIVE', liveClock);
 * console.log(liveCtx.now()); // Текущее системное время
 *
 * // REPLAY mode - фиксированное время из событий
 * const replayClock = new ReplayClock(new Date('2024-01-01'));
 * const replayCtx = new StrategyContextImpl(adapter, 'REPLAY', replayClock);
 * console.log(replayCtx.now()); // 2024-01-01 (зафиксировано)
 *
 * replayClock.update(new Date('2024-01-02')); // Обновление из события
 * console.log(replayCtx.now()); // 2024-01-02 (зафиксировано)
 *
 * // PAPER mode - управляемое время
 * const paperClock = new PaperClock(new Date());
 * const paperCtx = new StrategyContextImpl(adapter, 'PAPER', paperClock);
 *
 * paperClock.tick(1000); // Продвинуть время на 1 секунду
 * console.log(paperCtx.now()); // Время увеличилось на 1 секунду
 * ```
 */
export interface IClock {
  /**
   * Возвращает текущее время
   *
   * @returns Текущая временная метка
   *
   * @remarks
   * Метод предоставляет текущее время в соответствии с типом реализации:
   *
   * - **LiveClock**: возвращает реальное системное время (new Date())
   * - **ReplayClock**: возвращает фиксированное время из последнего события
   * - **PaperClock**: возвращает управляемое время, которое можно изменить вручную
   *
   * Компоненты системы должны получать время только через этот метод,
   * а не создавать Date напрямую. Это обеспечивает:
   * - Детерминированное воспроизведение (один event stream → идентичные timestamps)
   * - Предсказуемое тестирование с контролируемым временем
   * - Отсутствие race conditions при работе с временем
   *
   * @example
   * ```typescript
   * // В компоненте стратегии
   * const currentTime = this.clock.now();
   * console.log('Order placed at:', currentTime);
   * ```
   */
  now(): Date;
}
