/**
 * Type-contract тесты canonical envelope `@polymarket/messages`.
 *
 * @remarks
 * Контракты — types-only, поэтому настоящие проверки compile-time
 * (typecheck/ts-jest): обязательность всех трёх полей envelope, запрет flat-форм
 * и optional metadata, канонический generic-контракт `TypedMessage`.
 * Runtime-ассерты минимальны.
 */
import { describe, it, expect } from '@jest/globals';
import { unsafeMessageId, unsafeRunId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/value-objects';
import type { MessageEnvelope, MessageMetadata, TypedMessage } from '../src/index.js';

/** Детерминированная fixture-metadata для compile-time проверок. */
function fixtureMetadata(): MessageMetadata {
  const createdAt = TimestampService.create(1786668087123);
  if (!createdAt.ok) throw createdAt.error;
  const messageId = unsafeMessageId('testrun1-1786668087-123-000-000-000000001');
  return {
    messageId,
    runId: unsafeRunId('testrun1'),
    sequence: 1,
    createdAt: createdAt.value,
    createdAtUnixSeconds: 1786668087,
    millisecondOfSecond: 123,
    microsecondOfMillisecond: 0,
    nanosecondOfMicrosecond: 0,
    correlationId: messageId,
  };
}

type ProbeEvent = MessageEnvelope<'PROBE', { readonly itemId: string }>;

describe('MessageEnvelope canonical contract', () => {
  it('canonical-форма { type, payload, metadata } принимается', () => {
    const event = {
      type: 'PROBE',
      payload: { itemId: 'item-1' },
      metadata: fixtureMetadata(),
    } satisfies ProbeEvent;

    expect(event.type).toBe('PROBE');
    expect(event.payload.itemId).toBe('item-1');
    expect(event.metadata.sequence).toBe(1);
  });

  it('metadata ОБЯЗАТЕЛЬНА (compile-time)', () => {
    // @ts-expect-error — metadata required, canonical envelope без неё не существует
    const bad: ProbeEvent = {
      type: 'PROBE',
      payload: { itemId: 'item-1' },
    };
    void bad;
    expect(true).toBe(true);
  });

  it('payload ОБЯЗАТЕЛЕН (compile-time)', () => {
    // @ts-expect-error — payload required
    const bad: ProbeEvent = {
      type: 'PROBE',
      metadata: fixtureMetadata(),
    };
    void bad;
    expect(true).toBe(true);
  });

  it('type ОБЯЗАТЕЛЕН (compile-time)', () => {
    // @ts-expect-error — type required
    const bad: ProbeEvent = {
      payload: { itemId: 'item-1' },
      metadata: fixtureMetadata(),
    };
    void bad;
    expect(true).toBe(true);
  });

  it('старая flat-форма { type, fieldA } запрещена (compile-time)', () => {
    // @ts-expect-error — old flat shape forbidden: semantic-поля живут в payload
    const bad: ProbeEvent = { type: 'PROBE', itemId: 'item-1' };
    void bad;
    expect(true).toBe(true);
  });

  it('concrete payload не принимает неизвестные поля (compile-time)', () => {
    const good = {
      type: 'PROBE',
      // @ts-expect-error — unknown field в payload отклоняется excess property check
      payload: { itemId: 'item-1', unknownField: 42 },
      metadata: fixtureMetadata(),
    } satisfies ProbeEvent;
    void good;
    expect(true).toBe(true);
  });

  it('TMetadata ограничен MessageMetadata (compile-time)', () => {
    // Расширение superset-ом допустимо:
    interface ExtendedMetadata extends MessageMetadata {
      readonly transportSeq: number;
    }
    type ExternalProbe = MessageEnvelope<'EXTERNAL_PROBE', { readonly raw: string }, ExtendedMetadata>;
    const probe: ExternalProbe = {
      type: 'EXTERNAL_PROBE',
      payload: { raw: 'x' },
      metadata: { ...fixtureMetadata(), transportSeq: 7 },
    };
    void probe;

    // Произвольный не-superset тип metadata запрещён:
    // @ts-expect-error — TMetadata должен extends MessageMetadata
    type Invalid = MessageEnvelope<'X', unknown, { readonly source: string }>;

    expect(true).toBe(true);
  });
});

describe('TypedMessage generic contract', () => {
  it('любой canonical envelope является TypedMessage (compile-time)', () => {
    const widen = (message: ProbeEvent): TypedMessage => message;
    expect(typeof widen).toBe('function');
  });

  it('flat-сообщение НЕ является TypedMessage (compile-time)', () => {
    const flat = { type: 'FLAT', itemId: 'item-1' } as const;
    // @ts-expect-error — flat shape не satisfies canonical TypedMessage (нет payload/metadata)
    const bad: TypedMessage = flat;
    void bad;
    expect(true).toBe(true);
  });

  it('envelope с optional metadata НЕ является TypedMessage (compile-time)', () => {
    interface LegacyEnvelope {
      readonly type: 'LEGACY';
      readonly payload: { readonly x: number };
      readonly metadata?: MessageMetadata;
    }
    const legacy: LegacyEnvelope = { type: 'LEGACY', payload: { x: 1 } };
    // @ts-expect-error — optional metadata запрещена canonical-контрактом
    const bad: TypedMessage = legacy;
    void bad;
    expect(true).toBe(true);
  });

  it('metadata имеет все обязательные поля (compile-time + runtime smoke)', () => {
    const metadata = fixtureMetadata();
    // Явное присваивание каждого обязательного поля — отсутствие любого из них
    // в контракте сломает эту строку компилятором.
    const requiredFields: {
      messageId: unknown;
      runId: unknown;
      sequence: number;
      createdAt: unknown;
      createdAtUnixSeconds: number;
      millisecondOfSecond: number;
      microsecondOfMillisecond: number;
      nanosecondOfMicrosecond: number;
      correlationId: unknown;
    } = metadata;
    expect(requiredFields.sequence).toBe(1);
    expect(requiredFields.createdAtUnixSeconds).toBe(1786668087);
    expect(requiredFields.millisecondOfSecond).toBe(123);
  });
});
