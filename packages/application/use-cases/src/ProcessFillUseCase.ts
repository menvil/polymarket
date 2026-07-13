/**
 * ProcessFillUseCase — оркестрация обработки исполнения ордера (Fill).
 *
 * @remarks
 * ### Алгоритм:
 * 1. Idempotency guard (`IProcessedFillRepository.begin`) — `DUPLICATE`/`BUSY`
 *    возвращают Ok без повторной обработки; `RECONCILIATION_REQUIRED` тоже
 *    возвращает Ok (no-op), но с error-логом — retry не разрешён (см. п.6);
 *    `ACQUIRED` обязывает довести обработку до `markApplied()`, `markFailed()`
 *    либо `markReconciliationRequired()`.
 * 2. Keyed mutex (`IKeyedMutex.runExclusive`) по [accountId, orderId, instrumentId] —
 *    сериализует эту обработку относительно `CancelOrderUseCase` и других
 *    конкурентных fill-ов того же ордера/инструмента.
 * 3. Получение Order из репозитория
 *    — если ордер не найден или уже terminal (CANCELLED/FILLED): direct fill path.
 *    Portfolio обновляется немедленно через applyDirectFill (без резерваций).
 * 4. Применение Fill к Order (sync, order.applyFill)
 * 5. Синхронное сохранение обновлённого Order (orderStateStore.saveSync)
 * 6. Обновление Portfolio (PortfolioService.applyFill) — если упадёт ПОСЛЕ шага 5
 *    (Order уже сохранён), это `markReconciliationRequired()` (терминально,
 *    retry НЕ разрешён), а не `markFailed()`: Order.applyFill defends against
 *    duplicate fill id, поэтому retry такого fillId лишь повторит "duplicate
 *    fill" и никогда не восстановит Portfolio (`ORDER_PORTFOLIO_DESYNC` в
 *    логах, ручная реконсиляция). Если в deps передан `reconciliationIssues`,
 *    дополнительно создаётся queryable `ReconciliationIssue`
 *    (type `ORDER_PORTFOLIO_DESYNC`, детерминированный id) — best-effort:
 *    сбой `add()` логируется и не меняет исходный error path.
 * 7. Запись в Ledger (LedgerService.recordFill)
 * 8. `markApplied(fill.id)` — сразу после успешного завершения шагов 4–7 (commit
 *    состояния Order/Portfolio/Ledger), ДО публикации событий.
 * 9. Публикация доменных событий Order (await) — НЕ гейтит markApplied.
 *    Если публикация упадёт, fill уже `APPLIED` и retry невозможен: состояние
 *    уже закоммичено, повторный вызов лишь заново применил бы уже применённый
 *    fill (Order defends against duplicate fill id, но direct-fill path и
 *    Portfolio — нет), удвоив эффект. Ошибка публикации логируется отдельно
 *    (`EVENT_PUBLISH_FAILED`) как потеря уведомления, требующая ручного replay,
 *    а не как неприменённая бизнес-мутация.
 *    Любая ошибка на шаге 4 (order.applyFill, до saveSync) → `markFailed(fill.id, reason)`,
 *    fillId остаётся retryable. Ошибка на шаге 6 ПОСЛЕ saveSync →
 *    `markReconciliationRequired()` (см. п.6), НЕ retryable FAILED.
 *
 * ### Идемпотентность:
 * Повторный вызов с тем же fillId, пока предыдущая попытка ещё не завершилась
 * (`PROCESSING`) — `BUSY`, Ok без повторной обработки. После `APPLIED` — `DUPLICATE`,
 * Ok без повторной обработки. После `FAILED`/`REVERTED` — retry разрешён.
 * После `RECONCILIATION_REQUIRED` — retry НЕ разрешён: `execute()` возвращает
 * Ok (no-op) при каждом повторном вызове, но логирует error — fill не мутирует
 * Order/Portfolio/Ledger повторно, требуется ручная реконсиляция.
 *
 * ### Консистентность (устранение race condition):
 * Шаги 4–7 выполняются синхронно, без yield между ними.
 * `await` появляется только на шаге 8 (publishAll) и на idempotency/mutex вызовах.
 * К моменту первого yield внутри критической секции ордер уже помечен как
 * terminal (FILED/CANCELLED), поэтому любой тик стратегии или CancelOrderUseCase,
 * запущенный в этом окне, увидит `order.isTerminal === true` и пропустит отмену:
 * ```
 * // CancelOrderUseCase, строка 100:
 * if (order.isTerminal) return Ok(undefined);  // no-op
 * ```
 * Это устраняет ошибку «Cannot unfreeze/consume X: only 0 reserved».
 * Keyed mutex (шаг 2) устраняет ту же гонку и на уровне межпроцессного тика —
 * `CancelOrderUseCase.execute()` для того же orderId дожидается завершения
 * этой обработки, а не читает Order в промежуточном состоянии.
 *
 * @example
 * ```typescript
 * const useCase = new ProcessFillUseCase({
 *   orderStateStore, portfolioService, ledgerService,
 *   processedFillRepo, orderRepo, keyedMutex, eventBus, logger,
 * });
 *
 * const result = await useCase.execute(fill);
 * if (!result.ok) logger.error('Fill processing failed', { error: result.error.message });
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type {
  IOrderRepository,
  IProcessedFillRepository,
  IOrderStateStore,
  IKeyedMutex,
  IReconciliationIssueRepository,
} from '@polymarket/ports';
import type { IEventBus, ApplicationEvent } from '@polymarket/event-bus';
import type { Fill } from '@polymarket/fill';
import type { FillData } from '@polymarket/order';
import { assetIdToInstrumentId, accountIdToString } from '@polymarket/ids';
import { pendingMatchFillId } from '@polymarket/ports';
import type { PortfolioService } from './services/PortfolioService.js';
import type { LedgerService } from './services/LedgerService.js';

/** Зависимости ProcessFillUseCase */
export interface ProcessFillDeps {
  readonly orderStateStore: IOrderStateStore;
  readonly portfolioService: PortfolioService;
  readonly ledgerService: LedgerService;
  readonly orderRepo: IOrderRepository;
  readonly processedFillRepo: IProcessedFillRepository;
  readonly keyedMutex: IKeyedMutex;
  readonly eventBus: IEventBus;
  readonly logger: ILogger;
  /**
   * Queryable хранилище reconciliation issues (опционально).
   *
   * @remarks
   * Optional — чтобы не ломать существующие конструкторы/тесты: без него
   * поведение прежнее (markReconciliationRequired + logging). Если передан,
   * `RECONCILIATION_REQUIRED` дополнительно создаёт `ReconciliationIssue`
   * с детерминированным id (idempotent add). Сбой `add()` НЕ маскирует
   * исходную trading-ошибку — только error-лог.
   */
  readonly reconciliationIssues?: IReconciliationIssueRepository;
  /**
   * Источник времени для `ReconciliationIssue.createdAt` (опционально).
   *
   * @remarks
   * Optional по той же причине, что и `reconciliationIssues`. Если не передан,
   * используется `new Date()` (только для createdAt issue — trading flow
   * времени не использует).
   */
  readonly clock?: IClock;
}

/**
 * Use case обработки Fill исполнения.
 *
 * @remarks
 * Оркестрирует идемпотентное обновление Order, Portfolio и Ledger
 * при получении нового исполнения ордера.
 * Все state-мутации выполняются синхронно до первого await внутри критической секции.
 */
export class ProcessFillUseCase {
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости use case
   */
  constructor(private readonly _deps: ProcessFillDeps) {
    this._logger = _deps.logger.child({ component: 'ProcessFillUseCase' });
  }

  /**
   * Выполняет обработку исполнения ордера.
   *
   * @param fill - Полученное исполнение ордера
   * @returns Ok(void) при успехе (в т.ч. duplicate/busy/reconciliation-required — no-op),
   *   Err(TradingError) при ошибке обработки
   *
   * @remarks
   * Повторный вызов с тем же fill.id безопасен: `DUPLICATE` (уже применён) или
   * `BUSY` (обрабатывается конкурентно) возвращают Ok без повторной обработки.
   * После `FAILED`/`REVERTED` — retry разрешён. После `RECONCILIATION_REQUIRED` —
   * retry НЕ разрешён (частичный commit, нужна ручная реконсиляция): возвращает
   * Ok (no-op, fill не мутируется повторно), но логирует error при каждом
   * вызове, чтобы не молчать о нерешённой проблеме.
   */
  public async execute(fill: Fill): Promise<Result<void, TradingError>> {
    // Шаг 1: Idempotency guard
    const begin = await this._deps.processedFillRepo.begin(fill.id);
    if (begin.outcome === 'DUPLICATE') {
      this._logger.debug('Fill already applied, skipping (idempotent)', { fillId: String(fill.id) });
      return Ok(undefined);
    }
    if (begin.outcome === 'BUSY') {
      this._logger.warn('Fill already being processed concurrently, skipping', { fillId: String(fill.id) });
      return Ok(undefined);
    }
    if (begin.outcome === 'RECONCILIATION_REQUIRED') {
      // Терминально — НЕ ACQUIRED, значит НЕ мутируем Order/Portfolio/Ledger
      // повторно. Ok (no-op), а не Err: caller (WS handler / ReconcileTradesUseCase)
      // не должен трактовать это как retryable ошибку. Error-лог на каждый
      // вызов — чтобы нерешённая проблема оставалась видимой в мониторинге.
      this._logger.error('ORDER_PORTFOLIO_DESYNC: fill requires manual reconciliation — retry not attempted, skipping', {
        fillId: String(fill.id),
      });
      return Ok(undefined);
    }
    if (begin.isRetry) {
      this._logger.info('Retrying previously failed/reverted fill', { fillId: String(fill.id) });
    }

    // Шаг 2: Keyed mutex — сериализует относительно CancelOrderUseCase и других
    // конкурентных fill-ов того же ордера/инструмента/аккаунта.
    const instrumentId = assetIdToInstrumentId(fill.tokenId);
    const lockKeys = [
      accountIdToString(fill.accountId),
      String(fill.orderId),
      instrumentId ? String(instrumentId) : String(fill.tokenId),
    ];

    return this._deps.keyedMutex.runExclusive(lockKeys, () => this._processLocked(fill));
  }

  /**
   * Тело обработки fill — вызывается ВНУТРИ keyed mutex.
   *
   * @param fill - Полученное исполнение ордера
   * @returns Ok(void) при успехе, Err(TradingError) при ошибке
   */
  private async _processLocked(fill: Fill): Promise<Result<void, TradingError>> {
    // Получить Order
    const order = await this._deps.orderRepo.get(fill.orderId);

    // Особый случай: ордер не найден или уже terminal (например, CANCELLED).
    // Это происходит при: частичный fill → стратегия отменяет ордер → оставшийся
    // fill (MATCHED) приходит на уже CANCELLED ордер. Также: внешние/ручные ордера.
    //
    // Биржевое событие — источник истины: токены реально получены/переданы.
    // Применяем fill напрямую без резервационного dance (applyDirectFill).
    if (!order || order.isTerminal) {
      const reason = !order ? 'not found' : `terminal (${order.status})`;
      this._logger.warn('Fill arrived for order that is ' + reason + ' — applying direct fill', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        side: fill.side,
        size: fill.size.toNumber(),
        price: fill.price.toNumber(),
      });

      const directResult = this._deps.portfolioService.applyDirectFill(fill);
      if (!directResult.ok) {
        this._logger.error('Direct fill portfolio update failed', {
          fillId: String(fill.id),
          orderId: String(fill.orderId),
          error: directResult.error.message,
        });
        this._clearInFlightFlags(fill);
        await this._deps.processedFillRepo.markFailed(fill.id, directResult.error.message);
        return Err(new TradingError(
          `Direct fill portfolio update failed: ${directResult.error.message}`,
          { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
        ));
      }

      this._deps.ledgerService.recordFill(fill);
      this._clearInFlightFlags(fill);

      // Диагностика fee для direct fill (BUY).
      // PortfolioService.applyDirectFill тоже вычтет feeInTokens из позиции.
      if (fill.side === 'BUY' && !fill.fee.isZero()) {
        const feeUSDC = fill.fee.quantity.amount().value();
        const fillPrice = fill.price.value();
        const feeInTokens = feeUSDC.div(fillPrice);
        this._logger.info('BUY direct fill fee deduction applied', {
          fillId: String(fill.id),
          grossTokens: fill.size.value().toNumber(),
          feeUSDC: feeUSDC.toNumber(),
          feeInTokens: feeInTokens.toNumber(),
          netTokens: fill.size.value().minus(feeInTokens).toNumber(),
        });
      }

      // Portfolio/Ledger уже применены (commit состоялся) — помечаем APPLIED
      // ДО попытки публикации. Публикация — это уведомление о свершившемся
      // факте, а не часть транзакции: если пометить fill FAILED из-за ошибки
      // publish, retry вызовет execute() заново, order всё ещё terminal/not-found
      // → снова direct-fill path → applyDirectFill() применится к Portfolio
      // ПОВТОРНО (нет defence от duplicate на этом пути, в отличие от
      // Order.applyFill) — двойной учёт баланса. Поэтому publish-ошибка не
      // должна делать fill retryable.
      await this._deps.processedFillRepo.markApplied(fill.id);

      // Публикуем DIRECT_FILL_APPLIED чтобы MarketRotation мог учесть этот fill
      // в fillHistory (для корректной сводки рынка). Без этого события fills на
      // отменённых ордерах не отображаются в market summary.
      try {
        await this._deps.eventBus.publishAll([
          { type: 'DIRECT_FILL_APPLIED', fill } as ApplicationEvent,
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Состояние (Portfolio/Ledger) уже закоммичено и fill уже APPLIED —
        // это НЕ retryable ошибка, а потеря уведомления. Логируем как
        // отдельную категорию для алертинга/ручного replay события.
        this._logger.error('EVENT_PUBLISH_FAILED: Failed to publish DIRECT_FILL_APPLIED after commit — fill stays APPLIED, event lost', {
          fillId: String(fill.id),
          err: err instanceof Error ? err : new Error(message),
        });
        return Err(new TradingError(
          `Failed to publish DIRECT_FILL_APPLIED event (fill already committed as APPLIED): ${message}`,
          { context: { fillId: String(fill.id) } },
        ));
      }

      return Ok(undefined);
    }

    // Шаги ниже выполняются синхронно (без yield) — атомарное обновление состояния.
    // Первый await появляется только на публикации событий.

    // Применить Fill к Order (sync)
    const fillData: FillData = {
      id: fill.id,
      orderId: fill.orderId,
      asset: fill.tokenId,
      side: fill.side,
      size: fill.size,
      price: fill.price,
    };
    const applyResult = order.applyFill(fillData);
    if (!applyResult.ok) {
      this._logger.warn('Failed to apply fill to order', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        error: applyResult.error.message,
      });
      // Снимаем флаги даже при ошибке — fill уже on-chain,
      // повторная пометка произойдёт при следующем fill-событии если нужно.
      this._clearInFlightFlags(fill);
      await this._deps.processedFillRepo.markFailed(fill.id, applyResult.error.message);
      return Err(new TradingError(
        `Failed to apply fill to order: ${applyResult.error.message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }
    const updatedOrder = applyResult.value;

    // Синхронно сохранить обновлённый Order (terminal = true, если FILLED)
    // После этой строки любой читатель IOrderStateStore увидит ордер как FILED/terminal.
    // CancelOrderUseCase: if (order.isTerminal) return Ok(undefined) — пропустит cancel.
    //
    // TODO: replace saveSync with CAS/UnitOfWork; saveSync intentionally bypasses
    // repository CAS to preserve current no-yield fill/cancel race fix.
    // saveSync при этом ИНКРЕМЕНТИТ версию записи — конкурирующий CAS save
    // (CancelOrderUseCase/UpdateOrderStatusUseCase) со stale-версией корректно
    // получит VersionConflictError и не перетрёт применённый fill.
    this._deps.orderStateStore.saveSync(updatedOrder);

    // Обновить Portfolio (sync)
    // Передаём цену ордера, чтобы точно совпасть с зарезервированной суммой
    // (fill.price может быть округлена биржей: 0.829 → 0.83, что вызывает «Cannot unfreeze/consume»).
    this._logger.info('Applying fill to portfolio', {
      fillId: String(fill.id),
      orderId: String(fill.orderId),
      side: fill.side,
      fillPrice: fill.price.value().toNumber(),
      orderPrice: order.price.value().toNumber(),
      fillSize: fill.size.value().toNumber(),
      notional: order.price.value().times(fill.size.value()).toNumber(),
    });
    const portfolioResult = this._deps.portfolioService.applyFill(fill, order.price.value());
    if (!portfolioResult.ok) {
      // ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (нет полного Unit of Work — вне scope этого этапа):
      // Order уже сохранён ВЫШЕ (saveSync) с применённым fill.id, а Portfolio —
      // нет. Order.applyFill() защищён от повторного применения того же fillId
      // (см. Order._fill.ts), поэтому retry этого fillId НЕ приведёт к повторному
      // прогону Portfolio — он остановится на applyFill-to-order с ошибкой
      // "duplicate fill". Именно поэтому здесь `markReconciliationRequired()`,
      // а НЕ `markFailed()`: FAILED подразумевает «retry поможет», а тут retry
      // гарантированно бесполезен и лишь маскирует проблему повторяющейся
      // ошибкой "duplicate fill" вместо истинной причины.
      // RECONCILIATION_REQUIRED — терминальный статус: begin() больше НЕ выдаст
      // ACQUIRED для этого fillId, требуется явная ручная реконсиляция Order↔Portfolio.
      this._logger.error('ORDER_PORTFOLIO_DESYNC: Failed to apply fill to portfolio after Order already saved — fill requires manual reconciliation', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        error: portfolioResult.error.message,
      });
      // Снимаем флаги даже при ошибке portfolio.
      // Ордер уже сохранён как terminal (выше), поэтому он не появится
      // в getOpenOrdersByInstrument. Но для чистоты — снимаем флаги.
      this._clearInFlightFlags(fill);
      const reconciliationReason = `ORDER_PORTFOLIO_DESYNC: ${portfolioResult.error.message}`;
      await this._deps.processedFillRepo.markReconciliationRequired(fill.id, reconciliationReason);
      // Queryable issue в дополнение к processed-fill статусу (семантика
      // markReconciliationRequired не меняется). Сбой add() не маскирует Err ниже.
      await this._addReconciliationIssue(fill, reconciliationReason, portfolioResult.error.message);
      return Err(new TradingError(
        `Failed to update portfolio (Order already committed — manual reconciliation required): ${portfolioResult.error.message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }

    // Снять остаток резервации при FILLED через dust threshold.
    // Биржа округляет fill size (5.147233 → 5.14), ордер закрывается через dust threshold
    // (остаток 0.007233 < 0.01 = FILLED), но PortfolioService.applyFill снял резервацию
    // только на fillQty. Остаток застревает навсегда, блокируя будущие ордера.
    if (updatedOrder.isTerminal) {
      const remainingQty = updatedOrder.remainingSize.value();
      if (remainingQty.gt(0)) {
        if (fill.side === 'SELL') {
          // SELL: снять остаток токенной резервации
          const instrumentId = assetIdToInstrumentId(fill.tokenId);
          if (instrumentId) {
            const releaseResult = this._deps.portfolioService.releaseTokenReservation(
              fill.accountId,
              instrumentId,
              remainingQty,
            );
            if (releaseResult.ok) {
              this._logger.info('Released dust token reservation after SELL FILLED', {
                fillId: String(fill.id),
                orderId: String(fill.orderId),
                dustQty: remainingQty.toNumber(),
              });
            }
          }
        } else {
          // BUY: снять остаток USDC резервации (remainingQty × orderPrice)
          const dustNotional = remainingQty.times(order.price.value());
          const releaseResult = this._deps.portfolioService.releaseReservation(
            fill.accountId,
            dustNotional,
          );
          if (releaseResult.ok) {
            this._logger.info('Released dust USDC reservation after BUY FILLED', {
              fillId: String(fill.id),
              orderId: String(fill.orderId),
              dustQty: remainingQty.toNumber(),
              dustNotional: dustNotional.toNumber(),
            });
          }
        }
      }
    }

    // Запись в Ledger (sync)
    this._deps.ledgerService.recordFill(fill);

    // Снимаем все in-flight флаги ПЕРЕД публикацией событий.
    // КРИТИЧНО: publishAll ниже — await, создаёт yield-окно.
    // Обработчики ORDER_FILLED (OrderEventBridge) запланируют тик стратегии
    // через microtask (Promise.resolve().then(processQueue)).
    // Если флаги не сняты ДО yield — стратегия увидит hasInFlightFills=true
    // на тике, который выполнится ВНУТРИ await → зависнет в HOLD навсегда.
    // Безопасно: если другой fill для того же ордера ещё в пути,
    // следующий MATCHED-event заново поставит флаг (под своим fillId).
    this._clearInFlightFlags(fill);

    // Order/Portfolio/Ledger уже закоммичены синхронно выше — помечаем APPLIED
    // ДО публикации событий. Публикация может упасть (EventBus.publishAll
    // реально бросает), но состояние уже применено: если пометить fill FAILED
    // здесь, retry заново вызовет order.applyFill(fillData) с тем же fill.id —
    // Order defends against duplicate fill id и просто вернёт ошибку "duplicate
    // fill" на каждой попытке, вечно оставляя fill в FAILED без реального
    // прогресса и маскируя истинную причину (сбой публикации, а не бизнес-ошибка).
    // Поэтому publish-ошибка не должна делать fill retryable — она логируется
    // отдельно как потеря уведомления, а не как неприменённая мутация.
    await this._deps.processedFillRepo.markApplied(fill.id);

    // Публикация событий.
    // К этому моменту: Order = terminal (если FILLED), Portfolio = обновлён, флаги сняты.
    // Стратегия на тике увидит чистое состояние.
    const events = updatedOrder.pullEvents();
    try {
      await this._deps.eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('EVENT_PUBLISH_FAILED: Failed to publish fill events after commit — fill stays APPLIED, event lost', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        err: err instanceof Error ? err : new Error(message),
      });
      return Err(new TradingError(
        `Failed to publish fill events (fill already committed as APPLIED): ${message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }

    // Диагностика: при BUY fill с fee > 0 логируем fee deduction в токенах.
    // Polymarket on-chain settlement списывает fee из получаемых токенов (BUY).
    // feeInTokens = feeUSDC / price — конвертация из USDC в shares.
    // PortfolioService уже вычел feeInTokens из позиции при BUY.
    if (fill.side === 'BUY' && !fill.fee.isZero()) {
      const feeUSDC = fill.fee.quantity.amount().value();
      const fillPrice = fill.price.value();
      const feeInTokens = feeUSDC.div(fillPrice);
      const grossTokens = fill.size.value();
      this._logger.info('BUY fill fee deduction applied to portfolio', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        grossTokens: grossTokens.toNumber(),
        feeUSDC: feeUSDC.toNumber(),
        feeInTokens: feeInTokens.toNumber(),
        netTokens: grossTokens.minus(feeInTokens).toNumber(),
        price: fillPrice.toNumber(),
      });
    }

    this._logger.info('Fill processed successfully', {
      fillId: String(fill.id),
      orderId: String(fill.orderId),
      newOrderStatus: updatedOrder.status,
    });

    return Ok(undefined);
  }

  /**
   * Best-effort создание reconciliation issue при ORDER_PORTFOLIO_DESYNC.
   *
   * @param fill - Fill, обработка которого привела к частичному commit
   * @param reason - Та же причина, что передана в `markReconciliationRequired()`
   * @param errorMessage - Сообщение исходной ошибки Portfolio (для context)
   *
   * @remarks
   * No-op, если `reconciliationIssues` не передан в deps (optional dependency —
   * прежнее поведение сохраняется). Id детерминированный
   * (`reconciliation:fill:${fill.id}:order-portfolio-desync`) — `add()`
   * идемпотентен, повторная попытка не создаст дубль. Любая ошибка `add()`
   * логируется и проглатывается: issue — вторичный alerting-механизм, он не
   * должен маскировать исходную trading-ошибку и не должен менять исходный
   * error path (`markReconciliationRequired` + Err).
   */
  private async _addReconciliationIssue(
    fill: Fill,
    reason: string,
    errorMessage: string,
  ): Promise<void> {
    if (!this._deps.reconciliationIssues) {
      return;
    }
    const instrumentId = assetIdToInstrumentId(fill.tokenId);
    try {
      await this._deps.reconciliationIssues.add({
        id: `reconciliation:fill:${String(fill.id)}:order-portfolio-desync`,
        type: 'ORDER_PORTFOLIO_DESYNC',
        status: 'OPEN',
        reason,
        createdAt: this._deps.clock?.now() ?? new Date(),
        fillId: fill.id,
        orderId: fill.orderId,
        accountId: fill.accountId,
        ...(instrumentId ? { instrumentId } : {}),
        context: {
          stage: 'portfolio-apply-after-order-saved',
          error: errorMessage,
        },
      });
    } catch (err) {
      this._logger.error('Failed to add reconciliation issue', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Снимает in-flight флаги этого КОНКРЕТНОГО fill: order-level matched + instrument-level in-flight.
   *
   * @param fill - Обработанный fill
   *
   * @remarks
   * fillId-scoped (не order/instrument-wide) — партиальные fills того же
   * ордера/инструмента с ДРУГИМИ fillId не затрагиваются. Вызывается после
   * обработки fill (или на error path).
   *
   * Дополнительно снимается instrument-level placeholder
   * `pendingMatchFillId(fill.orderId)`: реальный fill «разрешает» более раннюю
   * неоднозначную пометку от cancel ALREADY_FILLED / submit FILLED (там
   * конкретный fillId неизвестен). Order-level placeholder аналогично снимает
   * `clearOrderFillMatched`. Placeholder снимается при ПЕРВОМ реальном fill
   * ордера; реальные fillId других partial fills не затрагиваются
   * (clearInFlightFill — no-op для неизвестных id).
   */
  private _clearInFlightFlags(fill: Fill): void {
    this._deps.orderStateStore.clearOrderFillMatched(fill.orderId, fill.id);
    this._deps.orderStateStore.clearInFlightFill(fill.id);
    this._deps.orderStateStore.clearInFlightFill(pendingMatchFillId(fill.orderId));
  }
}
