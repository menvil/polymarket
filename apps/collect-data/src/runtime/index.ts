/**
 * Публичный API рантайма коллектора.
 *
 * @remarks
 * Экспортируется для двух потребителей: production-`main.ts` и
 * verification-runner CHECKPOINT-а, которые обязаны поднимать один и тот же
 * контур. Semantic-слой этим API пользоваться НЕ должен: его точка входа —
 * общий `ExternalMessageBus`, а не рантайм сбора.
 */
export { DataCollector } from './DataCollector.js';
export type {
  CexSourceHealth,
  CollectorBus,
  CollectorCexSource,
  CollectorCexSourceEntry,
  CollectorCexStorage,
  CollectorCoordinator,
  CollectorDiscovery,
  CollectorFinalizer,
  CollectorPolymarketSource,
  CollectorPolymarketStorage,
  CollectorRecorder,
  DataCollectorComponents,
  DataCollectorDependencies,
  DataCollectorState,
  DataCollectorStatus,
} from './DataCollector.js';
export { createDataCollector } from './createDataCollector.js';
export type {
  ContourBus,
  ContourMessage,
  CreateDataCollectorOptions,
  CreatedDataCollector,
} from './createDataCollector.js';
export { parseCexSourceConfigs, toDataCollectorConfig } from './DataCollectorConfig.js';
export type {
  CexCollectionConfig,
  CollectionRuntimeConfig,
  DataCollectorConfig,
  FinalizationRuntimeConfig,
  PolymarketRecordingConfig,
} from './DataCollectorConfig.js';
export { CollectionLifecycleProjection } from './collectionLifecycle.js';
export type {
  CollectionDropReason,
  CollectionFinalizedOutcome,
  CollectionLifecycleCounts,
  CollectionLifecycleEvent,
  CollectionLifecycleKind,
  CollectionLifecycleListener,
} from './collectionLifecycle.js';
export { applyProcessBootstrap, installShutdownHandlers } from './processBootstrap.js';
export type { ProcessBootstrap, ShutdownTarget } from './processBootstrap.js';
