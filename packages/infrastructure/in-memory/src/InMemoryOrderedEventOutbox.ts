/**
 * InMemoryOrderedEventOutbox — ordered event outbox в памяти.
 *
 * @remarks
 * Реализует `IOrderedEventOutbox`. `enqueue()` кладёт batch в per-aggregate
 * FIFO-очередь (быстро, БЕЗ публикации). `flush()` дренирует очереди уже ПОСЛЕ
 * выхода из lock — публикует через инъецированный `publish` callback.
 *
 * ### Порядок и concurrency:
 * - На один `aggregateId` batches публикуются строго FIFO.
 * - Одновременный drain одного aggregateId исключён (`_draining` set): если
 *   `flush()` уже дренирует aggregate, повторный `flush()` для него — no-op
 *   (активный drain-loop подхватит новые batches из общей очереди).
 * - Разные aggregateId дренируются независимо (параллельно).
 *
 * ### Ошибки публикации:
 * `publish` callback может бросить — тогда batch НЕ теряет очередь безвозвратно:
 * ошибка логируется и (если передан `reconciliationIssues`) создаётся
 * `EVENT_PUBLISH_FAILED` issue. Drain продолжается со следующего batch — сбой
 * одного уведомления не должен блокировать остальные committed операции.
 *
 * ### Отличие от production:
 * Production использует персистентный outbox (Postgres/Redis) с at-least-once
 * доставкой и retry. In-memory — single-process/paper/backtest/тесты (потеря
 * очереди при рестарте допустима, business state уже committed).
 */
import type { OrderId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import { Ok } from '@polymarket/result';
import type { IOrderedEventOutbox, OrderedEventBatch, IReconciliationIssueRepository, OutboxEnqueueError } from '@polymarket/ports';

/** Минимальный logger-контракт (без зависимости на @polymarket/logger). */
interface OutboxLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости InMemoryOrderedEventOutbox. */
export interface InMemoryOrderedEventOutboxDeps {
  /**
   * Функция публикации batch событий. Обычно `(events) => eventBus.publishAll(events)`.
   * Инъекция callback'ом вместо `IEventBus` — чтобы пакет `@polymarket/in-memory`
   * не зависел от `@polymarket/event-bus`.
   */
  readonly publish: (events: readonly unknown[]) => Promise<void>;
  readonly logger: OutboxLogger;
  /** Опционально: создать EVENT_PUBLISH_FAILED issue при сбое публикации. */
  readonly reconciliationIssues?: IReconciliationIssueRepository;
  /** Источник времени для issue.createdAt (по умолчанию `() => new Date()`). */
  readonly now?: () => Date;
}

/** In-memory реализация ordered event outbox. */
export class InMemoryOrderedEventOutbox implements IOrderedEventOutbox {
  /** aggregateId → FIFO очередь batches */
  private readonly _queues = new Map<string, OrderedEventBatch[]>();
  /**
   * aggregateId → активный drain-promise (single-flight). Конкурентный `flush`
   * того же aggregate дожидается ЭТОТ promise вместо запуска второго drain.
   */
  private readonly _drainPromises = new Map<string, Promise<void>>();

  /**
   * @param _deps - Зависимости (publish, logger, reconciliationIssues, now)
   */
  constructor(private readonly _deps: InMemoryOrderedEventOutboxDeps) {}

  /**
   * Кладёт batch в per-aggregate FIFO-очередь. НЕ публикует.
   *
   * @param batch - Batch событий одного aggregateId
   * @returns `Ok` — in-memory очередь не переполняется. Никогда не бросает.
   */
  public async enqueue(batch: OrderedEventBatch): Promise<Result<void, OutboxEnqueueError>> {
    const queue = this._queues.get(batch.aggregateId);
    if (queue) {
      queue.push(batch);
    } else {
      this._queues.set(batch.aggregateId, [batch]);
    }
    return Ok(undefined);
  }

  /**
   * Дренирует все очереди (FIFO per aggregateId, параллельно между aggregate).
   *
   * @remarks
   * Никогда не бросает: ошибки публикации проглатываются в `_drainAggregate`.
   * Разные aggregate дренируются параллельно; один aggregate — single-flight.
   */
  public async flush(): Promise<void> {
    const aggregateIds = [...this._queues.keys()];
    await Promise.all(aggregateIds.map((id) => this._drainAggregate(id)));
  }

  /**
   * Дренирует очередь одного aggregateId строго FIFO (single-flight).
   *
   * @param aggregateId - ID агрегата
   * @returns Promise завершения активного drain
   *
   * @remarks
   * Если drain уже идёт — возвращает ТОТ ЖЕ promise (конкурентный caller ждёт
   * его, не запускает второй drain). При сбое публикации batch остаётся в ГОЛОВЕ
   * очереди (НЕ shift) и блокирует более поздние batches того же aggregate;
   * drain останавливается (следующий flush повторит head).
   */
  private _drainAggregate(aggregateId: string): Promise<void> {
    const active = this._drainPromises.get(aggregateId);
    if (active) return active;

    const promise = this._runDrain(aggregateId).finally(() => {
      this._drainPromises.delete(aggregateId);
    });
    this._drainPromises.set(aggregateId, promise);
    return promise;
  }

  /**
   * Loop публикации head-батчей одного aggregate до опустошения/сбоя.
   *
   * @param aggregateId - ID агрегата
   */
  private async _runDrain(aggregateId: string): Promise<void> {
    for (;;) {
      const queue = this._queues.get(aggregateId);
      if (!queue || queue.length === 0) {
        this._queues.delete(aggregateId);
        return;
      }
      // Читаем head БЕЗ удаления — shift только ПОСЛЕ успешной публикации.
      const batch = queue[0]!;
      try {
        await this._deps.publish(batch.events);
      } catch (err) {
        // Failed batch остаётся в head (порядок + durability): НЕ shift, стоп.
        // Следующий flush() повторит head.
        await this._onPublishError(batch, err);
        return;
      }
      queue.shift();
    }
  }

  /**
   * Обрабатывает сбой публикации head-batch: лог + best-effort EVENT_PUBLISH_FAILED issue.
   *
   * @param batch - Batch, публикация которого упала (остаётся в head)
   * @param err - Ошибка публикации
   *
   * @remarks
   * Id issue СТАБИЛЬНЫЙ per aggregate (`reconciliation:outbox:<id>:event-publish-failed`) —
   * `add()` идемпотентен, повторные flush-ретраи не плодят дубликаты.
   */
  private async _onPublishError(batch: OrderedEventBatch, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this._logger().error('EVENT_PUBLISH_FAILED: ordered outbox failed to publish head batch — batch retained for retry, manual replay may be required', {
      aggregateId: batch.aggregateId,
      eventCount: batch.events.length,
      error: message,
    });
    if (!this._deps.reconciliationIssues) return;
    try {
      await this._deps.reconciliationIssues.add({
        id: `reconciliation:outbox:${batch.aggregateId}:event-publish-failed`,
        type: 'EVENT_PUBLISH_FAILED',
        status: 'OPEN',
        reason: `EVENT_PUBLISH_FAILED: ordered outbox publish failed for aggregate ${batch.aggregateId}: ${message}`,
        createdAt: (this._deps.now ?? (() => new Date()))(),
        // aggregateId для order-domain events это venue orderId.
        orderId: batch.aggregateId as unknown as OrderId,
        context: {
          stage: 'ordered-outbox-flush',
          aggregateId: batch.aggregateId,
          eventCount: batch.events.length,
        },
      });
    } catch (issueErr) {
      this._logger().error('Failed to add EVENT_PUBLISH_FAILED issue from outbox', {
        aggregateId: batch.aggregateId,
        error: issueErr instanceof Error ? issueErr.message : String(issueErr),
      });
    }
  }

  private _logger(): OutboxLogger {
    return this._deps.logger;
  }

  /** Число незапубликованных batches (для тестов/диагностики). */
  public get pendingBatchCount(): number {
    let count = 0;
    for (const queue of this._queues.values()) count += queue.length;
    return count;
  }

  /** Очищает очереди (для тестов). */
  public clear(): void {
    this._queues.clear();
    this._drainPromises.clear();
  }
}
