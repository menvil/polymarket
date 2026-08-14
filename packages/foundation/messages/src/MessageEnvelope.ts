import type { MessageMetadata } from './MessageMetadata.js';

/**
 * Canonical message envelope — ОДИН обязательный системный контракт сообщения.
 *
 * @remarks
 * После M-003 любое public system message имеет одинаковую верхнеуровневую
 * форму `{ type, payload, metadata }`:
 *
 * - `type` — routing discriminator (единственное поле, которое читает
 *   generic delivery-слой);
 * - `payload` — строго типизированные semantic data конкретного сообщения;
 * - `metadata` — обязательная единая системная metadata
 *   ({@link MessageMetadata}: identity, ordering, creation time, causal chain).
 *
 * Все три поля ОБЯЗАТЕЛЬНЫ. Flat-форма `{ type, fieldA, fieldB }` и
 * optional metadata (`metadata?`) canonical-контрактом запрещены.
 *
 * Этот контракт — Foundation-владение (`@polymarket/messages`): он не
 * принадлежит ни delivery-механике (`@polymarket/message-bus`), ни
 * какому-либо слою событий. `ApplicationEvent`, Domain `OrderEvent` и будущие
 * external-сообщения (M-004) строятся на одном и том же конверте.
 *
 * Readonly-глубина payload обеспечивается concrete payload-контрактами
 * (их поля readonly) — deep-readonly utility сознательно не вводится.
 *
 * @typeParam TType - Строковый literal-тип discriminator'а
 * @typeParam TPayload - Полезная нагрузка сообщения (semantic data)
 * @typeParam TMetadata - Metadata сообщения; по умолчанию — canonical
 *   {@link MessageMetadata}. Расширение допустимо только supersets-ами
 *   (`interface X extends MessageMetadata`), например для будущего
 *   external-контура.
 *
 * @example
 * ```typescript
 * type MarketOpenedEvent = MessageEnvelope<
 *   'MARKET_OPENED',
 *   { readonly marketId: MarketId }
 * >;
 *
 * const event = {
 *   type: 'MARKET_OPENED',
 *   payload: { marketId },
 *   metadata: metadataGenerator.nextRoot(),
 * } satisfies MarketOpenedEvent;
 * ```
 */
export interface MessageEnvelope<
  TType extends string,
  TPayload,
  TMetadata extends MessageMetadata = MessageMetadata,
> {
  /** Routing discriminator — сужен до конкретного literal-типа. */
  readonly type: TType;
  /** Semantic data сообщения — прозрачна для delivery-слоя. */
  readonly payload: TPayload;
  /** Обязательная системная metadata (identity/ordering/time/causality). */
  readonly metadata: TMetadata;
}
