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
import type { IOrderRepository, IExchangeClient } from '@polymarket/ports';
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

    // Шаг 2: Отмена Order
    const cancelResult = await this._deps.orderService.cancel(order, input.reason);
    if (!cancelResult.ok) {
      return Err(new TradingError(
        `Failed to cancel order: ${cancelResult.error.message}`,
        { context: { orderId: String(input.orderId), status: order.status } },
      ));
    }
    const cancelledOrder = cancelResult.value;

    // Шаг 3: Снятие резервации (только для BUY ордеров — у SELL нет резервации)
    if (order.side === 'BUY') {
      const remainingNotional = order.price.value().times(order.remainingSize.value());
      const releaseResult = this._deps.portfolioService.releaseReservation(
        input.accountId,
        remainingNotional,
      );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation after cancel', {
          orderId: String(input.orderId),
          error: releaseResult.error.message,
        });
        // Не прерываем — ордер уже отменён
      }
    }

    // Шаг 4: Best-effort отмена на бирже
    const exchangeResult = await this._deps.exchangeClient.cancelOrder(input.orderId);
    if (!exchangeResult.ok) {
      this._logger.warn('Exchange cancel failed (best effort)', {
        orderId: String(input.orderId),
        error: exchangeResult.error.message,
      });
      // Не прерываем — продолжаем публикацию событий
    }

    // Шаг 5: Публикация событий
    const events = cancelledOrder.pullEvents();
    await this._deps.eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);

    this._logger.info('Order cancelled successfully', {
      orderId: String(input.orderId),
      reason: input.reason ?? 'User cancelled',
    });

    return Ok(undefined);
  }
}
