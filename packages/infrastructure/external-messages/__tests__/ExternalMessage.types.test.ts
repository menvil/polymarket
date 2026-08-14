/**
 * Type-contract тесты `@polymarket/external-messages`.
 *
 * @remarks
 * Контракт types-only, поэтому настоящие проверки — compile-time
 * (typecheck/ts-jest): обязательность всех трёх полей canonical-конверта,
 * запрет flat-форм, строгая типизация source-native payload и то, что
 * `ExternalMessage` — именно specialization `MessageEnvelope`, а не второй
 * envelope. Runtime-ассерты минимальны.
 */
import { describe, it, expect } from '@jest/globals';
import { unsafeMessageId, unsafeRunId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import type { MessageEnvelope, MessageMetadata, TypedMessage } from '@polymarket/messages';
import type { ExternalMessage, AnyExternalMessage } from '../src/index.js';

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

/** Тестовый union внешних сообщений — source-native payload у каждого члена. */
type TestExternalMessage =
  | ExternalMessage<
      'BOOK',
      {
        readonly marketId: string;
        readonly bids: readonly number[];
      }
    >
  | ExternalMessage<
      'TRADE',
      {
        readonly price: number;
      }
    >;

type BookExternalMessage = Extract<TestExternalMessage, { type: 'BOOK' }>;

describe('ExternalMessage canonical envelope contract', () => {
  it('canonical-форма { type, payload, metadata } принимается', () => {
    const message = {
      type: 'BOOK',
      payload: { marketId: 'market-1', bids: [0.41, 0.4] },
      metadata: fixtureMetadata(),
    } satisfies BookExternalMessage;

    expect(message.type).toBe('BOOK');
    expect(message.payload.bids).toEqual([0.41, 0.4]);
    expect(message.metadata.sequence).toBe(1);
  });

  it('flat-форма { type, marketId } запрещена (compile-time)', () => {
    // @ts-expect-error — flat shape запрещена: source-native поля живут в payload
    const bad: BookExternalMessage = { type: 'BOOK', marketId: 'market-1', bids: [] };
    void bad;
    expect(true).toBe(true);
  });

  it('metadata ОБЯЗАТЕЛЬНА (compile-time)', () => {
    // @ts-expect-error — metadata required, canonical envelope без неё не существует
    const bad: BookExternalMessage = {
      type: 'BOOK',
      payload: { marketId: 'market-1', bids: [] },
    };
    void bad;
    expect(true).toBe(true);
  });

  it('payload ОБЯЗАТЕЛЕН (compile-time)', () => {
    // @ts-expect-error — payload required
    const bad: BookExternalMessage = {
      type: 'BOOK',
      metadata: fixtureMetadata(),
    };
    void bad;
    expect(true).toBe(true);
  });

  it('неизвестное top-level поле отклоняется (compile-time)', () => {
    const bad = {
      type: 'BOOK',
      payload: { marketId: 'market-1', bids: [] },
      metadata: fixtureMetadata(),
      // @ts-expect-error — source/channel/transport НЕ являются полями конверта
      source: 'polymarket',
    } satisfies BookExternalMessage;
    void bad;
    expect(true).toBe(true);
  });

  it('несоответствующий payload отклоняется (compile-time)', () => {
    const bad: BookExternalMessage = {
      type: 'BOOK',
      // @ts-expect-error — payload TRADE не подходит члену BOOK
      payload: { price: 0.41 },
      metadata: fixtureMetadata(),
    };
    void bad;

    const badField = {
      type: 'BOOK',
      // @ts-expect-error — bids обязано быть readonly number[], не string[]
      payload: { marketId: 'market-1', bids: ['0.41'] },
      metadata: fixtureMetadata(),
    } satisfies BookExternalMessage;
    void badField;
    expect(true).toBe(true);
  });

  it('неизвестное поле payload отклоняется excess property check (compile-time)', () => {
    const bad = {
      type: 'TRADE',
      // @ts-expect-error — unknown field в source-native payload отклоняется
      payload: { price: 0.41, venue: 'polymarket' },
      metadata: fixtureMetadata(),
    } satisfies TestExternalMessage;
    void bad;
    expect(true).toBe(true);
  });
});

describe('ExternalMessage = specialization MessageEnvelope', () => {
  it('ExternalMessage структурно совпадает с MessageEnvelope (compile-time)', () => {
    type ViaEnvelope = MessageEnvelope<'BOOK', { readonly marketId: string; readonly bids: readonly number[] }>;
    const toEnvelope = (message: BookExternalMessage): ViaEnvelope => message;
    const fromEnvelope = (envelope: ViaEnvelope): BookExternalMessage => envelope;
    expect(typeof toEnvelope).toBe('function');
    expect(typeof fromEnvelope).toBe('function');
  });

  it('любое внешнее сообщение является canonical TypedMessage (compile-time)', () => {
    const widen = (message: TestExternalMessage): TypedMessage => message;
    expect(typeof widen).toBe('function');
  });

  it('metadata остаётся canonical MessageMetadata (compile-time)', () => {
    const message: BookExternalMessage = {
      type: 'BOOK',
      payload: { marketId: 'market-1', bids: [] },
      metadata: fixtureMetadata(),
    };
    // Присваивание в canonical-тип: ExternalMessage не подменяет metadata-контракт
    const metadata: MessageMetadata = message.metadata;
    expect(metadata.correlationId).toBe(metadata.messageId);
  });

  it('TMetadata ограничен MessageMetadata (compile-time)', () => {
    interface TransportMetadata extends MessageMetadata {
      readonly transportSeq: number;
    }
    type WithSuperset = ExternalMessage<'BOOK', { readonly raw: string }, TransportMetadata>;
    const message: WithSuperset = {
      type: 'BOOK',
      payload: { raw: '{}' },
      metadata: { ...fixtureMetadata(), transportSeq: 7 },
    };
    void message;

    // @ts-expect-error — произвольный не-superset тип metadata запрещён
    type _Invalid = ExternalMessage<'BOOK', unknown, { readonly source: string }>;

    expect(true).toBe(true);
  });
});

describe('AnyExternalMessage generic bound', () => {
  it('конкретное внешнее сообщение присваивается bound-у (compile-time)', () => {
    const widen = (message: TestExternalMessage): AnyExternalMessage => message;
    expect(typeof widen).toBe('function');
  });

  it('flat-сообщение НЕ является AnyExternalMessage (compile-time)', () => {
    const flat = { type: 'BOOK', marketId: 'market-1' } as const;
    // @ts-expect-error — нет payload/metadata: конверт обязателен и для bound-а
    const bad: AnyExternalMessage = flat;
    void bad;
    expect(true).toBe(true);
  });

  it('bound НЕ даёт narrowing — payload остаётся unknown (compile-time)', () => {
    const message: AnyExternalMessage = {
      type: 'BOOK',
      payload: { marketId: 'market-1', bids: [] },
      metadata: fixtureMetadata(),
    };
    // @ts-expect-error — payload widened до unknown: bound не заменяет типизацию
    const bids = message.payload.bids;
    void bids;
    expect(message.type).toBe('BOOK');
  });
});
