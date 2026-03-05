/**
 * Доменные события Market entity
 *
 * @remarks
 * События — факты, которые уже произошли в жизненном цикле рынка.
 *
 * ### Отличие от команд:
 * - Команда (`close()`, `resolve()`) — намерение, может выбросить ошибку
 * - Событие — факт, применяется к уже изменившемуся состоянию
 *
 * ### Применение:
 * - `MarketClosedEvent` → application-слой отменяет открытые ордера на рынке
 * - `MarketResolvedEvent` → application-слой рассчитывает P&L и settlement позиций
 *
 * ### Почему НЕТ `MarketCreatedEvent`:
 * Market создаётся через `fromJSON` при старте или синхронизации с Polymarket API,
 * а не в рамках бизнес-команды внутри системы. Регистрация нового рынка — это
 * операция инфраструктурного уровня, а не доменное событие.
 *
 * ### Почему НЕТ `fromEvents()`:
 * Market — 3-state FSM (ACTIVE → CLOSED → RESOLVED). Состояние всегда полностью
 * представлено текущим снапшотом. Event sourcing/replay избыточен для такой простой
 * машины состояний, в отличие от Order с множественными fills.
 *
 * @example
 * ```typescript
 * const closed = market.close();
 * const events = closed.pullEvents(); // [MarketClosedEvent]
 * await eventBus.publish(events);
 *
 * // Другой агрегат реагирует:
 * // OrderService.onMarketClosed(event.marketId) → cancel open orders
 * // PortfolioService.onMarketClosed(event.marketId) → mark positions
 * ```
 */

import type { MarketId } from '@polymarket/ids';
import type { MarketSlug, OutcomeIndex } from './value-objects/index.js';

/**
 * MarketClosedEvent — рынок перешёл в состояние CLOSED
 *
 * @remarks
 * Эмитируется при успешном вызове `market.close()`.
 * Подписчики: OrderService (отмена открытых ордеров), TradingEngine (stop accepting orders).
 */
export interface MarketClosedEvent {
  readonly type: 'MARKET_CLOSED';
  /** Идентификатор рынка */
  readonly marketId: MarketId;
  /** Слаг для логирования и отображения без дополнительного lookup */
  readonly slug: MarketSlug;
  /** Время события в миллисекундах (Unix timestamp) */
  readonly occurredAt: number;
}

/**
 * MarketResolvedEvent — рынок перешёл в состояние RESOLVED с конкретным исходом
 *
 * @remarks
 * Эмитируется при успешном вызове `market.resolve(outcomeIndex)`.
 * Подписчики: PortfolioService (settlement позиций, расчёт P&L).
 */
export interface MarketResolvedEvent {
  readonly type: 'MARKET_RESOLVED';
  /** Идентификатор рынка */
  readonly marketId: MarketId;
  /** Слаг для логирования и отображения без дополнительного lookup */
  readonly slug: MarketSlug;
  /** Индекс победившего исхода (0 = YES/UP, 1 = NO/DOWN) */
  readonly resolvedOutcomeIndex: OutcomeIndex;
  /** Время события в миллисекундах (Unix timestamp) */
  readonly occurredAt: number;
}

/**
 * MarketEvent — discriminated union всех доменных событий Market
 */
export type MarketEvent = MarketClosedEvent | MarketResolvedEvent;
