/**
 * @polymarket/cex-v2 — CEX V2 ingress boundary.
 *
 * @remarks
 * Наблюдения CCXT / CCXT Pro (public order books + trades), обёрнутые в
 * canonical ExternalMessages и опубликованные в общий ExternalMessageBus.
 * Semantic-конверсия в Domain-концепты здесь сознательно отсутствует —
 * это работа будущего CEX Semantic Adapter.
 */
export type {
  CexMarketType,
  CcxtOrderBookSnapshot,
  CcxtTradeSnapshot,
  CexOrderbookPayload,
  CexTradePayload,
  CexOrderbookExternalMessage,
  CexTradeExternalMessage,
  CexExternalMessage,
} from './CexExternalMessage.js';
export type {
  CcxtRawOrderBook,
  CcxtRawTrade,
  CcxtProClientLike,
  CcxtProExchangeInstance,
  CcxtProExchangeFactory,
  CcxtProExchangeFactoryParams,
} from './CcxtVendorPort.js';
export type { CcxtInstanceConstructorArgs } from './CcxtVendorPort.js';
export {
  buildCcxtInstanceOptions,
  createCcxtProExchange,
  normalizeOrderbookDepth,
} from './CcxtVendorPort.js';
export type { CexSourceConfig } from './CexSourceConfig.js';
export {
  DEFAULT_ORDERBOOK_DEPTH,
  DEFAULT_RESTART_INTERVAL_MS,
  DEFAULT_ORDERBOOK_STALE_TIMEOUT_MS,
  DEFAULT_TRADES_STALE_TIMEOUT_MS,
  DEFAULT_FETCH_POLL_INTERVAL_MS,
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  PLANNED_RESTART_JITTER_RATIO,
  assertValidCexSourceConfig,
} from './CexSourceConfig.js';
export { snapshotOrderBook, snapshotTrade } from './snapshots.js';
export { PermanentTaskError, RestartingTask } from './RestartingTask.js';
export type { RestartingTaskOptions } from './RestartingTask.js';
export { CexSource } from './CexSource.js';
export type {
  CexSourceDependencies,
  CexSourceStats,
  CexExternalMessagePublisher,
} from './CexSource.js';
