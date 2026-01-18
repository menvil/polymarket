/**
 * MarketModeChangedEvent - событие изменения режима торговли
 *
 * @remarks
 * Событие возникает при переключении режима торговли.
 *
 * Режимы торговли (TradingMode):
 * - FLAT: Нет позиции, пассивное котирование
 * - QUOTE: Обычный маркет-мейкинг
 * - SKEW: Управление inventory (асимметричные спреды)
 * - UNWIND: Принудительное закрытие позиции
 * - PANIC: Панический выход по любой цене
 * - PAUSED: Торговля остановлена
 *
 * Зачем нужно:
 * - Изменение стратегии котирования
 * - Логирование изменений режима
 * - Анализ поведения системы
 * - Отладка и мониторинг
 *
 * @example
 * ```typescript
 * const event = new MarketModeChangedEvent(
 *   'QUOTE',
 *   'SKEW',
 *   'Net position exceeded 60% of limit',
 *   new Date()
 * );
 * ```
 */
import { DomainEvent } from './DomainEvent.js';

/**
 * Trading modes
 */
export type TradingMode = 'FLAT' | 'QUOTE' | 'SKEW' | 'UNWIND' | 'PANIC' | 'PAUSED';

/**
 * MarketModeChangedEvent
 *
 * @remarks
 * Иммутабельное событие, фиксирующее изменение торгового режима.
 */
export class MarketModeChangedEvent extends DomainEvent {
  /**
   * Creates MarketModeChangedEvent
   *
   * @param fromMode - Previous trading mode
   * @param toMode - New trading mode
   * @param reason - Reason for mode change
   * @param timestamp - When mode changed (default: now)
   *
   * @example
   * ```typescript
   * // Normal → Inventory management
   * const event1 = new MarketModeChangedEvent(
   *   'QUOTE',
   *   'SKEW',
   *   'Net position: 750/1000 (75%)'
   * );
   *
   * // Inventory → Unwind
   * const event2 = new MarketModeChangedEvent(
   *   'SKEW',
   *   'UNWIND',
   *   'Net position: 900/1000 (90%), time to expiry: 2 hours'
   * );
   *
   * // Unwind → Panic
   * const event3 = new MarketModeChangedEvent(
   *   'UNWIND',
   *   'PANIC',
   *   'Net position: 950/1000 (95%), time to expiry: 30 minutes'
   * );
   *
   * // Panic → Paused
   * const event4 = new MarketModeChangedEvent(
   *   'PANIC',
   *   'PAUSED',
   *   'Position closed, market conditions unstable'
   * );
   * ```
   */
  constructor(
    public readonly fromMode: TradingMode,
    public readonly toMode: TradingMode,
    public readonly reason: string,
    timestamp: Date = new Date()
  ) {
    super('MarketModeChanged', timestamp);
  }

  /**
   * Gets event data for serialization
   *
   * @returns Event data
   */
  protected getData(): Record<string, unknown> {
    return {
      fromMode: this.fromMode,
      toMode: this.toMode,
      reason: this.reason,
    };
  }

  /**
   * Checks if mode escalated to higher risk
   *
   * @returns True if toMode is more aggressive than fromMode
   *
   * @remarks
   * Risk escalation order:
   * FLAT < QUOTE < SKEW < UNWIND < PANIC
   * PAUSED is considered neutral (not escalation)
   *
   * @example
   * ```typescript
   * const event1 = new MarketModeChangedEvent('QUOTE', 'SKEW', '...');
   * console.log(event1.isEscalation()); // true
   *
   * const event2 = new MarketModeChangedEvent('SKEW', 'QUOTE', '...');
   * console.log(event2.isEscalation()); // false (de-escalation)
   * ```
   */
  public isEscalation(): boolean {
    // PAUSED is neutral - transitions involving PAUSED are not escalations
    if (this.fromMode === 'PAUSED' || this.toMode === 'PAUSED') {
      return false;
    }

    const modeRank: Record<TradingMode, number> = {
      FLAT: 0,
      QUOTE: 1,
      SKEW: 2,
      UNWIND: 3,
      PANIC: 4,
      PAUSED: -1, // not used due to guard above
    };

    return modeRank[this.toMode] > modeRank[this.fromMode];
  }

  /**
   * Checks if mode de-escalated to lower risk
   *
   * @returns True if toMode is less aggressive than fromMode
   *
   * @example
   * ```typescript
   * const event = new MarketModeChangedEvent('UNWIND', 'SKEW', '...');
   * console.log(event.isDeescalation()); // true
   * ```
   */
  public isDeescalation(): boolean {
    // PAUSED is neutral - transitions involving PAUSED are not de-escalations
    if (this.fromMode === 'PAUSED' || this.toMode === 'PAUSED') {
      return false;
    }

    const modeRank: Record<TradingMode, number> = {
      FLAT: 0,
      QUOTE: 1,
      SKEW: 2,
      UNWIND: 3,
      PANIC: 4,
      PAUSED: -1, // not used due to guard above
    };

    return modeRank[this.toMode] < modeRank[this.fromMode];
  }

  /**
   * Checks if entered panic mode
   *
   * @returns True if toMode is PANIC
   *
   * @example
   * ```typescript
   * const event = new MarketModeChangedEvent('UNWIND', 'PANIC', '...');
   * if (event.isPanicMode()) {
   *   console.error('PANIC MODE ACTIVATED!');
   * }
   * ```
   */
  public isPanicMode(): boolean {
    return this.toMode === 'PANIC';
  }

  /**
   * Checks if trading paused
   *
   * @returns True if toMode is PAUSED
   *
   * @example
   * ```typescript
   * const event = new MarketModeChangedEvent('PANIC', 'PAUSED', '...');
   * if (event.isPaused()) {
   *   console.log('Trading paused');
   * }
   * ```
   */
  public isPaused(): boolean {
    return this.toMode === 'PAUSED';
  }

  /**
   * String representation
   *
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * const event = new MarketModeChangedEvent(...);
   * console.log(event.toString());
   * // 'MarketModeChanged: QUOTE → SKEW (Net position: 750/1000)'
   * ```
   */
  public toString(): string {
    return `MarketModeChanged: ${this.fromMode} → ${this.toMode} (${this.reason})`;
  }
}
