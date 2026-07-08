/**
 * CancelOrderUseCase — оркестрация отмены торгового ордера.
 *
 * @remarks
 * ### Алгоритм:
 * 1. Быстрый предварительный lookup Order (вне lock) — fail fast, если ордер не существует.
 * 2. Keyed mutex (`IKeyedMutex.runExclusive`) по [accountId, orderId, instrumentId] —
 *    сериализует эту отмену относительно `ProcessFillUseCase` для того же ордера.
 * 3. Внутри lock: свежий lookup Order (состояние могло измениться, пока ждали lock).
 * 4. Блокировка отмены, если у ордера есть matched fills ИЛИ у инструмента —
 *    in-flight fills (fill(ы) уже в пути on-chain — отмена вызовет portfolio desync).
 * 5. Отмена Order (order.cancel() → CANCELED + orderRepo.save())
 * 6. Снятие резервации баланса (PortfolioService.releaseReservation)
 * 7. Запрос отмены на бирже (exchangeClient.cancelOrder — best effort)
 * 8. Публикация доменных событий
 *
 * ### Best-effort биржевая отмена:
 * Ошибка exchangeClient.cancelOrder логируется, но не прерывает use case —
 * ордер уже отменён на нашей стороне. Reconciliation обработает расхождение.
 *
 * ### Идемпотентность:
 * Если ордер уже в терминальном статусе (CANCELED/FILLED/etc), order.cancel()
 * вернёт Err, который транслируется в Ok(void) чтобы избежать повторной ошибки.
 *
 * @example
 * ```typescript
 * const useCase = new CancelOrderUseCase({
 *   orderService, portfolioService, orderRepo, keyedMutex, exchangeClient, eventBus, logger,
 * });
 *
 * const result = await useCase.execute({ orderId, accountId, reason: 'Risk limit' });
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { AccountId, OrderId } from '@polymarket/ids';
import { assetIdToInstrumentId, accountIdToString } from '@polymarket/ids';
import type { IOrderRepository, IOrderStateStore, IExchangeClient, IKeyedMutex } from '@polymarket/ports';
import { pendingMatchFillId } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import type { PortfolioService } from './services/PortfolioService.js';

/** Входные данные для CancelOrderUseCase */
export interface CancelOrderInput {
  /** ID ордера для отмены */
  readonly orderId: OrderId;
  /** ID аккаунта владельца ордера */
  readonly accountId: AccountId;
  /** Причина отмены (опционально) */
  readonly reason?: string;
}

/** Зависимости CancelOrderUseCase */
export interface CancelOrderDeps {
  readonly portfolioService: PortfolioService;
  readonly orderRepo: IOrderRepository;
  readonly orderStateStore: IOrderStateStore;
  readonly keyedMutex: IKeyedMutex;
  readonly exchangeClient: IExchangeClient;
  readonly eventBus: IEventBus;
  readonly logger: ILogger;
}

/**
 * Use case отмены торгового ордера.
 *
 * @remarks
 * Оркестрирует отмену ордера с откатом резервации баланса
 * и best-effort запросом к бирже.
 */
export class CancelOrderUseCase {
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости use case
   */
  constructor(private readonly _deps: CancelOrderDeps) {
    this._logger = _deps.logger.child({ component: 'CancelOrderUseCase' });
  }

  /**
   * Выполняет отмену ордера.
   *
   * @param input - Входные данные с orderId и accountId
   * @returns Ok(void) при успехе или если ордер уже в терминальном статусе
   *
   * @remarks
   * Ошибки биржи (exchangeClient.cancelOrder) не приводят к возврату Err —
   * ордер отменяется локально в любом случае.
   */
  public async execute(input: CancelOrderInput): Promise<Result<void, TradingError>> {
    // Быстрый lookup вне lock — fail fast, если ордера вообще нет.
    // instrumentId нужен для ключа блокировки; берём его из этого lookup.
    const preflightOrder = await this._deps.orderRepo.get(input.orderId);
    if (!preflightOrder) {
      this._logger.warn('Order not found for cancellation', { orderId: String(input.orderId) });
      return Err(new TradingError(
        `Order not found: ${String(input.orderId)}`,
        { context: { orderId: String(input.orderId) } },
      ));
    }

    const instrumentId = assetIdToInstrumentId(preflightOrder.asset);
    const lockKeys = [
      accountIdToString(input.accountId),
      String(input.orderId),
      instrumentId ? String(instrumentId) : String(preflightOrder.asset),
    ];

    return this._deps.keyedMutex.runExclusive(lockKeys, () => this._cancelLocked(input, instrumentId));
  }

  /**
   * Тело отмены — вызывается ВНУТРИ keyed mutex.
   *
   * @param input - Входные данные с orderId и accountId
   * @param instrumentId - InstrumentId ордера (для in-flight проверки), либо undefined
   * @returns Ok(void) при успехе, Err(TradingError) при ошибке
   */
  private async _cancelLocked(
    input: CancelOrderInput,
    instrumentId: ReturnType<typeof assetIdToInstrumentId>,
  ): Promise<Result<void, TradingError>> {
    // Свежий lookup — состояние могло измениться, пока ждали lock
    // (например, ProcessFillUseCase уже применил fill и освободил lock).
    const order = await this._deps.orderRepo.get(input.orderId);
    if (!order) {
      this._logger.warn('Order not found for cancellation', { orderId: String(input.orderId) });
      return Err(new TradingError(
        `Order not found: ${String(input.orderId)}`,
        { context: { orderId: String(input.orderId) } },
      ));
    }

    // Уже в терминальном статусе — идемпотентный выход
    if (order.isTerminal) {
      this._logger.debug('Order already in terminal status, skipping cancel', {
        orderId: String(input.orderId),
        status: order.status,
      });
      return Ok(undefined);
    }

    // Matched fills на ордере — хотя бы один fill уже исполнен на бирже, отмена
    // невозможна. WS сообщил MATCHED → fill(ы) идут в пути → portfolio обновится
    // через ProcessFillUseCase. Попытка cancel здесь вызовет race: fill придёт
    // на "не найден" ордер → portfolio desync.
    if (this._deps.orderStateStore.hasMatchedFills(input.orderId)) {
      this._logger.info('Order has matched fills — skipping cancel to prevent fill desync', {
        orderId: String(input.orderId),
        status: order.status,
        matchedFillIds: this._deps.orderStateStore.getMatchedFillIds(input.orderId).map(String),
      });
      return Ok(undefined);
    }

    // In-flight fills на инструменте — даже если ЭТОТ ордер не помечен matched,
    // на инструменте может быть fill в пути (например, после предыдущего cancel
    // ордер уже удалён из repo, но fill ещё не CONFIRMED). Отмена нового ордера
    // того же инструмента может привести к double-buy: cancel → place → fill(старый).
    if (instrumentId && this._deps.orderStateStore.hasInFlightFills(instrumentId)) {
      this._logger.info('Instrument has in-flight fills — skipping cancel to prevent race', {
        orderId: String(input.orderId),
        instrumentId: String(instrumentId),
        inFlightFillIds: this._deps.orderStateStore.getInFlightFills(instrumentId).map((f) => String(f.fillId)),
      });
      return Ok(undefined);
    }

    // Отмена Order
    const cancelResult = order.cancel(input.reason);
    if (!cancelResult.ok) {
      this._logger.warn('Failed to cancel order', {
        orderId: String(input.orderId),
        status: order.status,
        error: cancelResult.error.message,
      });
      return Err(new TradingError(
        `Failed to cancel order: ${cancelResult.error.message}`,
        { context: { orderId: String(input.orderId), status: order.status } },
      ));
    }
    const cancelledOrder = cancelResult.value;
    try {
      await this._deps.orderRepo.save(cancelledOrder);
    } catch (err) {
      this._logger.error('Failed to save order after cancel', {
        orderId: String(input.orderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return Err(new TradingError(
        `Failed to save order: ${err instanceof Error ? err.message : String(err)}`,
        { context: { orderId: String(input.orderId) } },
      ));
    }

    // Снятие резервации по стороне ордера.
    //
    // Перед снятием — синхронная проверка актуального статуса (без yield):
    // `orderRepo.save()` содержит async yield; во время него ProcessFillUseCase
    // мог выполнить saveSync(FILED) → резервация уже потреблена fill. Keyed mutex
    // (шаг 2 в execute()) исключает это для НОВЫХ обработок, но этот caller мог
    // войти в `_cancelLocked` до того, как mutex поддержку добавили везде — эта
    // проверка остаётся defense-in-depth.
    // Если статус в store отличается — пропускаем освобождение.
    const currentStoredOrder = this._deps.orderStateStore.getOrder(input.orderId);
    if (currentStoredOrder?.status !== cancelledOrder.status) {
      this._logger.debug('Order status changed during cancel (concurrent fill), skipping reservation release', {
        orderId: String(input.orderId),
        cancelledStatus: cancelledOrder.status,
        currentStatus: currentStoredOrder?.status,
      });
    } else {
      this._deps.portfolioService.releaseOrderReservation(input.accountId, cancelledOrder);
    }

    // Best-effort отмена на бирже
    const exchangeResult = await this._deps.exchangeClient.cancelOrder(input.orderId);
    let matchedOnExchange = false;
    if (!exchangeResult.ok) {
      // Парсим: "matched orders can't be canceled" → ордер уже matched на бирже.
      // Помечаем чтобы fill был подхвачен через WS или ReconcileTradesUseCase.
      // Конкретный fillId здесь неизвестен (только текст ошибки cancel) —
      // используем pendingMatchFillId placeholder; он автоматически снимется
      // в clearOrderFillMatched, когда придёт реальный fill для этого ордера.
      const errMsg = exchangeResult.error.message.toLowerCase();
      if (errMsg.includes('matched') || errMsg.includes("can't be canceled") || errMsg.includes('cannot be canceled')) {
        matchedOnExchange = true;
        this._deps.orderStateStore.markOrderFillMatched(input.orderId, pendingMatchFillId(input.orderId));
        this._logger.warn('Cancel rejected — order was matched on exchange, awaiting fill via WS/reconciliation', {
          orderId: String(input.orderId),
          error: exchangeResult.error.message,
        });
      } else {
        this._logger.warn('Exchange cancel failed (best effort)', {
          orderId: String(input.orderId),
          error: exchangeResult.error.message,
        });
      }
    }

    // Публикация событий
    const events = cancelledOrder.pullEvents();
    try {
      await this._deps.eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);
    } catch (err) {
      this._logger.error('Failed to publish cancel events', {
        orderId: String(input.orderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return Err(new TradingError(
        `Failed to publish events: ${err instanceof Error ? err.message : String(err)}`,
        { context: { orderId: String(input.orderId) } },
      ));
    }

    if (matchedOnExchange) {
      this._logger.warn('Order locally cancelled but matched on exchange — fill expected', {
        orderId: String(input.orderId),
        reason: input.reason ?? 'User cancelled',
      });
    } else {
      this._logger.info('Order cancelled successfully', {
        orderId: String(input.orderId),
        reason: input.reason ?? 'User cancelled',
      });
    }

    return Ok(undefined);
  }
}
