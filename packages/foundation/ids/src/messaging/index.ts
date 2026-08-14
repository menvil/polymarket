/**
 * Messaging ID types - идентификаторы message-системы
 *
 * @remarks
 * Canonical identity-типы для системы сообщений (M-003):
 * - `MessageId` — identity конкретного сообщения;
 * - `RunId` — identity одного runtime/process lifecycle.
 *
 * Генерация значений (crypto random, high-resolution time, sequence) живёт
 * в `@polymarket/messages` (`generateRunId`, `MessageMetadataGenerator`) —
 * этот пакет владеет только типами и валидацией.
 *
 * @packageDocumentation
 */

export type { MessageId } from './MessageId.js';
export { asMessageId, unsafeMessageId } from './MessageId.js';

export type { RunId } from './RunId.js';
export { asRunId, unsafeRunId } from './RunId.js';
