/**
 * @polymarket/messages — canonical message contract системы.
 *
 * @remarks
 * Foundation-владелец ОДНОГО обязательного контракта сообщения:
 *
 * ```
 * { type, payload, metadata }
 * ```
 *
 * - `MessageEnvelope<TType, TPayload, TMetadata>` — canonical envelope;
 * - `MessageMetadata` — обязательная системная metadata
 *   (identity, runtime identity, ordering, creation time, causal chain);
 * - `TypedMessage` — generic-граница «любое canonical-сообщение»
 *   (используется delivery-слоем `@polymarket/message-bus`).
 *
 * Пакет не знает о delivery (`message-bus`), слоях событий и транспортах:
 * `ApplicationEvent`, Domain `OrderEvent` и будущие external-сообщения (M-004)
 * строятся на одном и том же конверте отсюда.
 *
 * @example
 * ```typescript
 * import type { MessageEnvelope } from '@polymarket/messages';
 *
 * type MarketOpenedEvent = MessageEnvelope<
 *   'MARKET_OPENED',
 *   { readonly marketId: MarketId }
 * >;
 * ```
 */
/** Canonical envelope `{ type, payload, metadata }` (см. MessageEnvelope.ts). */
export type { MessageEnvelope } from './MessageEnvelope.js';
/** Обязательная системная metadata сообщения (см. MessageMetadata.ts). */
export type { MessageMetadata } from './MessageMetadata.js';
/** Generic-граница canonical-сообщения (см. TypedMessage.ts). */
export type { TypedMessage } from './TypedMessage.js';
/** Единый механизм создания metadata (см. MessageMetadataGenerator.ts). */
export { MessageMetadataGenerator } from './MessageMetadataGenerator.js';
export type { MessageMetadataGeneratorOptions } from './MessageMetadataGenerator.js';
/** Canonical-генерация RunId — один вызов на startup (см. generateRunId.ts). */
export { generateRunId } from './generateRunId.js';
/** Порт high-resolution источника абсолютного времени (см. IHighResolutionClock.ts). */
export type { IHighResolutionClock } from './IHighResolutionClock.js';
/** Live-реализация: wall-origin + monotonic elapsed (см. LiveHighResolutionClock.ts). */
export { LiveHighResolutionClock } from './LiveHighResolutionClock.js';
/** Детерминированный high-resolution источник (см. PaperHighResolutionClock.ts). */
export { PaperHighResolutionClock } from './PaperHighResolutionClock.js';
