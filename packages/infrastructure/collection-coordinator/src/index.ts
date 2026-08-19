/**
 * @polymarket/collection-coordinator — coordinator collection sessions (N-003).
 *
 * @remarks
 * Control-plane пакет: превращает выбранный Discovery V2 рынок в failure-safe
 * ACTIVE collection session:
 *
 * ```text
 * Market Discovery V2 → MarketCollectionCoordinator
 *                          ├── ExternalMessageRecorder.registerMarket (FIRST)
 *                          ├── PolymarketSource.subscribeMarket
 *                          └── shared/ref-counted RTDS feeds
 * ```
 *
 * Data plane (Source → ExternalMessage → общий ExternalMessageBus → Recorder)
 * пакетом НЕ затрагивается; здесь нет ни decode payload, ни записи файлов,
 * ни semantic conversion.
 */
export { MarketCollectionCoordinator } from './MarketCollectionCoordinator.js';
export type {
  CollectionCoordinatorStats,
  CollectionDiscovery,
  CollectionOpenOutcome,
  CollectionRecorder,
  CollectionSessionSnapshot,
  CollectionSource,
  MarketCollectionCoordinatorConfig,
  MarketCollectionCoordinatorDependencies,
} from './MarketCollectionCoordinator.js';
export { buildCollectionHeader } from './collectionHeader.js';
