import type { MessageEnvelope } from './MessageEnvelope.js';
import type { MessageMetadata } from './MessageMetadata.js';

/**
 * Generic-граница системного сообщения — canonical envelope в самой широкой
 * параметризации.
 *
 * @remarks
 * До M-003 `TypedMessage` требовал только `{ readonly type: string }` и
 * позволял flat-сообщениям проходить через MessageBus. После M-003 системные
 * message types НЕ могут обходить canonical envelope: compile-time contract
 * требует `type + payload + metadata`.
 *
 * Runtime delivery-слой (`@polymarket/message-bus`) по-прежнему читает ТОЛЬКО
 * `message.type` — `payload`/`metadata` для него прозрачны и не
 * интерпретируются. Ограничение существует ровно для того, чтобы каждый
 * конкретный message-union системы (ApplicationEvent, OrderEvent, будущий
 * ExternalMessage) был обязан нести полную canonical-форму.
 *
 * @example
 * ```typescript
 * // Валидное системное сообщение:
 * type HeartbeatMessage = MessageEnvelope<'HEARTBEAT', { readonly sequence: number }>;
 *
 * // Flat-форма БОЛЬШЕ НЕ валидна как системное сообщение:
 * // { type: 'HEARTBEAT', sequence: 42 } — не satisfies TypedMessage
 * ```
 */
export type TypedMessage = MessageEnvelope<string, unknown, MessageMetadata>;
