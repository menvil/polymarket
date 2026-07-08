/**
 * ReconcileTradesUseCase — сверка исполнений с локальными записями.
 *
 * @remarks
 * ### Назначение:
 * Обнаруживает fills, которые пришли с биржи, но не были обработаны локально
 * (WebSocket разрыв, restart, временная недоступность).
 *
 * ### Алгоритм:
 * 1. `exchangeClient.getTrades(accountId, since)` → VenueTradeSnapshot[]
 * 2. Для каждого trade:
 *    - Читаем `processedFillRepo.getStatus(trade.fillId)` ТОЛЬКО для статистики
 *      (skippedCount) — реальный idempotency guard (begin/markApplied/markFailed)
 *      целиком внутри `ProcessFillUseCase.execute()`. Здесь НЕ вызываем `begin()` —
 *      иначе внутренний `begin()` внутри `execute()` увидел бы `PROCESSING`
 *      (уже выставленный этим же вызовом) и вернул бы `BUSY`, ошибочно пропустив
 *      реальную обработку.
 *    - `APPLIED` → уже обработан (скорее всего через WS) → пропустить
 *    - `RECONCILIATION_REQUIRED` → частичный commit, retry не поможет
 *      (см. `ProcessFillUseCase` doc) → пропустить, инкрементировать
 *      `reconciliationRequiredCount`, залогировать error (не молчать)
 *    - иначе → конвертировать и обработать через ProcessFillUseCase (само решит
 *      ACQUIRED/DUPLICATE/BUSY/retry)
 *
 * ### Конвертация VenueTradeSnapshot → Fill:
 * Используем `Fill.create()` напрямую с типизированными данными из снапшота.
 * settlementAssetId по умолчанию — USDC (стандарт Polymarket).
 * venueId по умолчанию — POLYMARKET.
 *
 * ### Идемпотентность:
 * Повторный вызов безопасен — processedFillRepo гарантирует «exactly once».
 *
 * @example
 * ```typescript
 * const useCase = new ReconcileTradesUseCase({
 *   exchangeClient, processedFillRepo, processFillUseCase, logger,
 * });
 *
 * await useCase.execute({ accountId, since: lastTimestamp });
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import { asVenueId, AssetIdHelpers, accountIdToString } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';
import { Fee } from '@polymarket/value-objects';
import { AssetQuantity } from '@polymarket/value-objects/asset-quantity';
import type { IExchangeClient, IProcessedFillRepository, VenueTradeSnapshot } from '@polymarket/ports';
import { Fill } from '@polymarket/fill';
import type { ProcessFillUseCase } from './ProcessFillUseCase.js';

/** Зависимости ReconcileTradesUseCase */
export interface ReconcileTradesDeps {
  readonly exchangeClient: IExchangeClient;
  readonly processedFillRepo: IProcessedFillRepository;
  readonly processFillUseCase: ProcessFillUseCase;
  readonly logger: ILogger;
}

/** Входные данные для ReconcileTradesUseCase */
export interface ReconcileTradesInput {
  /** ID аккаунта для сверки */
  readonly accountId: AccountId;
  /** Начальная временная метка выборки (опционально) */
  readonly since?: Timestamp;
}

/**
 * Use case сверки исполнений с биржей.
 *
 * @remarks
 * Обнаруживает пропущенные fills и повторно запускает их обработку через ProcessFillUseCase.
 */
export class ReconcileTradesUseCase {
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости use case
   */
  constructor(private readonly _deps: ReconcileTradesDeps) {
    this._logger = _deps.logger.child({ component: 'ReconcileTradesUseCase' });
  }

  /**
   * Выполняет сверку исполнений.
   *
   * @param input - Входные данные с accountId и опциональным since
   * @returns Ok(void) при успехе, Err при критической ошибке
   *
   * @remarks
   * Ошибки отдельных fills логируются, но не прерывают обработку остальных.
   * Критический Err возвращается только при ошибке обращения к бирже.
   */
  public async execute(input: ReconcileTradesInput): Promise<Result<void, TradingError>> {
    this._logger.info('Starting trade reconciliation', {
      accountId: accountIdToString(input.accountId),
      since: input.since ? input.since.toNumber() : undefined,
    });

    // Шаг 1: Получить исполнения от биржи
    const tradesResult = await this._deps.exchangeClient.getTrades(
      input.accountId,
      input.since,
    );

    if (!tradesResult.ok) {
      this._logger.error('Failed to fetch trades from exchange', {
        error: tradesResult.error.message,
      });
      return Err(new TradingError(
        `Exchange getTrades failed: ${tradesResult.error.message}`,
        { context: { accountId: accountIdToString(input.accountId) } },
      ));
    }

    const trades = tradesResult.value;

    if (trades.length === 0) {
      this._logger.debug('No trades to reconcile');
      return Ok(undefined);
    }

    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let reconciliationRequiredCount = 0;

    this._logger.debug('Reconciliation: processing trades', { count: trades.length });

    // Шаг 2: Обработать все trades за один цикл.
    // Лимит убран: API возвращает ~97-300 trades, все async, не блокируют event loop.
    // Лимит 50 вызывал баг: первые 50 всегда skipped → оставшиеся никогда не достигались.
    for (const trade of trades) {
      const fillIdStr = String(trade.fillId);

      // Фильтрация по on-chain статусу.
      // Принимаем CONFIRMED (finality) и MATCHED (мгновенное исполнение).
      // MATCHED обрабатываем чтобы не потерять fill при WS race condition:
      // REST может вернуть matched, но WS fill event не прийти.
      // processedFillRepo предотвращает дубли: если WS уже обработал fill,
      // ProcessFillUseCase.execute() увидит APPLIED через begin() и вернёт
      // Ok без повторной обработки (см. регрессионный тест ниже).
      //
      // MINED / RETRYING / FAILED / undefined → пропускаем.
      // MINED: cross-outcome MINT fills — CLOB отклоняет SELL до CONFIRMED.
      // FAILED: FillEventHandler через WS обработает reversal.
      const PROCESSABLE_STATUSES = new Set(['CONFIRMED', 'MATCHED']);
      if (!PROCESSABLE_STATUSES.has(trade.status ?? '')) {
        this._logger.debug('Trade not in processable status, skipping', {
          fillId: fillIdStr,
          status: trade.status ?? 'undefined',
        });
        skippedCount++;
        continue;
      }

      // Статистика only — реальный idempotency guard (begin()) внутри
      // ProcessFillUseCase.execute(). Этот use case намеренно НЕ вызывает
      // begin() сам: повторный begin() внутри ProcessFillUseCase увидел бы
      // PROCESSING и вернул бы BUSY, ошибочно пропустив реальную обработку.
      const status = await this._deps.processedFillRepo.getStatus(trade.fillId);
      if (status === 'APPLIED') {
        skippedCount++;
        continue;
      }
      // RECONCILIATION_REQUIRED — терминально, ProcessFillUseCase.execute()
      // и так вернёт Ok(no-op) для этого fillId (см. doc ProcessFillUseCase),
      // но не отправляем его туда вовсе — незачем платить за keyed-mutex round-trip
      // ради статуса, который уже известен как «не восстановится автоматически».
      if (status === 'RECONCILIATION_REQUIRED') {
        this._logger.error('Fill requires manual reconciliation — skipping reconcile attempt', {
          fillId: fillIdStr,
          orderId: String(trade.orderId),
        });
        reconciliationRequiredCount++;
        continue;
      }

      // Конвертировать VenueTradeSnapshot → Fill
      const fillResult = this._convertToFill(trade, input.accountId);

      if (!fillResult.ok) {
        this._logger.error('Failed to convert venue trade snapshot to Fill', {
          fillId: fillIdStr,
          error: fillResult.error.message,
        });
        errorCount++;
        continue;
      }

      // Обработать fill через ProcessFillUseCase
      const processResult = await this._deps.processFillUseCase.execute(fillResult.value);

      if (!processResult.ok) {
        this._logger.error('Failed to process reconciled fill', {
          fillId: fillIdStr,
          error: processResult.error.message,
        });
        errorCount++;
        continue;
      }

      processedCount++;
      this._logger.info('Reconciled fill processed', { fillId: fillIdStr, orderId: String(trade.orderId), status: trade.status });
    }

    this._logger.info('Trade reconciliation complete', {
      totalTrades: trades.length,
      processed: processedCount,
      skipped: skippedCount,
      errors: errorCount,
      reconciliationRequired: reconciliationRequiredCount,
    });

    return Ok(undefined);
  }

  /**
   * Конвертирует VenueTradeSnapshot в доменный Fill.
   *
   * @param snapshot - Снимок исполнения от биржи
   * @param accountId - ID аккаунта (из контекста сессии)
   * @returns Result<Fill, TradingError>
   *
   * @remarks
   * - settlementAssetId = USDC (стандарт Polymarket)
   * - venueId = POLYMARKET
   */
  private _convertToFill(
    snapshot: VenueTradeSnapshot,
    accountId: AccountId,
  ): Result<Fill, TradingError> {
    const venueId = asVenueId('POLYMARKET');
    if (!venueId) {
      return Err(new TradingError('Cannot create POLYMARKET venueId', {}));
    }

    // Собрать Fee из FeeSnapshot
    const feeAssetQuantity = new AssetQuantity(snapshot.fee.asset, snapshot.fee.amount);
    const fee = Fee.of(feeAssetQuantity);

    const fillResult = Fill.create({
      id: snapshot.fillId,
      orderId: snapshot.orderId,
      accountId,
      venueId,
      marketId: snapshot.marketId,
      tokenId: snapshot.asset,
      settlementAssetId: AssetIdHelpers.USDC,
      price: snapshot.price,
      size: snapshot.size,
      side: snapshot.side,
      timestamp: snapshot.executedAt,
      fee,
    });

    if (!fillResult.ok) {
      return Err(new TradingError(
        `Failed to create Fill from venue snapshot: ${fillResult.error.message}`,
        { context: { fillId: String(snapshot.fillId) } },
      ));
    }

    return fillResult;
  }
}
