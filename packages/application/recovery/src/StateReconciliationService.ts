/**
 * StateReconciliationService — периодическая сверка состояния с venue.
 *
 * @remarks
 * ### Назначение:
 * Объединяет OrderReconciler и FillsReconciler в единый periodic checkpoint.
 * Запускается по таймеру (intervalMs) или вручную (reconcileOnce).
 *
 * ### Алгоритм:
 * 1. OrderReconciler — сверяет локальные ордера с venue, отменяет закрытые
 * 2. FillsReconciler — загружает fills за последние fillLookbackMs, обрабатывает пропущенные
 *
 * ### Конфигурация:
 * - `intervalMs` — периодичность (undefined = только ручной запуск)
 * - `fillLookbackMs` — глубина lookback для fills
 *
 * @example
 * ```typescript
 * const service = new StateReconciliationService({
 *   orderReconciler, fillsReconciler, clock, logger,
 * }, { intervalMs: 60_000, fillLookbackMs: 300_000 });
 *
 * service.start(accountId);
 * // Или вручную:
 * await service.reconcileOnce(accountId);
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import type { Timestamp } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/value-objects';
import type { OrderReconciler } from './OrderReconciler.js';
import type { FillsReconciler } from './FillsReconciler.js';

// ── Публичные типы ─────────────────────────────────────────

/**
 * Конфигурация StateReconciliationService.
 */
export interface StateReconciliationConfig {
  /** Интервал (ms). undefined = отключено, чисто ручной запуск */
  readonly intervalMs?: number;
  /** Глубина lookback для fills (ms). Default: 300_000 (5 минут) */
  readonly fillLookbackMs: number;
}

/**
 * Зависимости StateReconciliationService.
 */
export interface StateReconciliationDeps {
  readonly orderReconciler: OrderReconciler;
  readonly fillsReconciler: FillsReconciler;
  readonly clock: IClock;
  readonly logger: ILogger;
}

// ── Реализация ─────────────────────────────────────────────

export class StateReconciliationService {
  private readonly _logger: ILogger;
  private _timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly _deps: StateReconciliationDeps,
    private readonly _config: StateReconciliationConfig,
  ) {
    this._logger = _deps.logger.child({ component: 'StateReconciliationService' });
  }

  /**
   * Запускает периодическую reconciliation.
   *
   * @param accountId - ID аккаунта для сверки
   *
   * @remarks
   * Если intervalMs не задан — no-op (только ручной reconcileOnce).
   * Повторный вызов без stop() безопасен — перезапускает таймер.
   */
  public start(accountId: AccountId): void {
    this.stop();

    if (this._config.intervalMs === undefined) {
      this._logger.info('StateReconciliationService: no intervalMs, periodic reconciliation disabled');
      return;
    }

    this._timer = setInterval(() => {
      void this.reconcileOnce(accountId).catch((err) => {
        this._logger.error('StateReconciliationService: periodic reconciliation failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      });
    }, this._config.intervalMs);

    this._logger.info('StateReconciliationService started', {
      intervalMs: this._config.intervalMs,
      fillLookbackMs: this._config.fillLookbackMs,
    });
  }

  /**
   * Останавливает периодическую reconciliation.
   */
  public stop(): void {
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  /**
   * Выполняет одну итерацию reconciliation.
   *
   * @param accountId - ID аккаунта для сверки
   *
   * @remarks
   * Сначала Orders, потом Fills. Ошибки в одном этапе не блокируют другой.
   */
  public async reconcileOnce(accountId: AccountId): Promise<void> {
    this._logger.debug('StateReconciliationService: starting reconciliation', {
      accountId: String(accountId),
    });

    // Шаг 1: Orders
    try {
      await this._deps.orderReconciler.reconcile(accountId);
    } catch (err) {
      this._logger.error('StateReconciliationService: order reconciliation failed', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    // Шаг 2: Fills
    try {
      const sinceMs = this._deps.clock.now().getTime() - this._config.fillLookbackMs;
      const sinceResult = TimestampService.create(sinceMs);
      const since: Timestamp | undefined = sinceResult.ok ? sinceResult.value : undefined;

      await this._deps.fillsReconciler.reconcile(accountId, since);
    } catch (err) {
      this._logger.error('StateReconciliationService: fills reconciliation failed', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    this._logger.debug('StateReconciliationService: reconciliation complete', {
      accountId: String(accountId),
    });
  }
}
