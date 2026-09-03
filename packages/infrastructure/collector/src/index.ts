/**
 * @polymarket/collector — сборщик сырых данных как sibling-consumer шины.
 *
 * @remarks
 * После Collector-cutover сборщик перестаёт владеть источниками данных. Он:
 *
 * - выражает интерес к данным как обычный владелец claim-ов
 *   ({@link COLLECTOR_RAW_OWNER_KEY}) в общем control-plane (Polymarket и CEX);
 * - записывает интересующие рынки как обычный подписчик общего
 *   `ExternalMessageBus` через `ExternalMessageRecorder`;
 * - решает, начинать ли запись Polymarket-рынка, по canonical `MarketUniverse`
 *   и owner policy — это делает {@link PolymarketCollectionGate}, который
 *   передаётся recorder-у как `sessionProvider`.
 *
 * ```text
 * Sources → source-native ExternalMessage → ОДИН ExternalMessageBus
 *                                              ├── Collector (recorder + gate)
 *                                              ├── PolymarketSemanticAdapter
 *                                              └── CexSemanticAdapter
 * ```
 *
 * Пакет НЕ создаёт и не закрывает источники, не создаёт вторую шину и не
 * управляет физическими подписками — этим владеет shared control-plane. Здесь
 * живёт ровно политика допуска рынка к записи и canonical идентичность
 * владельца-коллектора.
 *
 * @packageDocumentation
 */
export { COLLECTOR_RAW_OWNER_KEY } from './collectorOwner.js';
export { PolymarketCollectionGate } from './PolymarketCollectionGate.js';
export type {
  PolymarketCollectionGateDependencies,
  PolymarketCollectionGateStats,
} from './PolymarketCollectionGate.js';
