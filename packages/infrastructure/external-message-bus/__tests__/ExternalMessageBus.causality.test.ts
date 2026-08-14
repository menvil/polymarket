/**
 * Integration-тест causal chain внешнего контура.
 *
 * @remarks
 * Фиксирует contract M-004 (реальные semantic adapters подключаются в M-005+):
 *
 * ```text
 * M1 ExternalMessage   ← transport: generator.nextRoot()
 *  ↓
 * M2 внутреннее сообщение ← adapter: generator.nextChild(M1.metadata)
 * ```
 *
 * Проверяется одновременно и обратное: bus в этой цепочке НЕ участвует —
 * causality создаёт producer до publish и adapter после доставки, движок
 * доставки metadata не генерирует и не переписывает.
 *
 * Application EventBus сюда сознательно НЕ подключается: contract касается
 * generator-а и сообщений, а не второго контура доставки.
 */
import { describe, it, expect } from '@jest/globals';
import { LiveClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import type { MessageEnvelope, MessageMetadata } from '@polymarket/messages';
import type { ExternalMessage } from '@polymarket/external-messages';
import { ExternalMessageBus } from '../src/index.js';

/** Внешнее наблюдение — source-native payload. */
type TestExternalMessage = ExternalMessage<
  'TEST_EXTERNAL',
  {
    readonly rawInstrument: string;
    readonly rawPrice: string;
  }
>;

/** Внутреннее сообщение, порождённое semantic adapter-ом. */
type TestInternalMessage = MessageEnvelope<
  'TEST_INTERNAL',
  {
    readonly instrument: string;
    readonly price: number;
  }
>;

describe('external → internal causal chain', () => {
  it('root external + child internal образуют корректную цепочку', async () => {
    const generator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const bus = new ExternalMessageBus<TestExternalMessage>();
    const produced: TestInternalMessage[] = [];

    // Semantic adapter: получает наблюдение, порождает внутреннее сообщение
    bus.subscribe('TEST_EXTERNAL', (message) => {
      produced.push({
        type: 'TEST_INTERNAL',
        payload: {
          instrument: message.payload.rawInstrument.toUpperCase(),
          price: Number(message.payload.rawPrice),
        },
        metadata: generator.nextChild(message.metadata),
      });
    });

    // Transport: внешнее наблюдение начинает causal chain
    const external: TestExternalMessage = {
      type: 'TEST_EXTERNAL',
      payload: { rawInstrument: 'btc-usd', rawPrice: '64250.5' },
      metadata: generator.nextRoot(),
    };

    const result = await bus.publish(external);
    expect(result.ok).toBe(true);
    expect(produced).toHaveLength(1);

    const child = produced[0];
    if (child === undefined) throw new Error('adapter produced no message');

    // Root: correlation замкнут на себя, causation отсутствует
    expect(external.metadata.correlationId).toBe(external.metadata.messageId);
    expect(external.metadata.causationId).toBeUndefined();

    // Child: корень цепочки — external, непосредственный parent — тоже external
    expect(child.metadata.correlationId).toBe(external.metadata.messageId);
    expect(child.metadata.causationId).toBe(external.metadata.messageId);

    // Разные сообщения одного runtime: своя identity, строго растущий sequence
    expect(child.metadata.messageId).not.toBe(external.metadata.messageId);
    expect(child.metadata.runId).toBe(external.metadata.runId);
    expect(child.metadata.sequence).toBe(external.metadata.sequence + 1);
  });

  it('цепочка продолжается за пределы первого child (correlation остаётся корнем)', async () => {
    const generator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const bus = new ExternalMessageBus<TestExternalMessage>();
    const chain: MessageMetadata[] = [];

    bus.subscribe('TEST_EXTERNAL', (message) => {
      const first = generator.nextChild(message.metadata);
      const second = generator.nextChild(first);
      chain.push(first, second);
    });

    const external: TestExternalMessage = {
      type: 'TEST_EXTERNAL',
      payload: { rawInstrument: 'eth-usd', rawPrice: '3120.25' },
      metadata: generator.nextRoot(),
    };
    await bus.publish(external);

    const [first, second] = chain;
    if (first === undefined || second === undefined) throw new Error('incomplete chain');

    // correlationId — корень ВСЕЙ цепочки, а не непосредственный parent
    expect(first.correlationId).toBe(external.metadata.messageId);
    expect(second.correlationId).toBe(external.metadata.messageId);
    // causationId — стрелка ровно на один шаг назад
    expect(first.causationId).toBe(external.metadata.messageId);
    expect(second.causationId).toBe(first.messageId);
  });

  it('bus не участвует в causality: доставленная metadata идентична опубликованной', async () => {
    const generator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const bus = new ExternalMessageBus<TestExternalMessage>();
    let delivered: MessageMetadata | undefined;

    bus.subscribe('TEST_EXTERNAL', (message) => {
      delivered = message.metadata;
    });

    const external: TestExternalMessage = {
      type: 'TEST_EXTERNAL',
      payload: { rawInstrument: 'sol-usd', rawPrice: '148.75' },
      metadata: generator.nextRoot(),
    };
    const snapshot = { ...external.metadata };

    await bus.publish(external);

    expect(delivered).toBe(external.metadata);
    expect(delivered).toEqual(snapshot);
    // Ни correlationId, ни causationId, ни sequence движком не тронуты
    expect(delivered?.correlationId).toBe(snapshot.correlationId);
    expect(delivered?.causationId).toBeUndefined();
    expect(delivered?.sequence).toBe(snapshot.sequence);
  });
});
