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
 * Ранжирование уровня риска для торговых режимов
 *
 * @remarks
 * Используется для определения эскалации/деэскалации.
 * Большие значения указывают на более высокий уровень риска.
 * PAUSED нейтрален (-1) и исключён из логики эскалации.
 */
const MODE_RISK_RANK: Record<TradingMode, number> = {
  FLAT: 0,
  QUOTE: 1,
  SKEW: 2,
  UNWIND: 3,
  PANIC: 4,
  PAUSED: -1,
};

/**
 * MarketModeChangedEvent
 *
 * @remarks
 * Иммутабельное событие, фиксирующее изменение торгового режима.
 */
export class MarketModeChangedEvent extends DomainEvent {
  /**
   * Создаёт MarketModeChangedEvent
   *
   * @param fromMode - Предыдущий торговый режим
   * @param toMode - Новый торговый режим
   * @param reason - Причина изменения режима
   * @param timestamp - Когда изменился режим (по умолчанию: сейчас)
   *
   * @example
   * ```typescript
   * // Нормальный → Управление запасами
   * const event1 = new MarketModeChangedEvent(
   *   'QUOTE',
   *   'SKEW',
   *   'Net position: 750/1000 (75%)'
   * );
   *
   * // Управление запасами → Закрытие
   * const event2 = new MarketModeChangedEvent(
   *   'SKEW',
   *   'UNWIND',
   *   'Net position: 900/1000 (90%), time to expiry: 2 hours'
   * );
   *
   * // Закрытие → Паника
   * const event3 = new MarketModeChangedEvent(
   *   'UNWIND',
   *   'PANIC',
   *   'Net position: 950/1000 (95%), time to expiry: 30 minutes'
   * );
   *
   * // Паника → Пауза
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
   * Получает данные события для сериализации
   *
   * @returns Данные события
   */
  protected getData(): Record<string, unknown> {
    return {
      fromMode: this.fromMode,
      toMode: this.toMode,
      reason: this.reason,
    };
  }

  /**
   * Проверяет, включает ли переход режим PAUSED
   *
   * @returns True если fromMode или toMode равен PAUSED
   */
  private involvesPausedMode(): boolean {
    return this.fromMode === 'PAUSED' || this.toMode === 'PAUSED';
  }

  /**
   * Проверяет, произошла ли эскалация к более высокому риску
   *
   * @returns True если toMode более агрессивен чем fromMode
   *
   * @remarks
   * Порядок эскалации риска:
   * FLAT < QUOTE < SKEW < UNWIND < PANIC
   * PAUSED считается нейтральным (не эскалация)
   *
   * @example
   * ```typescript
   * const event1 = new MarketModeChangedEvent('QUOTE', 'SKEW', '...');
   * console.log(event1.isEscalation()); // true
   *
   * const event2 = new MarketModeChangedEvent('SKEW', 'QUOTE', '...');
   * console.log(event2.isEscalation()); // false (деэскалация)
   * ```
   */
  public isEscalation(): boolean {
    if (this.involvesPausedMode()) {
      return false;
    }
    return MODE_RISK_RANK[this.toMode] > MODE_RISK_RANK[this.fromMode];
  }

  /**
   * Проверяет, произошла ли деэскалация к более низкому риску
   *
   * @returns True если toMode менее агрессивен чем fromMode
   *
   * @example
   * ```typescript
   * const event = new MarketModeChangedEvent('UNWIND', 'SKEW', '...');
   * console.log(event.isDeescalation()); // true
   * ```
   */
  public isDeescalation(): boolean {
    if (this.involvesPausedMode()) {
      return false;
    }
    return MODE_RISK_RANK[this.toMode] < MODE_RISK_RANK[this.fromMode];
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
