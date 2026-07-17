import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InMemoryOrderedEventOutbox } from '../src/InMemoryOrderedEventOutbox.js';
import { InMemoryReconciliationIssueRepository } from '../src/InMemoryReconciliationIssueRepository.js';

/**
 * Простой logger-стаб (собирает error-вызовы).
 */
function makeLogger() {
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  return {
    errors,
    error: (message: string, meta?: Record<string, unknown>) => {
      errors.push({ message, meta });
    },
  };
}

const NOW = new Date('2024-01-01T00:00:00.000Z');

describe('InMemoryOrderedEventOutbox', () => {
  let issues: InMemoryReconciliationIssueRepository;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    issues = new InMemoryReconciliationIssueRepository();
    logger = makeLogger();
  });

  it('enqueue() НЕ публикует до flush()', async () => {
    const publish = jest.fn(async () => {});
    const outbox = new InMemoryOrderedEventOutbox({ publish, logger, now: () => NOW });

    await outbox.enqueue({ aggregateId: 'order-1', events: [{ type: 'A' }] });
    expect(publish).not.toHaveBeenCalled();
    expect(outbox.pendingBatchCount).toBe(1);

    await outbox.flush();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(outbox.pendingBatchCount).toBe(0);
  });

  it('flush() публикует batches одного aggregateId строго FIFO', async () => {
    const published: unknown[][] = [];
    const publish = jest.fn(async (events: readonly unknown[]) => {
      published.push([...events]);
    });
    const outbox = new InMemoryOrderedEventOutbox({ publish, logger, now: () => NOW });

    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 1 }] });
    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 2 }] });
    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 3 }] });
    await outbox.flush();

    expect(published).toEqual([[{ n: 1 }], [{ n: 2 }], [{ n: 3 }]]);
  });

  it('разные aggregateId дренируются независимо (оба публикуются)', async () => {
    const seen = new Set<string>();
    const publish = jest.fn(async (events: readonly unknown[]) => {
      seen.add((events[0] as { agg: string }).agg);
    });
    const outbox = new InMemoryOrderedEventOutbox({ publish, logger, now: () => NOW });

    await outbox.enqueue({ aggregateId: 'order-1', events: [{ agg: 'order-1' }] });
    await outbox.enqueue({ aggregateId: 'order-2', events: [{ agg: 'order-2' }] });
    await outbox.flush();

    expect(seen).toEqual(new Set(['order-1', 'order-2']));
    expect(outbox.pendingBatchCount).toBe(0);
  });

  it('enqueue() возвращает Ok (Result-контракт)', async () => {
    const publish = jest.fn(async () => {});
    const outbox = new InMemoryOrderedEventOutbox({ publish, logger, now: () => NOW });
    const r = await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 1 }] });
    expect(r.ok).toBe(true);
  });

  it('сбой publish head → batch ОСТАЁТСЯ в head, блокирует более поздние того же aggregate, issue', async () => {
    const publish = jest.fn(async (events: readonly unknown[]) => {
      // Первый batch (n:1) всегда падает.
      if ((events[0] as { n: number }).n === 1) throw new Error('bus down');
    });
    const outbox = new InMemoryOrderedEventOutbox({
      publish,
      logger,
      reconciliationIssues: issues,
      now: () => NOW,
    });

    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 1 }] });
    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 2 }] });
    await outbox.flush();

    // Head (n:1) упал → остался в очереди; n:2 НЕ опубликован (порядок).
    expect(publish).toHaveBeenCalledTimes(1);
    expect(outbox.pendingBatchCount).toBe(2);

    // Лог + issue со СТАБИЛЬНЫМ id (без seq).
    expect(logger.errors.some((e) => e.message.startsWith('EVENT_PUBLISH_FAILED'))).toBe(true);
    const open = await issues.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.type).toBe('EVENT_PUBLISH_FAILED');
    expect(open[0]!.id).toBe('reconciliation:outbox:order-1:event-publish-failed');
  });

  it('следующий flush повторяет head и после успеха публикует остальные FIFO', async () => {
    const published: number[] = [];
    let failFirst = true;
    const publish = jest.fn(async (events: readonly unknown[]) => {
      const n = (events[0] as { n: number }).n;
      if (n === 1 && failFirst) throw new Error('bus down');
      published.push(n);
    });
    const outbox = new InMemoryOrderedEventOutbox({ publish, logger, reconciliationIssues: issues, now: () => NOW });

    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 1 }] });
    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 2 }] });
    await outbox.flush(); // n:1 падает, ничего не опубликовано
    expect(published).toEqual([]);

    failFirst = false;
    await outbox.flush(); // retry head n:1 → успех → n:2
    expect(published).toEqual([1, 2]);
    expect(outbox.pendingBatchCount).toBe(0);
  });

  it('failed batch одного aggregate НЕ блокирует другой aggregate', async () => {
    const published: string[] = [];
    const publish = jest.fn(async (events: readonly unknown[]) => {
      const agg = (events[0] as { agg: string }).agg;
      if (agg === 'order-1') throw new Error('bus down');
      published.push(agg);
    });
    const outbox = new InMemoryOrderedEventOutbox({ publish, logger, reconciliationIssues: issues, now: () => NOW });

    await outbox.enqueue({ aggregateId: 'order-1', events: [{ agg: 'order-1' }] });
    await outbox.enqueue({ aggregateId: 'order-2', events: [{ agg: 'order-2' }] });
    await outbox.flush();

    // order-2 опубликован несмотря на застрявший order-1.
    expect(published).toEqual(['order-2']);
    // order-1 остался в очереди.
    expect(outbox.pendingBatchCount).toBe(1);
  });

  it('flush() никогда не бросает, даже если publish бросает всегда', async () => {
    const publish = jest.fn(async () => {
      throw new Error('always fails');
    });
    const outbox = new InMemoryOrderedEventOutbox({
      publish,
      logger,
      reconciliationIssues: issues,
      now: () => NOW,
    });

    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 1 }] });
    await expect(outbox.flush()).resolves.toBeUndefined();
    // Всегда падающий publish → batch остаётся в head (durability, не потерян).
    expect(outbox.pendingBatchCount).toBe(1);
  });

  it('конкурентный flush() одного aggregateId не публикует batches дважды', async () => {
    const published: unknown[][] = [];
    // publish с искусственной задержкой — окно для гонки flush().
    const publish = jest.fn(async (events: readonly unknown[]) => {
      await new Promise((r) => setTimeout(r, 5));
      published.push([...events]);
    });
    const outbox = new InMemoryOrderedEventOutbox({ publish, logger, now: () => NOW });

    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 1 }] });
    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 2 }] });

    // Два flush() параллельно: второй должен быть no-op для order-1 (drain уже идёт).
    await Promise.all([outbox.flush(), outbox.flush()]);

    expect(published).toEqual([[{ n: 1 }], [{ n: 2 }]]);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('clear() очищает очереди', async () => {
    const publish = jest.fn(async () => {});
    const outbox = new InMemoryOrderedEventOutbox({ publish, logger, now: () => NOW });

    await outbox.enqueue({ aggregateId: 'order-1', events: [{ n: 1 }] });
    outbox.clear();
    expect(outbox.pendingBatchCount).toBe(0);

    await outbox.flush();
    expect(publish).not.toHaveBeenCalled();
  });
});
