/**
 * Порт: ordered event outbox — публикация доменных событий БЕЗ удержания lock.
 *
 * @remarks
 * ### Зачем нужен:
 * `PlaceOrderUseCase` держит keyed mutex на время commit. Если публиковать
 * события ВНУТРИ lock (`await eventBus.publishAll` дренирует handlers синхронно),
 * возможен deadlock: handler ORDER_ACCEPTED вызывает Cancel/Place другого ордера
 * → тот ждёт тот же lock → зависание.
 *
 * Outbox разрывает эту связь: `enqueue()` под lock только кладёт batch в
 * per-aggregate FIFO-очередь и возвращается быстро (НЕ вызывает handlers).
 * `flush()` уже ПОСЛЕ выхода из lock дренирует очередь через реальную публикацию.
 *
 * ### Гарантия порядка:
 * Для одного `aggregateId` batches публикуются строго FIFO (в порядке `enqueue`).
 * Реализация обязана НЕ допускать конкурентный drain одного aggregateId. Это
 * сохраняет per-order порядок: `Fill` не опубликует `ORDER_FILLED` раньше
 * `ORDER_CREATED`/`ORDER_ACCEPTED` того же ордера, потому что keyed mutex
 * сериализует enqueue (Place enqueue-ит раньше Fill), а FIFO-drain это сохраняет.
 *
 * ### Ошибки публикации (durability):
 * Сбой публикации batch НЕ должен ломать committed business operation. Failed
 * batch остаётся в ГОЛОВЕ per-aggregate очереди (НЕ теряется) и блокирует более
 * поздние batches ТОГО ЖЕ aggregate (порядок), но НЕ мешает другим aggregate.
 * Реализация логирует ошибку и (если сконфигурирована с
 * `IReconciliationIssueRepository`) создаёт `EVENT_PUBLISH_FAILED` issue.
 * Следующий `flush()` повторяет head. In-memory реализация НЕ переживает process
 * restart (persistent outbox — вне scope; см. docs/architecture/ordered-event-outbox.md).
 *
 * ### enqueue vs business commit:
 * `enqueue` возвращает `Result`, но НЕ бросает: сбой enqueue ПОСЛЕ business
 * commit не должен превращать committed операцию в retryable. Caller при
 * `Err` создаёт `EVENT_PUBLISH_FAILED` issue (stage `outbox-enqueue`) и
 * продолжает. In-memory enqueue практически всегда возвращает `Ok`.
 *
 * @example
 * ```typescript
 * // Внутри lock:
 * const r = await outbox.enqueue({ aggregateId: String(venueOrderId), events });
 * if (!r.ok) { // issue + log, но business commit не откатывается }
 * // После выхода из lock:
 * await outbox.flush();
 * ```
 */
import type { Result } from '@polymarket/result';

/** Batch событий одного aggregate (публикуется атомарно и FIFO). */
export interface OrderedEventBatch {
  /** ID агрегата (обычно venueOrderId/orderId) — ключ FIFO-очереди. */
  readonly aggregateId: string;
  /** Версия агрегата (опционально, для диагностики). */
  readonly aggregateVersion?: number;
  /**
   * Доменные события. Тип намеренно `unknown[]` — порт не зависит от
   * `@polymarket/event-bus`; реализация приводит к `ApplicationEvent[]`.
   */
  readonly events: readonly unknown[];
}

/** Ошибка enqueue в outbox (например переполнение персистентной очереди). */
export class OutboxEnqueueError extends Error {
  /**
   * @param message - Описание (English)
   */
  constructor(message: string) {
    super(message);
    this.name = 'OutboxEnqueueError';
  }
}

/** Порт ordered event outbox. */
export interface IOrderedEventOutbox {
  /**
   * Кладёт batch в per-aggregate FIFO-очередь. НЕ публикует (не вызывает handlers).
   *
   * @param batch - Batch событий одного aggregateId
   * @returns `Ok` при успешной постановке в очередь, `Err(OutboxEnqueueError)`
   *   при сбое (caller не должен трактовать committed операцию как retryable).
   *   Никогда не бросает.
   */
  enqueue(batch: OrderedEventBatch): Promise<Result<void, OutboxEnqueueError>>;

  /**
   * Дренирует очереди, публикуя batches (FIFO per aggregateId). Вызывается
   * ПОСЛЕ выхода из lock. Никогда не бросает — ошибки публикации проглатываются
   * (failed batch остаётся в head + EVENT_PUBLISH_FAILED issue). Конкурентный
   * `flush()` одного aggregate использует общий single-flight drain.
   */
  flush(): Promise<void>;
}
