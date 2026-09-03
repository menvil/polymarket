/**
 * Публичный API рантайма коллектора.
 *
 * @remarks
 * Экспортируется для production-`main.ts` и verification-runner-ов, которые
 * обязаны поднимать один и тот же контур. Semantic-слой этим API НЕ
 * пользуется: его точка входа — общий `ExternalMessageBus`, а не рантайм сбора.
 */
export { DataCollector } from './DataCollector.js';
export type {
  CollectorBus,
  CollectorCexController,
  CollectorCexStorage,
  CollectorGate,
  CollectorPolymarketClient,
  CollectorPolymarketController,
  CollectorPolymarketControlRuntime,
  CollectorPolymarketSource,
  CollectorPolymarketStorage,
  CollectorRecorder,
  DataCollectorComponents,
  DataCollectorDependencies,
  DataCollectorState,
  DataCollectorStatus,
} from './DataCollector.js';
export { buildCexDemands, buildCexTransportIndex, createDataCollector } from './createDataCollector.js';
export type {
  ContourBus,
  ContourMessage,
  ContourPolymarketClient,
  CreateDataCollectorOptions,
  CreatedDataCollector,
} from './createDataCollector.js';
export { cexTransportKey, parseCexExchangeConfigs, toDataCollectorConfig } from './DataCollectorConfig.js';
export type {
  CexCollectionConfig,
  CexExchangeConfig,
  CexTransportConfig,
  ControlRuntimeConfig,
  DataCollectorConfig,
  PolymarketRecordingConfig,
} from './DataCollectorConfig.js';
export { applyProcessBootstrap, installShutdownHandlers } from './processBootstrap.js';
export type { ProcessBootstrap, ShutdownTarget } from './processBootstrap.js';
