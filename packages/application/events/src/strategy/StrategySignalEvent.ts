/**
 * Торговый сигнал от стратегии.
 *
 * @remarks
 * Публикуется IStrategy.onBookUpdated() или другими методами стратегии.
 * TradingOrchestrator преобразует сигнал в PlaceOrderUseCase.
 * suggestedPrice/suggestedSize — рекомендации, оркестратор может скорректировать
 * с учётом риск-лимитов и рыночных ограничений.
 */
import type { InstrumentId, StrategyId } from '@polymarket/ids';
import type { Price, Quantity } from '@polymarket/value-objects';
import type { SignalDirection } from './SignalDirection.js';

export interface StrategySignalEvent {
  readonly type: 'STRATEGY_SIGNAL';
  /** ID стратегии — canonical branded `StrategyId` из `@polymarket/ids` */
  readonly strategyId: StrategyId;
  /** Направление сигнала */
  readonly signal: SignalDirection;
  /** ID инструмента */
  readonly instrumentId: InstrumentId;
  /** Рекомендуемая цена (VO, не string; опционально) */
  readonly suggestedPrice?: Price;
  /** Рекомендуемый объём (VO, не string; опционально) */
  readonly suggestedSize?: Quantity;
}
