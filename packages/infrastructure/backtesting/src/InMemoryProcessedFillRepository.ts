/**
 * InMemoryProcessedFillRepository — idempotency guard для Fill в памяти.
 *
 * @remarks
 * Реализует интерфейс `IProcessedFillRepository` на основе `Set<FillId>`.
 * Используется в `BacktestEngine` для предотвращения двойной обработки Fill.
 *
 * ### Семантика markIfNotExists:
 * - Атомарна в рамках Node.js single-thread — нет window между check и mark.
 * - `true` → fill помечен ВПЕРВЫЕ (нужно обрабатывать).
 * - `false` → fill уже был помечен ранее (дубликат, пропустить).
 *
 * ### Отличие от production реализации:
 * Production использует Redis SETNX + TTL или PostgreSQL unique constraint
 * для поддержки multi-process и персистентности.
 * In-memory реализация подходит только для бектеста и юнит-тестов.
 *
 * @example
 * ```typescript
 * const repo = new InMemoryProcessedFillRepository();
 *
 * const isNew = await repo.markIfNotExists(fillId);
 * if (isNew) {
 *   // Первый раз — обрабатываем fill
 * }
 *
 * const isDuplicate = !(await repo.markIfNotExists(fillId));
 * // isDuplicate === true, fill уже был помечен
 * ```
 */
import type { FillId } from '@polymarket/ids';
import type { IProcessedFillRepository } from '@polymarket/ports';

/**
 * In-memory реализация idempotency guard для Fill-событий.
 *
 * @remarks
 * Хранит ID обработанных Fill в `Set<FillId>`.
 * Не персистентна — при перезапуске бектеста все Fill считаются новыми.
 */
export class InMemoryProcessedFillRepository implements IProcessedFillRepository {
  /** Множество обработанных FillId */
  private readonly _processed = new Set<FillId>();

  /**
   * Атомарно помечает fill как обработанный.
   *
   * @remarks
   * Алгоритм:
   * 1. Проверяем наличие fillId в Set.
   * 2. Если нет — добавляем в Set, возвращаем true.
   * 3. Если есть — возвращаем false (дубликат).
   *
   * @param fillId - ID fill-события
   * @returns true если fill помечен впервые, false если уже был помечен (дубликат)
   *
   * @example
   * ```typescript
   * const isNew = await repo.markIfNotExists(fillId);
   * if (!isNew) {
   *   logger.debug('Duplicate fill, skipping', { fillId });
   *   return;
   * }
   * // обрабатываем fill
   * ```
   */
  public async markIfNotExists(fillId: FillId): Promise<boolean> {
    if (this._processed.has(fillId)) {
      return false;
    }
    this._processed.add(fillId);
    return true;
  }

  /**
   * Проверяет, был ли fill обработан ранее.
   *
   * @remarks
   * Вспомогательный метод для тестовых assertions.
   * Не меняет состояние Set — только читает.
   *
   * @param fillId - ID fill-события
   * @returns true если fill уже был помечен как обработанный
   *
   * @example
   * ```typescript
   * await repo.markIfNotExists(fillId);
   * expect(repo.has(fillId)).toBe(true);
   * ```
   */
  public has(fillId: FillId): boolean {
    return this._processed.has(fillId);
  }

  /**
   * Возвращает количество обработанных Fill.
   *
   * @remarks
   * Вспомогательный метод для тестовых assertions.
   *
   * @returns Количество уникальных FillId в Set
   *
   * @example
   * ```typescript
   * expect(repo.size).toBe(5);
   * ```
   */
  public get size(): number {
    return this._processed.size;
  }

  /**
   * Очищает хранилище обработанных Fill.
   *
   * @remarks
   * Используется в тестах для сброса состояния между тестами.
   *
   * @example
   * ```typescript
   * beforeEach(() => repo.clear());
   * ```
   */
  public clear(): void {
    this._processed.clear();
  }
}
