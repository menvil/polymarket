/**
 * InMemoryProcessedFillRepository — idempotency + lifecycle guard для Fill в памяти.
 *
 * @remarks
 * Реализует интерфейс `IProcessedFillRepository` на основе `Map<FillId, ProcessedFillStatus>`.
 * Используется в `BacktestEngine` и live/paper режимах бота для предотвращения
 * двойной обработки Fill и разрешения retry после сбоя обработки.
 *
 * ### Семантика begin():
 * - Ключа нет → ставим `PROCESSING`, возвращаем `{ outcome: 'ACQUIRED', isRetry: false }`.
 * - `APPLIED` → возвращаем `{ outcome: 'DUPLICATE' }` (не трогаем состояние).
 * - `PROCESSING` → возвращаем `{ outcome: 'BUSY' }` (конкурентная обработка).
 * - `FAILED` / `REVERTED` → ставим `PROCESSING`, возвращаем
 *   `{ outcome: 'ACQUIRED', isRetry: true }` (retry разрешён).
 * - `RECONCILIATION_REQUIRED` → возвращаем `{ outcome: 'RECONCILIATION_REQUIRED' }` (терминально, retry НЕ
 *   разрешён — не трогаем состояние; см. `markReconciliationRequired()`).
 *
 * ### Отличие от production реализации:
 * Production использует Redis (SETNX/Lua CAS) или PostgreSQL (unique constraint
 * + status column) для поддержки multi-process и персистентности.
 * In-memory реализация подходит только для бектеста, paper/live single-process
 * режима и юнит-тестов.
 *
 * @example
 * ```typescript
 * const repo = new InMemoryProcessedFillRepository();
 *
 * const begin = await repo.begin(fillId);
 * if (begin.outcome === 'ACQUIRED') {
 *   try {
 *     // ... применяем fill ...
 *     await repo.markApplied(fillId);
 *   } catch (err) {
 *     await repo.markFailed(fillId, String(err));
 *   }
 * }
 * ```
 */
import type { FillId } from '@polymarket/ids';
import type {
  IProcessedFillRepository,
  ProcessedFillStatus,
  BeginFillProcessingResult,
} from '@polymarket/ports';

/**
 * In-memory реализация idempotency + lifecycle guard для Fill-событий.
 *
 * @remarks
 * Хранит статус каждого FillId в `Map<FillId, ProcessedFillStatus>`.
 * Не персистентна — при перезапуске бектеста/бота все Fill считаются новыми.
 */
export class InMemoryProcessedFillRepository implements IProcessedFillRepository {
  /** FillId → текущий статус обработки */
  private readonly _statuses = new Map<FillId, ProcessedFillStatus>();

  /**
   * Атомарно резервирует fillId под обработку.
   *
   * @param fillId - ID fill-события
   * @returns `BeginFillProcessingResult` — см. диаграмму переходов в doc порта
   *
   * @example
   * ```typescript
   * const begin = await repo.begin(fillId);
   * if (begin.outcome === 'DUPLICATE') return Ok(undefined);
   * if (begin.outcome === 'BUSY') return Ok(undefined);
   * // begin.outcome === 'ACQUIRED'
   * ```
   */
  public async begin(fillId: FillId): Promise<BeginFillProcessingResult> {
    const current = this._statuses.get(fillId);

    if (current === 'APPLIED') {
      return { outcome: 'DUPLICATE' };
    }
    if (current === 'PROCESSING') {
      return { outcome: 'BUSY' };
    }
    if (current === 'RECONCILIATION_REQUIRED') {
      return { outcome: 'RECONCILIATION_REQUIRED' };
    }

    const isRetry = current === 'FAILED' || current === 'REVERTED';
    this._statuses.set(fillId, 'PROCESSING');
    return { outcome: 'ACQUIRED', isRetry };
  }

  /**
   * Помечает fill как успешно применённый.
   *
   * @param fillId - ID fill-события
   */
  public async markApplied(fillId: FillId): Promise<void> {
    this._statuses.set(fillId, 'APPLIED');
  }

  /**
   * Помечает fill как неудачно обработанный — разрешает retry через `begin()`.
   *
   * @param fillId - ID fill-события
   * @param _reason - Причина ошибки (не хранится in-memory реализацией;
   *   ожидается, что caller уже залогировал её отдельно)
   */
  public async markFailed(fillId: FillId, _reason: string): Promise<void> {
    this._statuses.set(fillId, 'FAILED');
  }

  /**
   * Помечает ранее применённый fill как откаченный (FILL_FAILED rollback).
   *
   * @param fillId - ID fill-события
   */
  public async markReverted(fillId: FillId): Promise<void> {
    this._statuses.set(fillId, 'REVERTED');
  }

  /**
   * Помечает fill как заблокированный из-за частичного commit — retry НЕ разрешён.
   *
   * @param fillId - ID fill-события
   * @param _reason - Причина (не хранится in-memory реализацией; ожидается,
   *   что caller уже залогировал её отдельно для алертинга/ручной реконсиляции)
   */
  public async markReconciliationRequired(fillId: FillId, _reason: string): Promise<void> {
    this._statuses.set(fillId, 'RECONCILIATION_REQUIRED');
  }

  /**
   * Возвращает текущий статус fillId.
   *
   * @param fillId - ID fill-события
   * @returns Текущий `ProcessedFillStatus`, либо `undefined` если fillId неизвестен
   */
  public async getStatus(fillId: FillId): Promise<ProcessedFillStatus | undefined> {
    return this._statuses.get(fillId);
  }

  /**
   * Возвращает количество отслеживаемых Fill (в любом статусе).
   *
   * @remarks
   * Вспомогательный метод для тестовых assertions.
   *
   * @returns Количество уникальных FillId в хранилище
   */
  public get size(): number {
    return this._statuses.size;
  }

  /**
   * Очищает хранилище.
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
    this._statuses.clear();
  }
}
