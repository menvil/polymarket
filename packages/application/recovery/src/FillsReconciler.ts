/**
 * FillsReconciler — сверка fills из venue API с локальными записями.
 *
 * @remarks
 * ### Назначение:
 * Загружает fills из venue API (REST) с момента `since` и прогоняет
 * незнакомые через pipeline обработки fill.
 *
 * ### Алгоритм:
 * 1. `exchangeClient.getTrades(accountId, since)` → VenueTradeSnapshot[]
 * 2. Для каждого trade: `processedFillRepo.exists(fillId)` — уже обработан?
 * 3. Если нет → `fillProcessor.processVenueTrade(trade)` (делегация)
 * 4. Собрать FillReconciliationReport
 *
 * ### Идемпотентность:
 * ProcessFillUseCase внутри fillProcessor тоже проверяет markIfNotExists.
 * FillsReconciler добавляет первый уровень фильтрации чтобы не грузить use-case
 * заведомо обработанными fills.
 *
 * ### Порт IVenueFillProcessor:
 * FillsReconciler не зависит от ProcessFillUseCase напрямую (Dependency Inversion).
 * Реализация wiring слоя конвертирует VenueTradeSnapshot → Fill → ProcessFillUseCase.
 *
 * @example
 * ```typescript
 * const reconciler = new FillsReconciler({
 *   exchangeClient, processedFillRepo, fillProcessor, logger,
 * });
 *
 * const report = await reconciler.reconcile(accountId, sinceTimestamp);
 * logger.info('Fills reconciled', report);
 * ```
 */
import type { Result } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';
import type { IExchangeClient, VenueTradeSnapshot } from '@polymarket/ports';
import type { IProcessedFillRepository } from '@polymarket/ports';

// ── Публичные типы ─────────────────────────────────────────

/**
 * Порт: обработчик venue fill.
 *
 * @remarks
 * Реализация конвертирует VenueTradeSnapshot → Fill domain record
 * и вызывает ProcessFillUseCase.
 */
export interface IVenueFillProcessor {
  /**
   * Обрабатывает fill из venue.
   *
   * @param trade - Снапшот сделки от биржи
   * @returns Ok при успехе, Err при ошибке обработки
   */
  processVenueTrade(trade: VenueTradeSnapshot): Promise<Result<void, Error>>;
}

/**
 * Отчёт о reconciliation fills.
 */
export interface FillReconciliationReport {
  /** Всего fills от venue */
  readonly totalFromVenue: number;
  /** Уже обработанные (пропущены) */
  readonly alreadyProcessed: number;
  /** Вновь обработанные */
  readonly newlyProcessed: number;
  /** Ошибки обработки */
  readonly errors: number;
}

/**
 * Зависимости FillsReconciler.
 */
export interface FillsReconcilerDeps {
  readonly exchangeClient: IExchangeClient;
  readonly processedFillRepo: IProcessedFillRepository;
  readonly fillProcessor: IVenueFillProcessor;
  readonly logger: ILogger;
}

// ── Реализация ─────────────────────────────────────────────

export class FillsReconciler {
  private readonly _logger: ILogger;

  constructor(private readonly _deps: FillsReconcilerDeps) {
    this._logger = _deps.logger.child({ component: 'FillsReconciler' });
  }

  /**
   * Выполняет reconciliation fills с venue.
   *
   * @param accountId - ID аккаунта
   * @param since - С какого момента загружать fills (опционально)
   * @returns Отчёт о reconciliation
   *
   * @remarks
   * Ошибки при обработке отдельных fills не прерывают reconciliation —
   * они собираются в report.errors.
   */
  public async reconcile(
    accountId: AccountId,
    since?: Timestamp,
  ): Promise<FillReconciliationReport> {
    // Шаг 1: загрузить trades от venue
    const tradesResult = await this._deps.exchangeClient.getTrades(accountId, since);
    if (!tradesResult.ok) {
      this._logger.error('FillsReconciler: failed to fetch trades from venue', {
        accountId: String(accountId),
        error: tradesResult.error.message,
      });
      return { totalFromVenue: 0, alreadyProcessed: 0, newlyProcessed: 0, errors: 1 };
    }

    const trades = tradesResult.value;
    let alreadyProcessed = 0;
    let newlyProcessed = 0;
    let errors = 0;

    this._logger.info('FillsReconciler: fetched trades from venue', {
      accountId: String(accountId),
      count: trades.length,
    });

    // Шаг 2-3: проверить и обработать каждый trade
    for (const trade of trades) {
      // markIfNotExists: true = первый раз (новый), false = уже обработан (дубликат)
      const isNew = await this._deps.processedFillRepo.markIfNotExists(trade.fillId);
      if (!isNew) {
        alreadyProcessed++;
        continue;
      }

      try {
        const result = await this._deps.fillProcessor.processVenueTrade(trade);
        if (result.ok) {
          newlyProcessed++;
        } else {
          this._logger.warn('FillsReconciler: fill processing returned error', {
            fillId: String(trade.fillId),
            error: result.error.message,
          });
          errors++;
        }
      } catch (err) {
        this._logger.error('FillsReconciler: fill processing threw', {
          fillId: String(trade.fillId),
          err: err instanceof Error ? err : new Error(String(err)),
        });
        errors++;
      }
    }

    const report: FillReconciliationReport = {
      totalFromVenue: trades.length,
      alreadyProcessed,
      newlyProcessed,
      errors,
    };

    this._logger.info('FillsReconciler: reconciliation complete', report as unknown as Record<string, unknown>);
    return report;
  }
}
