/**
 * CancelOrderUseCase — оркестрация отмены торгового ордера.
 *
 * @remarks
 * ### Алгоритм:
 * 1. Получение Order из репозитория
 * 2. Отмена Order (OrderService.cancel → CANCELED)
 * 3. Снятие резервации баланса (PortfolioService.releaseReservation)
 * 4. Запрос отмены на бирже (exchangeClient.cancelOrder — best effort)
 * 5. Публикация доменных событий
 *
 * ### Best-effort биржевая отмена:
 * Ошибка exchangeClient.cancelOrder логируется, но не прерывает use case —
 * ордер уже отменён на нашей стороне. Reconciliation обработает расхождение.
 *
 * ### Идемпотентность:
 * Если ордер уже в терминальном статусе (CANCELED/FILLED/etc), OrderService.cancel
 * вернёт Err, который транслируется в Ok(void) чтобы избежать повторной ошибки.
 *
 * @example
 * ```typescript
 * const useCase = new CancelOrderUseCase({
 *   orderService, portfolioService, orderRepo, exchangeClient, eventBus, logger,
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
import { assetIdToInstrumentId } from '@polymarket/ids';
import type { IOrderRepository, IOrderStateStore, IExchangeClient } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import type { OrderService } from './services/OrderService.js';
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
  readonly orderService: OrderService;
  readonly portfolioService: PortfolioService;
  readonly orderRepo: IOrderRepository;
  readonly orderStateStore: IOrderStateStore;
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
    // Шаг 1: Получить Order
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

    // MATCHED на бирже — ордер уже исполнен, отмена невозможна.
    // WS сообщил status=MATCHED → fill(ы) идут в пути → portfolio обновится через ProcessFillUseCase.
    // Попытка cancel здесь вызовет race: fill придёт на "не найден" ордер → portfolio desync.
    if (this._deps.orderStateStore.isMatchedOnExchange(input.orderId)) {
      this._logger.info('Order is MATCHED on exchange — skipping cancel to prevent fill desync', {
        orderId: String(input.orderId),
        status: order.status,
      });
      return Ok(undefined);
    }

    // Шаг 2: Отмена Order
    const cancelResult = await this._deps.orderService.cancel(order, input.reason);
    if (!cancelResult.ok) {
      return Err(new TradingError(
        `Failed to cancel order: ${cancelResult.error.message}`,
        { context: { orderId: String(input.orderId), status: order.status } },
      ));
    }
    const cancelledOrder = cancelResult.value;

    // Шаг 3: Снятие резервации по стороне ордера
    //
    // ВАЖНО: проверяем актуальный статус ордера в store перед снятием резервации.
    // `orderService.cancel()` содержит `await orderRepo.save()` (yield B).
    // Во время yield B мог выполниться ProcessFillUseCase:
    //   - saveSync(FILED) → перезаписал CANCELLED → FILED в store
    //   - portfolioApplyFill → reservation потреблена (reserved = 0)
    // Если это произошло — нельзя снимать резервацию повторно (она уже потреблена fill).
    // Синхронная проверка (без yield) читает актуальное состояние из store.
    const currentStoredOrder = this._deps.orderStateStore.getOrder(input.orderId);
    if (currentStoredOrder?.status !== cancelledOrder.status) {
      // Ордер был изменён конкурентно (fill перезаписал CANCELLED → FILED).
      // Резервация уже потреблена fill — пропускаем освобождение.
      this._logger.debug('Order status changed during cancel (concurrent fill), skipping reservation release', {
        orderId: String(input.orderId),
        cancelledStatus: cancelledOrder.status,
        currentStatus: currentStoredOrder?.status,
      });
    } else if (order.side === 'BUY') {
      const remainingNotional = cancelledOrder.price.value().times(cancelledOrder.remainingSize.value());
      const releaseResult = this._deps.portfolioService.releaseReservation(
        input.accountId,
        remainingNotional,
      );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release USDC reservation after BUY cancel', {
          orderId: String(input.orderId),
          error: releaseResult.error.message,
        });
        // Не прерываем — ордер уже отменён
      }
    } else {
      // SELL: освободить токенную резервацию
      const instrumentId = assetIdToInstrumentId(cancelledOrder.asset);
      if (instrumentId) {
        const remainingQty = cancelledOrder.remainingSize.value();
        const releaseResult = this._deps.portfolioService.releaseTokenReservation(
          input.accountId,
          instrumentId,
          remainingQty,
        );
        if (!releaseResult.ok) {
          this._logger.error('Failed to release token reservation after SELL cancel', {
            orderId: String(input.orderId),
            error: releaseResult.error.message,
          });
          // Не прерываем — ордер уже отменён
        }
      } else {
        this._logger.warn('Could not resolve instrumentId for SELL order cancel', {
          orderId: String(input.orderId),
          asset: String(cancelledOrder.asset),
        });
      }
    }

    // Шаг 4: Best-effort отмена на бирже
    const exchangeResult = await this._deps.exchangeClient.cancelOrder(input.orderId);
    let matchedOnExchange = false;
    if (!exchangeResult.ok) {
      // Парсим: "matched orders can't be canceled" → ордер уже matched на бирже.
      // Помечаем чтобы fill был подхвачен через WS или ReconcileTradesUseCase.
      const errMsg = exchangeResult.error.message.toLowerCase();
      if (errMsg.includes('matched') || errMsg.includes("can't be canceled") || errMsg.includes('cannot be canceled')) {
        matchedOnExchange = true;
        this._deps.orderStateStore.markMatchedOnExchange(input.orderId);
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

    // Шаг 5: Публикация событий
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
