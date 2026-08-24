/**
 * @polymarket/external-message-recorder — recording-подписчик внешнего контура.
 *
 * @remarks
 * Пакет соединяет общий `ExternalMessageBus` с существующим storage-движком
 * market-файлов (`@polymarket/data-collection`):
 *
 * ```text
 * ExternalMessageBus → ExternalMessageRecorder → message.payload → DataRecorder → JSONL
 * ```
 *
 * Source не знает о recorder-е; recorder не знает о transport. На диск
 * попадает ТОЛЬКО source-native `message.payload` — canonical runtime
 * metadata (`messageId`/`sequence`/...) и внешний discriminator не
 * записываются. Semantic-конверсии здесь нет: пакет живёт строго ДО
 * semantic adapter.
 */
export { ExternalMessageRecorder } from './ExternalMessageRecorder.js';
export type {
  ExternalMessageRecorderDependencies,
  ExternalMessageRecorderStats,
  ExternalMessageRecorderCexDependencies,
  ExternalMessageRecorderCexStats,
  PolymarketRecordingBusSubscription,
  PolymarketRecordingRegistration,
  PolymarketRecordingStorage,
  PolymarketRtdsFeedKey,
  CexRecordingBusSubscription,
  CexRecordingStorage,
} from './ExternalMessageRecorder.js';
