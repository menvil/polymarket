/**
 * Общие canonical-fixtures для тестов MessageBus (M-003).
 *
 * @remarks
 * После M-003 generic-граница bus — canonical envelope `{ type, payload,
 * metadata }`: fixtures строятся настоящим `MessageMetadataGenerator` с
 * детерминированными clock/runId (никакой зависимости от реального времени).
 */
import { MessageMetadataGenerator } from '@polymarket/messages';
import type { MessageEnvelope } from '@polymarket/messages';
import { unsafeRunId } from '@polymarket/ids';

/** Union тестовых сообщений bus — canonical envelopes. */
export type TestMessage =
  | MessageEnvelope<'HEARTBEAT', { readonly seq: number }>
  | MessageEnvelope<'ITEM_ADDED', { readonly itemId: string }>;

/** Один генератор на тестовый runtime — как в production composition root. */
const METADATA_GENERATOR = new MessageMetadataGenerator({
  clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
  runId: unsafeRunId('testrun1'),
});

/** Строит canonical HEARTBEAT-сообщение. */
export function heartbeat(seq: number): TestMessage {
  return { type: 'HEARTBEAT', payload: { seq }, metadata: METADATA_GENERATOR.nextRoot() };
}

/** Строит canonical ITEM_ADDED-сообщение. */
export function itemAdded(itemId: string): TestMessage {
  return { type: 'ITEM_ADDED', payload: { itemId }, metadata: METADATA_GENERATOR.nextRoot() };
}
