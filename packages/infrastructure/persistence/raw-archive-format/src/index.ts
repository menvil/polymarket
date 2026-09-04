/**
 * `@polymarket/raw-archive-format` — canonical wire-контракт replayable
 * raw-архива и его decoder на persistence/replay-границе.
 *
 * @remarks
 * ### Место в архитектуре
 *
 * ```text
 * Sources → ExternalMessage → ONE ExternalMessageBus
 *                                  ├── Recorder ──→ RecordedExternalObservationV2 → JSONL
 *                                  ├── PolymarketSemanticAdapter
 *                                  └── CexSemanticAdapter
 *
 * archive → Replay Source → SAME ExternalMessageBus → SAME Semantic Adapters
 * ```
 *
 * Пакет — leaf БЕЗ зависимостей: и writer (`@polymarket/data-collection`),
 * и reader-ы (`@polymarket/snapshot-readers`, `@polymarket/market-finalizer`)
 * говорят об одном и том же формате одними и теми же типами. Второго
 * определения формата в репозитории быть не должно.
 *
 * ### Что здесь есть
 *
 * - {@link RecordedExternalObservationV2} — одна data-строка архива;
 * - {@link toRecordedObservation} — encode из пришедшего `ExternalMessage`;
 * - {@link CexPartitionHeaderV2} / {@link buildCexPartitionHeader} — header
 *   CEX-партиции;
 * - {@link detectRawArchiveFormat} — определение формата по LINE 1;
 * - {@link decodeRawArchiveLine} / {@link decodeRawArchive} — reader-контракт
 *   с явной {@link RawArchiveTimingQuality}.
 *
 * ### Чего здесь НЕТ
 *
 * Ни DecisionScheduler, ни virtual-time backtester, ни latency-модель
 * legacy-архивов: пакет описывает ФАКТЫ архива, а не их воспроизведение.
 *
 * @packageDocumentation
 */

export { RAW_ARCHIVE_FORMAT_VERSION } from './RecordedExternalObservation.js';
export {
  toRecordedObservation,
  ingressEpochMilliseconds,
  ingressEpochNanoseconds,
  isSameRun,
  compareIngress,
} from './RecordedExternalObservation.js';
export type {
  RawArchiveTimingQuality,
  RecordedIngress,
  RecordedExternalObservationV2,
  ObservationIngressMetadata,
  ObservedExternalMessage,
} from './RecordedExternalObservation.js';

export {
  ARCHIVE_META_DISCRIMINATOR,
  CEX_ARCHIVE_SOURCE,
  buildCexPartitionHeader,
  detectRawArchiveFormat,
  readCexPartitionHeader,
} from './archiveHeader.js';
export type {
  CexArchiveStream,
  CexPartitionHeaderV2,
  RawArchiveFormat,
} from './archiveHeader.js';

export {
  decodeRawArchive,
  decodeRawArchiveLine,
  decodeDetachedArchiveLine,
  isRecordedObservationV2,
} from './decodeRawArchive.js';
export type { DecodedObservation, DecodedRawArchive } from './decodeRawArchive.js';
