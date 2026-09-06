/**
 * @polymarket/collector — сборщик сырых данных как sibling-consumer шины.
 *
 * @remarks
 * После Collector-cutover сборщик не владеет источниками данных. Он:
 *
 * - выражает интерес к данным как обычный владелец claim-ов
 *   ({@link COLLECTOR_RAW_OWNER_KEY}) в общем control-plane (Polymarket и CEX);
 * - записывает интересующие рынки как обычный подписчик общего
 *   `ExternalMessageBus` через `ExternalMessageRecorder`;
 * - решает, начинать ли запись Polymarket-рынка, по canonical `MarketUniverse`,
 *   owner policy И подтверждённому claim-у — это делает
 *   {@link PolymarketCollectionGate}, который передаётся recorder-у как
 *   `sessionProvider`;
 * - ведёт жизненный цикл уже начатой записи — {@link PolymarketCollectionLifecycle}:
 *   `ACTIVE → expiresAt → FINALIZING → settlement grace → seal → release claim`;
 * - владеет форматом finalization-раздела canonical header-а
 *   ({@link buildFinalizedMarketHeader}), который заполняет `MarketFinalizer`.
 *
 * ```text
 * Sources → source-native ExternalMessage → ОДИН ExternalMessageBus
 *                                              ├── Collector (recorder + gate)
 *                                              ├── PolymarketSemanticAdapter
 *                                              └── CexSemanticAdapter
 *
 * PolymarketSubscriptionController ◄── lifecycle: getHeldMarket / release
 * ```
 *
 * Пакет НЕ создаёт и не закрывает источники, не создаёт вторую шину и не
 * управляет физическими подписками — этим владеет shared control-plane.
 *
 * @packageDocumentation
 */
export { COLLECTOR_RAW_OWNER_KEY } from './collectorOwner.js';
export { PolymarketCollectionGate } from './PolymarketCollectionGate.js';
export type {
  CollectionOwnershipView,
  PolymarketCollectionGateDependencies,
  PolymarketCollectionGateStats,
} from './PolymarketCollectionGate.js';
export { PolymarketCollectionLifecycle } from './PolymarketCollectionLifecycle.js';
export type {
  CollectionLifecycleRecorder,
  CollectionLifecycleSubscriptions,
  PolymarketCollectionLifecycleConfig,
  PolymarketCollectionLifecycleDependencies,
  PolymarketCollectionLifecycleStats,
} from './PolymarketCollectionLifecycle.js';
export type {
  CollectionLifecycleEvent,
  CollectionLifecycleKind,
  CollectionLifecycleListener,
  CollectionMarketPreparation,
  CollectionSessionSnapshot,
  CollectionSessionState,
  FinalizingCollectionSession,
} from './collectionSession.js';
export { buildFinalizedMarketHeader } from './collectionFinalization.js';
export type {
  CollectionFallbackEvidence,
  CollectionFallbackTrigger,
  CollectionFinalOutcome,
  CollectionHeaderFinalization,
  CollectionPriceProvenance,
  CollectionResolutionProvenance,
  CollectionSettlementDescriptor,
  FinalizedMarketHeaderInput,
} from './collectionFinalization.js';
