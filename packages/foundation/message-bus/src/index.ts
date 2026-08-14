/**
 * @polymarket/message-bus — generic in-process typed message delivery primitive.
 *
 * @remarks
 * Foundation-примитив доставки сообщений: FIFO-очередь, typed-подписки по
 * discriminator `type`, параллельный fan-out, Result-based operational-ошибки,
 * policies, lifecycle (`drain`/`close`) и диагностика (stats/observer).
 *
 * Пакет ничего не знает о прикладных слоях. Contract сообщения — canonical
 * envelope `{ type, payload, metadata }` (M-003): generic-граница
 * `TMessage extends TypedMessage` из `@polymarket/messages` (canonical owner —
 * там же; этот пакет contract НЕ реэкспортирует). Runtime по-прежнему читает
 * ТОЛЬКО `message.type` — payload/metadata прозрачны для движка доставки и не
 * генерируются им: producer обязан передать ПОЛНОЕ сообщение. Полный
 * поведенческий контракт — в README пакета.
 *
 * `FifoMessageQueue` — внутренняя деталь реализации, из корня не экспортируется.
 *
 * @example
 * ```typescript
 * import { MessageBus, createMessageBusPolicy } from '@polymarket/message-bus';
 * import type { MessageEnvelope } from '@polymarket/messages';
 *
 * type Message =
 *   | MessageEnvelope<'ITEM_ADDED', { readonly itemId: string }>
 *   | MessageEnvelope<'HEARTBEAT', { readonly sequence: number }>;
 *
 * const bus = new MessageBus<Message>({
 *   policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 10_000 } }),
 * });
 *
 * bus.subscribe('HEARTBEAT', (message) => { monitor.beat(message.payload.sequence); });
 * const result = await bus.publish({
 *   type: 'HEARTBEAT',
 *   payload: { sequence: 42 },
 *   metadata: metadataGenerator.nextRoot(),
 * });
 * ```
 */
/** Generic-обработчик сообщения (см. MessageHandler.ts). */
export type { MessageHandler } from './MessageHandler.js';
/** Generic-порт message bus (см. IMessageBus.ts). */
export type { IMessageBus } from './IMessageBus.js';
/** Реализация bus и опции конструктора (см. MessageBus.ts). */
export { MessageBus } from './MessageBus.js';
export type { MessageBusOptions } from './MessageBus.js';
/** Политики доставки: тип, default и helper (см. MessageBusPolicy.ts). */
export type { MessageBusPolicy, MessageBusPolicyOverrides } from './MessageBusPolicy.js';
export { DEFAULT_MESSAGE_BUS_POLICY, createMessageBusPolicy } from './MessageBusPolicy.js';
/** Диагностический снимок состояния (см. MessageBusStats.ts). */
export type { MessageBusStats } from './MessageBusStats.js';
/** Опциональный observer и контексты уведомлений (см. MessageBusObserver.ts). */
export type {
  MessageBusObserver,
  HandlerErrorContext,
  QueueOverflowContext,
  DrainLimitContext,
} from './MessageBusObserver.js';
/** Typed operational-ошибки и их unions (см. errors.ts). */
export {
  MessageBusOverflowError,
  MessageBusCriticalHandlerError,
  MessageBusDrainLimitError,
  MessageBusClosedError,
} from './errors.js';
export type { MessageBusPublishError, MessageBusDrainError } from './errors.js';
