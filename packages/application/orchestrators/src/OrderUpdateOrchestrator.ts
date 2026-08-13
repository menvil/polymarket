/**
 * OrderUpdateOrchestrator — связывает ORDER_UPDATE_RECEIVED → UpdateOrderStatusUseCase.
 *
 * @remarks
 * Единственный компонент, отвечающий на вопрос «кто вызывает UpdateOrderStatusUseCase?».
 *
 * ### Принципы разделения ответственности:
 * - `OrderUpdateHandler` (handlers): парсит WS, публикует ORDER_UPDATE_RECEIVED
 * - `OrderUpdateOrchestrator` (этот класс): подписывается и вызывает use case
 * - `UpdateOrderStatusUseCase` (use-cases): применяет обновление к Order + Portfolio
 *
 * ### Прямой вызов для reconciliation:
 * Reconciler может вызывать UpdateOrderStatusUseCase напрямую (не через EventBus)
 * чтобы гарантировать синхронную обработку в рамках reconcile loop.
 *
 * @example
 * ```typescript
 * const orchestrator = new OrderUpdateOrchestrator({
 *   eventBus,
 *   updateOrderStatus,
 *   logger,
 * });
 * orchestrator.register();
 * // При shutdown:
 * orchestrator.unregister();
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { IEventBus, VenueOrderUpdate } from '@polymarket/event-bus';
import type { AccountId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import type { TradingError } from '@polymarket/errors';

/**
 * Интерфейс use case обновления статуса ордера.
 *
 * @remarks
 * Определён локально для decoupling orchestrators от пакета use-cases.
 * TypeScript structural typing гарантирует совместимость с UpdateOrderStatusUseCase.
 */
export interface IOrderStatusUpdater {
  execute(input: {
    update: VenueOrderUpdate;
    accountId: AccountId;
  }): Promise<Result<void, TradingError>>;
}

/**
 * Зависимости OrderUpdateOrchestrator.
 */
export interface OrderUpdateOrchestratorDeps {
  readonly eventBus: IEventBus;
  readonly updateOrderStatus: IOrderStatusUpdater;
  readonly logger: ILogger;
}

/**
 * Оркестратор обработки venue-обновлений статуса ордеров.
 *
 * @remarks
 * Подписывается на ORDER_UPDATE_RECEIVED и делегирует UpdateOrderStatusUseCase.
 * Ошибки логируются, но не останавливают subscription loop.
 */
export class OrderUpdateOrchestrator {
  private readonly _eventBus: IEventBus;
  private readonly _updateOrderStatus: IOrderStatusUpdater;
  private readonly _logger: ILogger;
  private _unsub?: () => void;

  /**
   * @param deps - Зависимости оркестратора
   */
  constructor(deps: OrderUpdateOrchestratorDeps) {
    this._eventBus = deps.eventBus;
    this._updateOrderStatus = deps.updateOrderStatus;
    this._logger = deps.logger.child({ component: 'OrderUpdateOrchestrator' });
  }

  /**
   * Регистрирует подписку на ORDER_UPDATE_RECEIVED.
   *
   * @remarks
   * Идемпотентен — повторный register() отписывается от предыдущей подписки.
   */
  public register(): void {
    if (this._unsub) {
      this._unsub();
    }

    this._unsub = this._eventBus.subscribe('ORDER_UPDATE_RECEIVED', async (event) => {
      try {
        const result = await this._updateOrderStatus.execute({
          update: event.update,
          accountId: event.accountId,
        });
        if (!result.ok) {
          this._logger.error('UpdateOrderStatusUseCase failed', {
            orderId: String(event.update.orderId),
            updateType: event.update.type,
            error: result.error.message,
          });
        }
      } catch (err) {
        this._logger.error('Unexpected error processing order update', {
          orderId: String(event.update.orderId),
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });

    this._logger.info('OrderUpdateOrchestrator registered');
  }

  /**
   * Отписывается от ORDER_UPDATE_RECEIVED.
   *
   * @remarks
   * Вызывать при graceful shutdown.
   */
  public unregister(): void {
    this._unsub?.();
    this._unsub = undefined;
    this._logger.debug('OrderUpdateOrchestrator unregistered');
  }
}
