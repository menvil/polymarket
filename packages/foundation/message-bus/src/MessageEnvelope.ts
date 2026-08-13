/**
 * Стандартизированный конверт сообщения — reusable-форма для будущих потребителей.
 *
 * @remarks
 * `MessageEnvelope` — опциональная стандартная структура `{ type, payload, metadata? }`.
 * Сам MessageBus её НЕ требует: generic-граница bus — это {@link TypedMessage}
 * (только `type`). Конверт определён здесь, чтобы будущие контуры (application-события
 * в envelope-формате, внешние сообщения с метаданными транспорта) использовали единый
 * тип, не завися друг от друга.
 *
 * MessageBus не читает, не модифицирует, не клонирует и не интерпретирует
 * `payload`/`metadata` — они прозрачны для движка доставки и типизируются
 * исключительно ради потребителей.
 *
 * @typeParam TType - Строковый literal-тип discriminator'а
 * @typeParam TPayload - Полезная нагрузка сообщения (полностью прозрачна для bus)
 * @typeParam TMetadata - Опциональные метаданные (например, транспортные), по умолчанию `unknown`
 *
 * @example
 * ```typescript
 * type HeartbeatMessage = MessageEnvelope<'HEARTBEAT', { sequence: number }, { source: string }>;
 *
 * const message: HeartbeatMessage = {
 *   type: 'HEARTBEAT',
 *   payload: { sequence: 42 },
 *   metadata: { source: 'ws-feed' },
 * };
 * ```
 */
import type { TypedMessage } from './TypedMessage.js';

export interface MessageEnvelope<
  TType extends string,
  TPayload,
  TMetadata = unknown,
> extends TypedMessage {
  /** Discriminator конверта — сужен до конкретного literal-типа. */
  readonly type: TType;
  /** Полезная нагрузка — прозрачна для MessageBus. */
  readonly payload: TPayload;
  /** Опциональные метаданные — прозрачны для MessageBus. */
  readonly metadata?: TMetadata;
}
