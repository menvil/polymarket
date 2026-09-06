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
/**
 * Canonical правило идентичности RTDS-фида — РЕЭКСПОРТ, а не второе правило.
 *
 * @remarks
 * Правило живёт в `@polymarket/polymarket-v2` (словарь source-контура) и
 * должно быть ОДНО на весь контур: по нему контроллер ведёт ref-count
 * физических подписок, а recorder — routing записи. Реэкспорт нужен слоям
 * recording-контура (в частности collection lifecycle), которым по границе
 * запрещена прямая зависимость от source-пакета: без него им пришлось бы
 * повторить предикат у себя, и `btc/usd` TWAP 30 однажды смешался бы с
 * TWAP 60 в одном файле.
 */
export { isTwapRtdsFeed, rtdsFeedKey } from '@polymarket/polymarket-v2';
export type { PolymarketTwapRtdsFeed } from '@polymarket/polymarket-v2';
export type {
  ExternalMessageRecorderDependencies,
  ExternalMessageRecorderStats,
  ExternalMessageRecorderCexDependencies,
  ExternalMessageRecorderCexStats,
  PolymarketRecordingBusSubscription,
  PolymarketRecordingRegistration,
  PolymarketRecordingSessionProvider,
  PolymarketRecordingSessionSnapshot,
  PolymarketRecordingStorage,
  PolymarketRtdsFeedKey,
  CexRecordingBusSubscription,
  CexRecordingStorage,
} from './ExternalMessageRecorder.js';
