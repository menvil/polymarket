/**
 * `@polymarket/cex-semantic-adapter` — semantic-граница CEX-контура.
 *
 * @remarks
 * Пакет содержит ОДИН публичный компонент — {@link CexSemanticAdapter}:
 * второй потребитель общего raw `ExternalMessageBus`, превращающий
 * наблюдения CCXT в canonical `Orderbook<AssetPrice>` и ApplicationEvents.
 *
 * Помощники вынесены наружу только те, у которых есть самостоятельная
 * ответственность и собственные инварианты: отображение идентичности
 * (`identity`) и ограниченное окно дедупликации сделок
 * ({@link RecentVenueTradeIds}). Ни `CexOrderbook`, ни `CexTrade`, ни
 * `CexPrice` здесь не существуют — CEX использует ТУ ЖЕ каноническую
 * модель стакана, что и рынок предсказаний, отличаясь только ценовым
 * доменом:
 *
 * ```text
 * рынок предсказаний → Orderbook<OutcomePrice>
 * биржа              → Orderbook<AssetPrice>
 * ```
 *
 * @example
 * ```typescript
 * import { CexSemanticAdapter } from '@polymarket/cex-semantic-adapter';
 *
 * const adapter = new CexSemanticAdapter({ bus, eventBus, metadataGenerator, logger });
 * adapter.start();
 * // ... adapter.close();
 * ```
 */
export { CexSemanticAdapter } from './CexSemanticAdapter.js';
export type {
  CexSemanticAdapterDependencies,
  CexSemanticAdapterStats,
  CexSemanticBusSubscription,
} from './CexSemanticAdapter.js';

export {
  instrumentStateKey,
  resolveCexIdentity,
  toInstrumentId,
  toVenueId,
} from './identity.js';
export type { CexIdentitySource, CexInstrumentIdentity } from './identity.js';

export {
  DEFAULT_RECENT_TRADE_IDS_CAPACITY,
  RecentVenueTradeIds,
} from './RecentVenueTradeIds.js';
