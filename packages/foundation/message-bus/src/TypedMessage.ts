/**
 * Минимальный routing-контракт сообщения для MessageBus.
 *
 * @remarks
 * MessageBus — generic-примитив доставки: единственное, что он знает о сообщении, —
 * это строковый discriminator `type`, по которому выполняется маршрутизация к
 * подписчикам. Никаких других полей bus не читает, не модифицирует и не
 * интерпретирует.
 *
 * Ограничение сознательно минимально: благодаря этому bus одинаково работает и с
 * flat-сообщениями (`{ type: 'ITEM_ADDED', itemId }`), и со стандартизированным
 * конвертом {@link MessageEnvelope} (`{ type, payload, metadata? }`). Требовать
 * `payload` на уровне generic-границы нельзя — это заблокировало бы использование
 * bus с существующими flat discriminated unions.
 *
 * @example
 * ```typescript
 * // Flat-сообщение — валидный TypedMessage:
 * type ItemAddedMessage = { readonly type: 'ITEM_ADDED'; readonly itemId: string };
 *
 * // Envelope-сообщение — тоже валидный TypedMessage:
 * type HeartbeatMessage = MessageEnvelope<'HEARTBEAT', { sequence: number }>;
 * ```
 */
export interface TypedMessage {
  /** Строковый discriminator — единственное поле, используемое bus-ом для routing. */
  readonly type: string;
}
