/**
 * Порт: idempotency + lifecycle guard для обработки Fill.
 *
 * @remarks
 * ### Почему async (отличие от синхронной версии):
 * Синхронная версия атомарна только в Node.js single-thread.
 * При worker_threads или multi-process (несколько экземпляров бота)
 * синхронная in-memory реализация не даёт гарантий.
 * Async позволяет реализовать через:
 * - Redis SETNX + TTL (production)
 * - PostgreSQL unique constraint + status column (production)
 * - In-memory Map (development/testing)
 *
 * ### Почему state machine, а не boolean:
 * Старая версия (`markIfNotExists(fillId): Promise<boolean>`) помечала fill
 * как «обработанный» ДО фактического применения к Order/Portfolio/Ledger —
 * poisoned idempotency key: если применение упадёт на середине, fill навсегда
 * считается обработанным и повторная попытка (retry) невозможна.
 *
 * `begin()` резервирует fillId под обработку (`PROCESSING`), но не считает его
 * обработанным. Только явный `markApplied()` — после успешного применения всех
 * state-мутаций — переводит fill в терминальное `APPLIED`. Если обработка упала —
 * `markFailed()` переводит в `FAILED`, откуда `begin()` разрешит повторную попытку.
 *
 * ### Диаграмма переходов:
 * ```
 *          begin()                    markApplied()
 * (none) ────────────► PROCESSING ────────────────► APPLIED
 *           ACQUIRED        │
 *                            │ markFailed(reason)
 *                            ▼
 *                          FAILED ──────begin()──────► PROCESSING (retry, ACQUIRED)
 *                            │
 *                            │ markReconciliationRequired(reason)
 *                            │ (частичный commit — retry не восстановит)
 *                            ▼
 *                          RECONCILIATION_REQUIRED ──begin()──► RECONCILIATION_REQUIRED
 *                                                                (НЕ retryable)
 *
 * APPLIED ──markReverted()──► REVERTED ──────begin()──────► PROCESSING (retry, ACQUIRED)
 * ```
 *
 * `begin()` на `PROCESSING` возвращает `BUSY` (не пере-запускает — предотвращает
 * конкурентную двойную обработку одного и того же fillId).
 * `begin()` на `APPLIED` возвращает `DUPLICATE` (fill уже применён — не трогаем).
 * `begin()` на `RECONCILIATION_REQUIRED` возвращает `RECONCILIATION_REQUIRED`
 * (терминально, retry НЕ разрешён — см. `markReconciliationRequired()`).
 *
 * ### Почему RECONCILIATION_REQUIRED отдельно от FAILED:
 * `FAILED` подразумевает «состояние не изменилось, retry безопасен и может помочь».
 * Но есть failure-сценарий, где это неверно: `ProcessFillUseCase` может успеть
 * сохранить обновлённый Order (`saveSync`) и только ПОТОМ упасть на
 * `PortfolioService.applyFill()`. Order уже применил этот fillId и defends
 * против повторного применения — значит retry такого fillId ГАРАНТИРОВАННО
 * упадёт на "duplicate fill" в Order и никогда не восстановит Portfolio.
 * Если бы это было `FAILED`, `begin()` разрешал бы бессмысленный retry вечно,
 * маскируя истинную причину. `markReconciliationRequired()` — терминальный
 * статус, откуда `begin()` НЕ выдаёт `ACQUIRED`: требуется явное вмешательство
 * (ручная реконсиляция Order↔Portfolio), а не автоматический retry.
 *
 * @example
 * ```typescript
 * const begin = await fillRepo.begin(fill.id);
 * if (begin.outcome === 'DUPLICATE') {
 *   logger.debug('Fill already applied, skipping', { fillId: fill.id });
 *   return Ok(undefined);
 * }
 * if (begin.outcome === 'BUSY') {
 *   logger.warn('Fill already being processed concurrently, skipping', { fillId: fill.id });
 *   return Ok(undefined);
 * }
 * if (begin.outcome === 'RECONCILIATION_REQUIRED') {
 *   logger.error('Fill requires manual reconciliation, skipping', { fillId: fill.id });
 *   return Ok(undefined);
 * }
 * // begin.outcome === 'ACQUIRED' (begin.isRetry === true если предыдущая попытка упала)
 * try {
 *   // ... применяем fill к Order/Portfolio/Ledger ...
 *   await fillRepo.markApplied(fill.id);
 * } catch (err) {
 *   await fillRepo.markFailed(fill.id, String(err));
 *   throw err;
 * }
 * ```
 */
import type { FillId } from '@polymarket/ids';

/** Статусы жизненного цикла обработки Fill. */
export type ProcessedFillStatus =
  | 'PROCESSING'
  | 'APPLIED'
  | 'FAILED'
  | 'REVERTED'
  | 'RECONCILIATION_REQUIRED';

/**
 * Lease-параметры `begin()` — recovery устаревшего `PROCESSING`.
 *
 * @remarks
 * Без lease крэш/зависание worker-а между `begin()` и `mark*()` оставляет fill
 * навсегда `PROCESSING` (`BUSY` для всех последующих попыток). С lease
 * просроченная запись (`now > leaseUntil`) reclaim-ится новым `begin()`.
 * Для single-process in-memory реализации достаточно clock-based lease;
 * персистентная реализация обязана делать acquire/reclaim атомарно (например,
 * `UPDATE ... WHERE lease_until < now` + инкремент fencing token) и отклонять
 * `mark*` со старым token.
 */
export interface FillProcessingLease {
  /** Идентификатор worker-а, захватывающего lease */
  readonly workerId: string;
  /** Текущее время (сравнение с leaseUntil предыдущего держателя) */
  readonly now: Date;
  /** Длительность lease (мс): leaseUntil = now + leaseMs */
  readonly leaseMs: number;
}

/**
 * Результат `begin()`.
 *
 * @remarks
 * `ACQUIRED` — caller обязан довести обработку до `markApplied()`, `markFailed()`
 * или `markReconciliationRequired()`.
 * `isRetry: true` означает, что предыдущая попытка обработки этого fillId
 * закончилась `FAILED` или `REVERTED` — это не первая попытка.
 * `reclaimed: true` — предыдущая попытка зависла в `PROCESSING`, её lease истёк
 * и запись перехвачена (см. {@link FillProcessingLease}).
 * `leaseToken` — монотонный fencing token захвата (растёт при каждом
 * acquire/reclaim); защита от «воскресшего» старого worker-а в персистентной
 * реализации.
 * `RECONCILIATION_REQUIRED` — terminal, retry НЕ разрешён: частичный commit
 * оставил Order/Portfolio рассинхронизированными, нужна ручная реконсиляция
 * (см. `markReconciliationRequired()`).
 */
export type BeginFillProcessingResult =
  | {
      readonly outcome: 'ACQUIRED';
      readonly isRetry: boolean;
      readonly reclaimed?: boolean;
      readonly leaseToken?: number;
    }
  | { readonly outcome: 'DUPLICATE' }
  | { readonly outcome: 'BUSY' }
  | { readonly outcome: 'RECONCILIATION_REQUIRED' };

/** Порт idempotency/lifecycle-guard для обработки Fill — см. описание модуля выше. */
export interface IProcessedFillRepository {
  /**
   * Атомарно резервирует fillId под обработку.
   *
   * @param fillId - ID fill-события
   * @param lease - Опциональный lease: с ним просроченный `PROCESSING`
   *   reclaim-ится вместо вечного `BUSY` (см. {@link FillProcessingLease})
   * @returns `BeginFillProcessingResult` — см. диаграмму переходов в doc пакета
   */
  begin(fillId: FillId, lease?: FillProcessingLease): Promise<BeginFillProcessingResult>;

  /**
   * Помечает fill как успешно применённый (терминальный статус).
   *
   * @param fillId - ID fill-события
   *
   * @remarks
   * Вызывать ТОЛЬКО после того, как все state-мутации (Order/Portfolio/Ledger)
   * реально применены. До этого момента fillId должен оставаться `PROCESSING`.
   */
  markApplied(fillId: FillId): Promise<void>;

  /**
   * Помечает fill как неудачно обработанный — разрешает retry через `begin()`.
   *
   * @param fillId - ID fill-события
   * @param reason - Причина ошибки (для диагностики/логов)
   */
  markFailed(fillId: FillId, reason: string): Promise<void>;

  /**
   * Помечает ранее применённый fill как откаченный (FILL_FAILED rollback).
   *
   * @param fillId - ID fill-события
   *
   * @remarks
   * Из `REVERTED` `begin()` тоже разрешает retry — например, если тот же
   * fillId придёт повторно после on-chain revert.
   */
  markReverted(fillId: FillId): Promise<void>;

  /**
   * Помечает fill как требующий ручной реконсиляции — retry НЕ разрешён.
   *
   * @param fillId - ID fill-события
   * @param reason - Причина (для диагностики/алертинга/ручной реконсиляции)
   *
   * @remarks
   * В отличие от `markFailed()`, `RECONCILIATION_REQUIRED` — терминальный
   * статус: последующий `begin()` вернёт `{ outcome: 'RECONCILIATION_REQUIRED' }`,
   * а не `ACQUIRED`. Используется, когда часть state-мутаций (например, Order)
   * уже применена и сохранена, а последующая (Portfolio/Ledger) — упала: retry
   * этого fillId неизбежно упрётся в defence Order против duplicate fill и
   * никогда не восстановит оставшееся состояние. Требует явного вмешательства
   * (ручная реконсиляция), а не автоматического retry.
   */
  markReconciliationRequired(fillId: FillId, reason: string): Promise<void>;

  /**
   * Возвращает текущий статус fillId.
   *
   * @param fillId - ID fill-события
   * @returns Текущий `ProcessedFillStatus`, либо `undefined` если fillId неизвестен
   */
  getStatus(fillId: FillId): Promise<ProcessedFillStatus | undefined>;
}
