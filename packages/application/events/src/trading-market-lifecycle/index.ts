/**
 * Application-события жизненного цикла рынка в НАШЕМ торговом рантайме.
 *
 * @remarks
 * Это второе поколение lifecycle-событий, и оно намеренно отделено от
 * первого (`market-lifecycle/`: `MARKET_OPENED`/`MARKET_CLOSED`).
 *
 * ```text
 * Market.state                        внешнее состояние рынка на площадке
 *   ACTIVE → CLOSED → RESOLVED        мы его наблюдаем, но не управляем им
 *
 * TradingMarketLifecycle              что наш рантайм делает с этим рынком
 *   ADMITTED → ACTIVE → TRADING_CLOSED → RESOLVED → FINALIZED
 * ```
 *
 * Две вещи не объединяются. Комбинация «`market.state = ACTIVE`, торговый
 * lifecycle = `TRADING_CLOSED`» полностью законна: мы уже перестали
 * торговать по `expiresAt`, а площадка ещё показывает рынок активным.
 *
 * ### Подписчики
 * - `TradingStateProjector` (`@polymarket/trading-state`) — единственный
 *   писатель торгового hot state; подписки critical.
 *
 * ### Producer
 * Пока нет: admission принадлежит будущему owner/composition-слою над
 * `MarketUniverse` + Policy + Subscription Planner. Discovery и Planner об
 * этих событиях не знают и знать не должны.
 */
export type { TradingMarketAdmittedEvent } from './TradingMarketAdmittedEvent.js';
export type { TradingMarketActivatedEvent } from './TradingMarketActivatedEvent.js';
export type { TradingMarketClosedEvent } from './TradingMarketClosedEvent.js';
export type { TradingMarketResolvedEvent } from './TradingMarketResolvedEvent.js';
export type { TradingMarketFinalizedEvent } from './TradingMarketFinalizedEvent.js';
