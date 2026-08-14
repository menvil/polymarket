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
 *    - venue `FAILED` при локальном `APPLIED` → fill применён локально, но venue
 *      его откатил (WS FILL_FAILED пропущен) — создаётся
 *      `VENUE_LOCAL_ORDER_DESYNC` issue (если передан `reconciliationIssues`),
 *      обработка пропускается; автоматический reversal — future work
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
import type { IClock } from '@polymarket/time';
import type { AccountId } from '@polymarket/ids';
import { accountIdToString, assetIdToInstrumentId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/timestamp';
import type {
  IExchangeClient,
  IProcessedFillRepository,
  IReconciliationIssueRepository,
  ReconciliationIssue,
  VenueTradeSnapshot,
} from '@polymarket/ports';
import { Fill } from '@polymarket/fill';
import type { ProcessFillUseCase } from './ProcessFillUseCase.js';
import { venueTradeToFill } from './services/venueTradeToFill.js';
import { isProcessableVenueTradeStatus, isFailedVenueTradeStatus } from './services/venueTradeStatusPolicy.js';

/** Зависимости ReconcileTradesUseCase */
export interface ReconcileTradesDeps {
  readonly exchangeClient: IExchangeClient;
  readonly processedFillRepo: IProcessedFillRepository;
  readonly processFillUseCase: ProcessFillUseCase;
  readonly logger: ILogger;
  /**
   * Queryable хранилище reconciliation issues (опционально).
   *
   * @remarks
   * Optional — чтобы не ломать существующие конструкторы/тесты. Если передан,
   * `FAILED` trade при локальном статусе `APPLIED` (venue откатил fill, который
   * мы уже применили к Order/Portfolio/Ledger) создаёт
   * `VENUE_LOCAL_ORDER_DESYNC` issue — reversal требует ручного вмешательства,
   * автоматический reversal из reconciler — future work. Сбой `add()`
   * логируется и НЕ меняет результат use case.
   */
  readonly reconciliationIssues?: IReconciliationIssueRepository;
  /**
   * Источник времени для `ReconciliationIssue.createdAt` (опционально).
   *
   * @remarks
   * Optional по той же причине. Без него используется `new Date()`.
   */
  readonly clock?: IClock;
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
   * Best-effort создание reconciliation issue (venue FAILED после local APPLIED).
   *
   * @param issue - Issue с детерминированным id (см. call site)
   *
   * @remarks
   * No-op, если `reconciliationIssues` не передан в deps. `add()` идемпотентен
   * по id. Ошибка `add()` логируется и проглатывается — reconciliation loop
   * продолжает обработку остальных trades и возвращает Ok.
   */
  private async _addReconciliationIssue(issue: ReconciliationIssue): Promise<void> {
    if (!this._deps.reconciliationIssues) {
      return;
    }
    try {
      await this._deps.reconciliationIssues.add(issue);
    } catch (err) {
      this._logger.error('Failed to add reconciliation issue', {
        issueId: issue.id,
        issueType: issue.type,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
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
    let failedAfterAppliedCount = 0;

    this._logger.debug('Reconciliation: processing trades', { count: trades.length });

    // Шаг 2: Обработать все trades за один цикл.
    // Лимит убран: API возвращает ~97-300 trades, все async, не блокируют event loop.
    // Лимит 50 вызывал баг: первые 50 всегда skipped → оставшиеся никогда не достигались.
    for (const trade of trades) {
      const fillIdStr = String(trade.fillId);

      // FAILED — особый случай ДО общего фильтра: reconciler — safety net при
      // пропущенных WS-событиях. Если venue сообщает FAILED, а локально fill
      // уже APPLIED (WS FILL_FAILED не дошёл), Order/Portfolio/Ledger содержат
      // применённый fill, которого on-chain больше нет — reversal требуется,
      // но автоматически здесь НЕ выполняется (future work): создаём queryable
      // issue и пропускаем. Локальный статус НЕ APPLIED — просто skip (WS
      // reversal не нужен или fill не применялся).
      if (isFailedVenueTradeStatus(trade.status)) {
        const localStatus = await this._deps.processedFillRepo.getStatus(trade.fillId);
        if (localStatus === 'APPLIED') {
          this._logger.error('VENUE_FILL_FAILED_AFTER_LOCAL_APPLIED: venue reports FAILED for locally APPLIED fill — reversal required, manual reconciliation', {
            fillId: fillIdStr,
            orderId: String(trade.orderId),
          });
          const instrumentId = assetIdToInstrumentId(trade.asset);
          await this._addReconciliationIssue({
            id: `reconciliation:fill:${fillIdStr}:venue-failed-after-applied`,
            type: 'VENUE_LOCAL_ORDER_DESYNC',
            status: 'OPEN',
            reason: 'VENUE_FILL_FAILED_AFTER_LOCAL_APPLIED: fill was APPLIED locally but venue reports FAILED',
            createdAt: this._deps.clock?.now() ?? new Date(),
            fillId: trade.fillId,
            orderId: trade.orderId,
            accountId: input.accountId,
            ...(instrumentId ? { instrumentId } : {}),
            context: {
              stage: 'reconcile-trades-failed-after-applied',
              venueStatus: 'FAILED',
              localProcessedStatus: 'APPLIED',
            },
          });
          failedAfterAppliedCount++;
        } else {
          this._logger.debug('FAILED trade without local APPLIED state — skipping (no reversal needed)', {
            fillId: fillIdStr,
            localStatus: localStatus ?? 'undefined',
          });
          skippedCount++;
        }
        continue;
      }

      // Фильтрация по on-chain статусу.
      // Принимаем CONFIRMED (finality) и MATCHED (мгновенное исполнение).
      // MATCHED обрабатываем чтобы не потерять fill при WS race condition:
      // REST может вернуть matched, но WS fill event не прийти.
      // processedFillRepo предотвращает дубли: если WS уже обработал fill,
      // ProcessFillUseCase.execute() увидит APPLIED через begin() и вернёт
      // Ok без повторной обработки (см. регрессионный тест ниже).
      //
      // MINED / RETRYING / undefined → пропускаем.
      // MINED: cross-outcome MINT fills — CLOB отклоняет SELL до CONFIRMED.
      // FAILED обработан отдельной веткой ВЫШЕ (issue при local APPLIED).
      // Классификация вынесена в общий venueTradeStatusPolicy (используется
      // также SettleTerminalOrdersUseCase с более строгим профилем).
      if (!isProcessableVenueTradeStatus(trade.status, 'recovery')) {
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

      // Ok НЕ означает APPLIED (BUSY/DUPLICATE/RECONCILIATION no-op тоже Ok) —
      // авторитетен только перечитанный статус. Без этой перепроверки
      // конкурентно обрабатываемый (BUSY) или уже реконсиляционно-блокированный
      // fill попадал бы в processedCount, хотя эта попытка ничего не применила.
      const finalStatus = await this._deps.processedFillRepo.getStatus(trade.fillId);
      if (finalStatus !== 'APPLIED') {
        this._logger.debug('Reconciled fill did not reach APPLIED this attempt (BUSY/DUPLICATE/RECONCILIATION no-op) — not counted as processed', {
          fillId: fillIdStr,
          finalStatus: finalStatus ?? 'undefined',
        });
        skippedCount++;
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
      failedAfterApplied: failedAfterAppliedCount,
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
    // Общий маппер (используется также SettleTerminalOrdersUseCase) — единая
    // реализация вместо двух расходящихся копий.
    return venueTradeToFill(snapshot, accountId);
  }
}
