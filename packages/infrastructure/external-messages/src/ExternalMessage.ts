import type { MessageEnvelope, MessageMetadata } from '@polymarket/messages';

/**
 * Canonical contract сообщения, пришедшего ИЗ ВНЕШНЕГО МИРА.
 *
 * @remarks
 * `ExternalMessage` — semantic specialization canonical Foundation-конверта
 * {@link MessageEnvelope}, а НЕ второй envelope: структура
 * `{ type, payload, metadata }` целиком принадлежит `@polymarket/messages`
 * и здесь не переопределяется и не копируется. Отличается только
 * semantic meaning контура доставки.
 *
 * ### Что означает ExternalMessage
 *
 * «Внешняя система прислала нам source-native сообщение; transport уже
 * получил и декодировал его, но semantic adapter ещё НЕ преобразовал его в
 * наши внутренние concepts».
 *
 * ```text
 * external transport
 *         ↓
 * source-specific decode / basic validation
 *         ↓
 * ExternalMessage          ← эта граница
 *         ↓
 * ExternalMessageBus
 *         ↓
 * source-specific semantic adapter
 *         ↓
 * internal semantic object / ApplicationEvent / Domain workflow
 * ```
 *
 * ### Чем ExternalMessage НЕ является
 *
 * Не `OrderBook`, не `Trade`, не `AssetPrice`, не `VenueOrderUpdate`,
 * не `ApplicationEvent` и не Domain-событие. Всё перечисленное — уже
 * ИНТЕРПРЕТИРОВАННЫЕ concepts, которые появляются ПОСЛЕ semantic adapter;
 * `ExternalMessage` живёт строго до него.
 *
 * ### Source-native payload
 *
 * `TPayload` описывает сообщение конкретного внешнего источника в его
 * собственных терминах (поля, единицы, кодировки транспорта), а не наши
 * Domain-объекты. Payload обязан быть КОНКРЕТНО типизирован
 * source-specific контрактом — `unknown` в production-контрактах
 * недопустим ({@link AnyExternalMessage} существует только как generic
 * bound infrastructure-кода).
 *
 * ### Metadata и causality
 *
 * Metadata — та же canonical {@link MessageMetadata}: отдельного
 * `ExternalMessageMetadata` НЕТ, source/channel/exchange/transport в неё не
 * добавляются (это semantic-данные конкретного источника — их место в
 * typed payload). Внешнее наблюдение обычно НАЧИНАЕТ causal chain, поэтому
 * transport создаёт metadata через `metadataGenerator.nextRoot()`, а
 * порождённые semantic adapter-ом внутренние сообщения — через
 * `metadataGenerator.nextChild(external.metadata)`.
 *
 * @typeParam TType - Строковый literal-тип discriminator'а внешнего сообщения
 * @typeParam TPayload - Source-native полезная нагрузка (типизированная)
 * @typeParam TMetadata - Metadata сообщения; по умолчанию canonical
 *   {@link MessageMetadata}
 *
 * @example
 * ```typescript
 * // Будущий source-specific контракт (M-005+), payload — source-native:
 * type PolymarketBookExternalMessage = ExternalMessage<
 *   'POLYMARKET_BOOK',
 *   PolymarketBookMessagePayload // сообщение транспорта, НЕ Orderbook entity
 * >;
 *
 * const message: PolymarketBookExternalMessage = {
 *   type: 'POLYMARKET_BOOK',
 *   payload: decodePolymarketBook(rawFrame), // decode/validation ДО этой границы
 *   metadata: metadataGenerator.nextRoot(),  // внешнее наблюдение = root
 * };
 * ```
 */
export type ExternalMessage<
  TType extends string,
  TPayload,
  TMetadata extends MessageMetadata = MessageMetadata,
> = MessageEnvelope<TType, TPayload, TMetadata>;

/**
 * Самая широкая параметризация {@link ExternalMessage} — generic bound
 * infrastructure-кода внешнего контура.
 *
 * @remarks
 * Используется ТОЛЬКО там, где код обязан работать с любым внешним
 * сообщением, не зная его конкретного контракта: generic-ограничение
 * `ExternalMessageBus<TMessage extends AnyExternalMessage>`, будущие
 * Recorder/Reader.
 *
 * Это НЕ разрешение писать `unknown` в source adapters: конкретные
 * production message contracts обязаны задавать конкретный `TPayload`.
 * Widening до `AnyExternalMessage` уничтожает discriminated-union narrowing
 * и вместе с ним типизацию подписок.
 *
 * @example
 * ```typescript
 * // Правильно — bound для generic infrastructure:
 * class ExternalRecorder<TMessage extends AnyExternalMessage> { ... }
 *
 * // Неправильно — production-контур теряет narrowing и типизацию payload:
 * const bus = new ExternalMessageBus<AnyExternalMessage>();
 * ```
 */
export type AnyExternalMessage = ExternalMessage<string, unknown>;
