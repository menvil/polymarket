/**
 * Fill подтверждён on-chain (WsFillStatus: CONFIRMED) после обработки при MATCHED.
 *
 * @remarks
 * Публикуется FillEventHandler когда CONFIRMED приходит для уже опубликованного fill.
 * Сигнализирует что on-chain settlement завершён:
 * - Токены доступны для SELL (cross-outcome mint finality)
 * - Exchange rejection cooldown можно сбросить
 * - Стратегия должна тикнуть для retry SELL
 *
 * НЕ публикуется при fallback (CONFIRMED без MATCHED) — там идёт FILL_RECEIVED.
 */
import type { Fill } from '@polymarket/fill';
import type { Timestamp } from '@polymarket/value-objects';

export interface FillConfirmedEvent {
  readonly type: 'FILL_CONFIRMED';
  /** Fills, подтверждённые on-chain */
  readonly fills: readonly Fill[];
  /** Timestamp получения CONFIRMED в системе */
  readonly receivedAt: Timestamp;
}
