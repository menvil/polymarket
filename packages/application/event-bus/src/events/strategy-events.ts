/**
 * Стратегические события — сигналы от стратегий.
 *
 * @remarks
 * StrategySignalEvent публикуется стратегией через TradingAPI.signal().
 * TradingOrchestrator подписывается и инициирует размещение ордеров.
 */
import type { InstrumentId } from '@polymarket/ids';
import type { Price, Quantity } from '@polymarket/value-objects';

/**
 * Направление сигнала стратегии.
 */
export type SignalDirection = 'BUY' | 'SELL';

/**
 * Торговый сигнал от стратегии.
 *
 * @remarks
 * Публикуется IStrategy.onBookUpdated() или другими методами стратегии.
 * TradingOrchestrator преобразует сигнал в PlaceOrderUseCase.
 * suggestedPrice/suggestedSize — рекомендации, оркестратор может скорректировать
 * с учётом риск-лимитов и рыночных ограничений.
 */
export interface StrategySignalEvent {
  readonly type: 'STRATEGY_SIGNAL';
  /** ID стратегии (branded string нет — обычная строка) */
  readonly strategyId: string;
  /** Направление сигнала */
  readonly signal: SignalDirection;
  /** ID инструмента */
  readonly instrumentId: InstrumentId;
  /** Рекомендуемая цена (VO, не string; опционально) */
  readonly suggestedPrice?: Price;
  /** Рекомендуемый объём (VO, не string; опционально) */
  readonly suggestedSize?: Quantity;
}
