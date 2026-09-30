/**
 * Тесты `IEventBus.publishConfirmed()` — подтверждённой публикации.
 *
 * @remarks
 * `publish()` при активном drain подтверждает только постановку в очередь.
 * `publishConfirmed()` обязан подтверждать исход ИМЕННО своего события:
 *
 * ```text
 * backlog / активный drain → дождаться; отказ backlog → событие НЕ в очереди
 * очередь пуста            → событие первое в новом drain → его исход
 * отказ позже в том же drain → исход события всё равно Ok
 * ```
 *
 * Порядок задаётся гейтами, а не таймерами: handler держит drain, пока тест
 * его не отпустит.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { KnownVenues, unsafeRunId } from '@polymarket/ids';
import type { ILogger } from '@polymarket/logger';
import { CriticalHandlerError, QueueOverflowError } from '@polymarket/errors/event-bus';
import type { BookUpdatedEvent } from '@polymarket/application-events';
import { EventBus } from '../src/EventBus.js';

function makeLogger(): ILogger & { error: jest.Mock } {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as ILogger & { error: jest.Mock };
}

/** Детерминированный canonical-генератор metadata тестовых событий. */
const METADATA_GENERATOR = new MessageMetadataGenerator({
  clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
  runId: unsafeRunId('confirm1'),
});

function bookEvent(sequenceNumber: number): BookUpdatedEvent {
  return {
    type: 'BOOK_UPDATED',
    payload: {
      venueId: KnownVenues.POLYMARKET,
      topOfBook: {
        bestBid: undefined,
        bestAsk: undefined,
        bestBidSize: undefined,
        bestAskSize: undefined,
      },
      instrumentId: 'token-123' as BookUpdatedEvent['payload']['instrumentId'],
      marketId: 'market-abc' as BookUpdatedEvent['payload']['marketId'],
      sequenceNumber,
      timestamp: { toISO: () => '' } as BookUpdatedEvent['payload']['timestamp'],
    },
    metadata: METADATA_GENERATOR.nextRoot(),
  };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Отпускает все поставленные микротаски. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('EventBus.publishConfirmed', () => {
  it('на свободной шине: Ok после завершения handlers события', async () => {
    const bus = new EventBus(makeLogger());
    const delivered: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      await Promise.resolve();
      delivered.push(event.payload.sequenceNumber);
    });

    const result = await bus.publishConfirmed(bookEvent(1));

    expect(result.ok).toBe(true);
    expect(delivered).toEqual([1]);
  });

  it('critical-отказ СВОЕГО события → Err c его messageId', async () => {
    const bus = new EventBus(makeLogger());
    bus.subscribe('BOOK_UPDATED', () => { throw new Error('rejected'); }, { critical: true });
    const event = bookEvent(1);

    const result = await bus.publishConfirmed(event);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(CriticalHandlerError);
      expect(result.error.context?.['messageId']).toBe(event.metadata.messageId);
    }
  });

  it('при активном drain НЕ резолвится до обработки своего события — в отличие от publish()', async () => {
    const bus = new EventBus(makeLogger());
    const hold = gate();
    const delivered: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      if (event.payload.sequenceNumber === 1) await hold.promise;
      delivered.push(event.payload.sequenceNumber);
    });

    const owner = bus.publish(bookEvent(1));
    await flush();

    // Обычный publish: Ok сразу, на постановку в очередь.
    const enqueued = await bus.publish(bookEvent(2));
    expect(enqueued.ok).toBe(true);
    expect(delivered).toEqual([]);

    let confirmedSettled = false;
    const confirmed = bus.publishConfirmed(bookEvent(3)).then((result) => {
      confirmedSettled = true;
      return result;
    });
    await flush();
    expect(confirmedSettled).toBe(false);

    hold.release();
    expect((await owner).ok).toBe(true);
    const result = await confirmed;

    expect(result.ok).toBe(true);
    // К моменту Ok своё событие обработано — и после всего backlog.
    expect(delivered).toEqual([1, 2, 3]);
  });

  it('backlog упал critical ДО постановки → Err с ЧУЖИМ messageId, своё событие не доставлено никогда', async () => {
    const bus = new EventBus(makeLogger());
    const hold = gate();
    const delivered: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      const seq = event.payload.sequenceNumber;
      if (seq === 1) await hold.promise;
      if (seq === 2) throw new Error('backlog rejected');
      delivered.push(seq);
    }, { critical: true });

    const owner = bus.publish(bookEvent(1));
    await flush();
    const foreign = bookEvent(2);
    await bus.publish(foreign);

    const own = bookEvent(3);
    const confirmed = bus.publishConfirmed(own);
    hold.release();
    await owner;
    const result = await confirmed;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(CriticalHandlerError);
      expect(result.error.context?.['messageId']).toBe(foreign.metadata.messageId);
      expect(result.error.context?.['messageId']).not.toBe(own.metadata.messageId);
    }
    // Своё событие НЕ осталось в очереди: следующий drain его не доставит.
    expect(bus.getStats().queueSize).toBe(0);
    expect((await bus.publish(bookEvent(4))).ok).toBe(true);
    expect(delivered).toEqual([1, 4]);
  });

  it('своё событие применилось, ПОСЛЕ него в том же drain упало другое → Ok, отказ залогирован', async () => {
    const logger = makeLogger();
    const bus = new EventBus(logger);
    const later = bookEvent(2);
    const delivered: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      const seq = event.payload.sequenceNumber;
      if (seq === 1) {
        // Reentrant-публикация встаёт в хвост ЭТОГО drain.
        await bus.publish(later);
      }
      if (seq === 2) throw new Error('later rejected');
      delivered.push(seq);
    }, { critical: true });

    const own = bookEvent(1);
    const result = await bus.publishConfirmed(own);

    expect(result.ok).toBe(true);
    expect(delivered).toEqual([1]);
    expect(logger.error).toHaveBeenCalledWith(
      'EventBus critical handler failed on a later event of a confirmed publication drain',
      expect.objectContaining({
        messageId: later.metadata.messageId,
        confirmedMessageId: own.metadata.messageId,
      }),
    );
  });

  it('лимит drain-цикла сработал ПОСЛЕ своего события → Ok (событие обработано первым)', async () => {
    const logger = makeLogger();
    const bus = new EventBus(logger, 1);
    const delivered: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      delivered.push(event.payload.sequenceNumber);
      await bus.publish(bookEvent(event.payload.sequenceNumber + 1));
    });

    const result = await bus.publishConfirmed(bookEvent(1));

    expect(result.ok).toBe(true);
    expect(delivered).toEqual([1]);
    expect(logger.error).toHaveBeenCalledWith(
      'EventBus drain limit exceeded after a confirmed publication was dispatched',
      expect.objectContaining({ maxEventsPerDrain: 1 }),
    );
  });

  it('лимит drain-цикла на backlog → Err(QueueOverflowError), своё событие не доставлено', async () => {
    const bus = new EventBus(makeLogger(), 1);
    const hold = gate();
    const delivered: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      if (event.payload.sequenceNumber === 1) await hold.promise;
      delivered.push(event.payload.sequenceNumber);
    });

    const owner = bus.publish(bookEvent(1));
    await flush();
    await bus.publish(bookEvent(2)); // backlog, который упрётся в лимит 1

    const confirmed = bus.publishConfirmed(bookEvent(3));
    hold.release();
    await owner;
    const result = await confirmed;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(QueueOverflowError);
    expect(bus.getStats().queueSize).toBe(0);
    await flush();
    expect(delivered).toEqual([1]);
  });

  it('обычный publish() из handler’а по-прежнему reentrant-safe', async () => {
    const bus = new EventBus(makeLogger());
    const delivered: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      delivered.push(event.payload.sequenceNumber);
      if (event.payload.sequenceNumber === 1) {
        const inner = await bus.publish(bookEvent(2));
        expect(inner.ok).toBe(true);
      }
    });

    const result = await bus.publishConfirmed(bookEvent(1));

    expect(result.ok).toBe(true);
    expect(delivered).toEqual([1, 2]);
  });
});
