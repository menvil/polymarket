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
 *    - `processedFillRepo.markIfNotExists(trade.fillId)`:
 *      - `false` → дубликат, пропустить
 *      - `true` → новый fill → конвертировать и обработать через ProcessFillUseCase
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

    // Шаг 2: Обработать каждый trade
    for (const trade of trades) {
      const fillIdStr = String(trade.fillId);

      // Фильтрация по on-chain статусу.
      // MATCHED / MINED / RETRYING / FAILED → пропускаем без markIfNotExists,
      // чтобы CONFIRMED-версия того же fill не была заблокирована idempotency-check'ом.
      //
      // Почему не обрабатываем MINED:
      // Cross-outcome MINT fills (обе стороны BUY) — CLOB отклоняет SELL до CONFIRMED,
      // так как свежеминченные токены не доступны до finality.
      // Для обычных transfer fills задержка 2–5 секунд до CONFIRMED несущественна
      // на 5-минутных маркетах. Следующий reconciliation-цикл (5 с) подхватит CONFIRMED.
      if (trade.status !== 'CONFIRMED') {
        this._logger.debug('Trade not yet confirmed, skipping portfolio update', {
          fillId: fillIdStr,
          status: trade.status ?? 'undefined',
        });
        skippedCount++;
        continue;
      }

      // Проверка idempotency — markIfNotExists атомарна
      const isNew = await this._deps.processedFillRepo.markIfNotExists(trade.fillId);

      if (!isNew) {
        this._logger.debug('Trade already processed, skipping', { fillId: fillIdStr });
        skippedCount++;
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
      this._logger.debug('Reconciled fill processed', { fillId: fillIdStr, status: trade.status });
    }

    this._logger.info('Trade reconciliation complete', {
      totalTrades: trades.length,
      processed: processedCount,
      skipped: skippedCount,
      errors: errorCount,
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
