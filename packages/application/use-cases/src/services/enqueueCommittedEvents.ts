/**
 * enqueueCommittedEvents — общий helper enqueue доменных событий ПОСЛЕ business commit.
 *
 * @remarks
 * ### Зачем нужен:
 * Place/Fill/Cancel/Update use-case'ы enqueue-ят события в ordered outbox
 * ВНУТРИ keyed mutex, а публикуют (`flush`) уже ПОСЛЕ выхода из lock. Сбой
 * `enqueue` происходит ПОСЛЕ business commit (Order/Portfolio/Ledger уже
 * изменены), поэтому он НЕ должен:
 * - бросать (сделал бы committed операцию похожей на retryable failure);
 * - откатывать состояние;
 * - вызывать `flush()` под lock.
 *
 * Вместо этого helper:
 * 1. Проверяет `Result` enqueue (и ловит неожиданный throw).
 * 2. Логирует `EVENT_PUBLISH_FAILED` (потеря уведомления, нужен ручной replay).
 * 3. Создаёт `EVENT_PUBLISH_FAILED` reconciliation issue (best-effort, если
 *    репозиторий передан) с детерминированным id.
 *
 * Гарантии outbox сохраняются: enqueue под mutex, flush после mutex, FIFO по
 * aggregate, failed head остаётся в очереди (см. `IOrderedEventOutbox`).
 *
 * @example
 * ```typescript
 * await enqueueCommittedEvents({
 *   outbox, logger, reconciliationIssues, now: clock.now(),
 *   aggregateId: String(orderId),
 *   events,
 *   issueContext: {
 *     issueId: `reconciliation:cancel:${String(orderId)}:outbox-enqueue-failed`,
 *     stage: 'outbox-enqueue',
 *     orderId, accountId,
 *   },
 * });
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { AccountId, FillId, InstrumentId, OrderId } from '@polymarket/ids';
import type {
  IOrderedEventOutbox,
  IReconciliationIssueRepository,
} from '@polymarket/ports';

/** Аргументы {@link enqueueCommittedEvents}. */
export interface EnqueueCommittedEventsArgs {
  /** Ordered event outbox (enqueue под lock, flush — вне helper'а). */
  readonly outbox: IOrderedEventOutbox;
  /** Logger вызывающего use case. */
  readonly logger: ILogger;
  /** Queryable хранилище issues (опционально — без него только логирование). */
  readonly reconciliationIssues?: IReconciliationIssueRepository | undefined;
  /** Момент для `ReconciliationIssue.createdAt`. */
  readonly now: Date;
  /** ID агрегата (обычно venueOrderId) — ключ FIFO-очереди outbox. */
  readonly aggregateId: string;
  /** Доменные события committed операции. */
  readonly events: readonly unknown[];
  /** Контекст issue при сбое enqueue. */
  readonly issueContext: {
    /** Детерминированный id issue (идемпотентность `add()`). */
    readonly issueId: string;
    /** Этап вызова (для context, например `outbox-enqueue`). */
    readonly stage: string;
    readonly orderId?: OrderId;
    readonly fillId?: FillId;
    readonly accountId?: AccountId;
    readonly instrumentId?: InstrumentId;
    /** Дополнительные non-sensitive поля context. */
    readonly extra?: Readonly<Record<string, string | number | boolean | null>>;
  };
}

/**
 * Enqueue-ит события committed операции в ordered outbox, обрабатывая сбой
 * как потерю уведомления (issue + лог), а НЕ как ошибку бизнес-операции.
 *
 * @param args - См. {@link EnqueueCommittedEventsArgs}
 * @returns Promise<void> — НИКОГДА не бросает
 *
 * @remarks
 * Пустой `events` — no-op. `flush()` намеренно НЕ вызывается (он должен
 * выполняться ПОСЛЕ выхода из mutex вызывающим `execute()`).
 */
export async function enqueueCommittedEvents(args: EnqueueCommittedEventsArgs): Promise<void> {
  if (args.events.length === 0) return;

  let errorMessage: string | undefined;
  try {
    const r = await args.outbox.enqueue({
      aggregateId: args.aggregateId,
      events: args.events,
    });
    if (r.ok) return;
    errorMessage = r.error.message;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  args.logger.error('EVENT_PUBLISH_FAILED: outbox enqueue failed after business commit — events lost, manual replay may be required', {
    aggregateId: args.aggregateId,
    stage: args.issueContext.stage,
    error: errorMessage,
  });

  if (!args.reconciliationIssues) return;
  try {
    await args.reconciliationIssues.add({
      id: args.issueContext.issueId,
      type: 'EVENT_PUBLISH_FAILED',
      status: 'OPEN',
      reason: `EVENT_PUBLISH_FAILED: outbox enqueue failed: ${errorMessage}`,
      createdAt: args.now,
      ...(args.issueContext.orderId ? { orderId: args.issueContext.orderId } : {}),
      ...(args.issueContext.fillId ? { fillId: args.issueContext.fillId } : {}),
      ...(args.issueContext.accountId ? { accountId: args.issueContext.accountId } : {}),
      ...(args.issueContext.instrumentId ? { instrumentId: args.issueContext.instrumentId } : {}),
      context: {
        stage: args.issueContext.stage,
        error: errorMessage ?? 'unknown',
        ...(args.issueContext.extra ?? {}),
      },
    });
  } catch (err) {
    args.logger.error('Failed to add EVENT_PUBLISH_FAILED reconciliation issue', {
      issueId: args.issueContext.issueId,
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
