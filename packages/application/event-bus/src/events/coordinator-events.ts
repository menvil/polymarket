/**
 * Координационные события — тик координатора.
 *
 * @remarks
 * `StrategyTickEvent` — внутреннее событие тика координатора.
 * Не содержит рыночных данных. Используется как триггер для периодических задач:
 * - обнаружение новых рынков (discovery)
 * - проверка removal policy
 * - reconciliation ордеров/исполнений
 *
 * ### Производительность:
 * Координатор публикует STRATEGY_TICK через eventBus, а не через setInterval.
 * Это позволяет тестировать без реального таймера и контролировать
 * частоту тиков через IClock.
 *
 * ### Использование:
 * ```typescript
 * // Публикация тика (из Scheduler или тестов)
 * await eventBus.publish({ type: 'STRATEGY_TICK', tickNumber: n, timestamp });
 *
 * // Подписка (StrategyCoordinator)
 * eventBus.subscribe('STRATEGY_TICK', async (event) => {
 *   await coordinator.onTick(event.tickNumber);
 * });
 * ```
 */
import type { Timestamp } from '@polymarket/value-objects';

/**
 * Тик координатора стратегий.
 *
 * @remarks
 * Публикуется с определённой периодичностью (например, каждые N секунд).
 * StrategyCoordinator использует tickNumber для определения, нужно ли
 * выполнять discovery или policy check в данном тике.
 */
export interface StrategyTickEvent {
  readonly type: 'STRATEGY_TICK';
  /** Порядковый номер тика (монотонно возрастает с 0) */
  readonly tickNumber: number;
  /** Метка времени тика */
  readonly timestamp: Timestamp;
}
