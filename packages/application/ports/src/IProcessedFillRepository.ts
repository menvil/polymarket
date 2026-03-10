/**
 * Порт: idempotency guard для предотвращения двойной обработки Fill.
 *
 * @remarks
 * ### Почему async (отличие от синхронной версии):
 * Синхронная версия атомарна только в Node.js single-thread.
 * При worker_threads или multi-process (несколько экземпляров бота)
 * синхронная in-memory реализация не даёт гарантий.
 * Async позволяет реализовать через:
 * - Redis SETNX + TTL (production)
 * - PostgreSQL unique constraint (production)
 * - In-memory Set (development/testing)
 *
 * ### Семантика markIfNotExists:
 * Атомарна — нет window между check и mark.
 * - `true` → fill помечен ВПЕРВЫЕ (нужно обрабатывать)
 * - `false` → fill уже был помечен ранее (дубликат, пропустить)
 *
 * @example
 * ```typescript
 * const isNew = await fillRepo.markIfNotExists(fill.id);
 * if (!isNew) {
 *   logger.debug('Duplicate fill, skipping', { fillId: fill.id });
 *   return;
 * }
 * // обрабатываем fill
 * ```
 */
import type { FillId } from '@polymarket/ids';

export interface IProcessedFillRepository {
  /**
   * Атомарно помечает fill как обработанный.
   *
   * @param fillId - ID fill-события
   * @returns true если fill помечен впервые, false если уже был помечен (дубликат)
   */
  markIfNotExists(fillId: FillId): Promise<boolean>;
}
