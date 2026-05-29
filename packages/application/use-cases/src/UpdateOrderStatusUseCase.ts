/**
 * UpdateOrderStatusUseCase — применяет venue-обновление статуса к Order entity.
 *
 * @remarks
 * Содержит всю доменную логику, ранее находившуюся в `OrderUpdateHandler`.
 * Тонкий `OrderUpdateHandler` теперь только парсит WS и публикует
 * `ORDER_UPDATE_RECEIVED`; `OrderUpdateOrchestrator` вызывает этот use case.
 *
 * ### Алгоритм:
 * 1. Получить Order из репозитория
 * 2. Применить доменный метод (accept/reject/cancel/expire)
 * 3. Обработать idempotent/race сценарии
 * 4. Для CANCELLED/EXPIRED — освободить резервацию Portfolio с защитой от concurrent fill
 * 5. Сохранить обновлённый Order в репозиторий
 * 6. Опубликовать OrderEvent[] в EventBus
 *
 * ### Защита от concurrent fill:
 * Между шагами 2 и 4 (async repo.save) мог выполниться ProcessFillUseCase
 * и перезаписать Order статус (FILLED). Синхронная проверка orderStateStore
 * (без yield) читает актуальное состояние — пропускаем release если резервация
 * уже потреблена fill.
 *
 * @example
 * ```typescript
 * const useCase = new UpdateOrderStatusUseCase({
 *   orderRepo, orderStateStore, portfolioService, eventBus, logger,
 * });
 * const result = await useCase.execute({
 *   update: { type: 'CANCELLED', orderId },
 *   accountId,
 * });
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { AccountId, OrderId } from '@polymarket/ids';
import { assetIdToInstrumentId } from '@polymarket/ids';
import type { IOrderRepository, IOrderStateStore } from '@polymarket/ports';
import type { IEventBus, ApplicationEvent, VenueOrderUpdate } from '@polymarket/event-bus';
import type { PortfolioService } from './services/PortfolioService.js';

/** Входные данные для UpdateOrderStatusUseCase */
export interface UpdateOrderStatusInput {
  /** Venue-обновление статуса с типом и orderId */
  readonly update: VenueOrderUpdate;
  /** ID аккаунта — нужен для операций с Portfolio */
  readonly accountId: AccountId;
}

/** Зависимости UpdateOrderStatusUseCase */
export interface UpdateOrderStatusDeps {
  readonly orderRepo: IOrderRepository;
  readonly orderStateStore: IOrderStateStore;
  readonly portfolioService: PortfolioService;
  readonly eventBus: IEventBus;
  readonly logger: ILogger;
}

/**
 * Use case применения venue-обновления статуса ордера.
 *
 * @remarks
 * Вызывается `OrderUpdateOrchestrator` при подписке на `ORDER_UPDATE_RECEIVED`
 * или напрямую из reconciler для синхронной обработки.
 */
export class UpdateOrderStatusUseCase {
  private readonly _logger: ILogger;

  /**
   * @param _deps - Зависимости use case
   */
  constructor(private readonly _deps: UpdateOrderStatusDeps) {
    this._logger = _deps.logger.child({ component: 'UpdateOrderStatusUseCase' });
  }

  /**
   * Применяет venue-обновление статуса к существующему ордеру.
   *
   * @param input - Входные данные с update и accountId
   * @returns Ok(void) при успехе или идемпотентном skip, Err при критических сбоях
   *
   * @remarks
   * Idempotent: дублирующие события (ACCEPTED на OPEN, CANCELLED на CANCELED) —
   * логируются на уровне debug/warn и возвращают Ok(void).
   */
  public async execute(input: UpdateOrderStatusInput): Promise<Result<void, TradingError>> {
    const { update, accountId } = input;
    const orderId: OrderId = update.orderId;

    // Шаг 1: Получить Order
    const order = await this._deps.orderRepo.get(orderId);
    if (!order) {
      this._logger.warn('Order not found for venue update', {
        orderId: String(orderId),
        updateType: update.type,
      });
      return Ok(undefined);
    }

    // Шаг 2: Применить доменный метод
    let result;
    switch (update.type) {
      case 'ACCEPTED':
        result = order.accept();
        break;
      case 'REJECTED':
        result = order.reject(update.reason);
        break;
      case 'CANCELLED':
        result = order.cancel(update.reason);
        break;
      case 'EXPIRED':
        result = order.expire();
        break;
    }

    // Шаг 3: Обработать idempotent/race сценарии
    if (!result.ok) {
      const isIdempotent =
        (update.type === 'ACCEPTED'  && order.status === 'OPEN')    ||
        (update.type === 'CANCELLED' && order.status === 'CANCELED') ||
        (update.type === 'EXPIRED'   && order.status === 'EXPIRED');

      // ACCEPTED на терминальном ордере — гонка между REST-cancel и WS-confirmation.
      const isCancelRace = update.type === 'ACCEPTED' && order.isTerminal;

      if (isIdempotent) {
        this._logger.debug('Ignoring duplicate venue update (already in target state)', {
          orderId: String(orderId),
          updateType: update.type,
          currentStatus: order.status,
        });
        return Ok(undefined);
      } else if (isCancelRace) {
        this._logger.warn('ACCEPTED event arrived after order already terminal (cancel/fill race) — ignoring', {
          orderId: String(orderId),
          currentStatus: order.status,
          updateType: update.type,
        });
        return Ok(undefined);
      } else {
        this._logger.error('Failed to apply order update', {
          error: result.error.message,
          orderId: String(orderId),
          updateType: update.type,
        });
        return Err(new TradingError(
          `Failed to apply order update: ${result.error.message}`,
          { context: { orderId: String(orderId), updateType: update.type } },
        ));
      }
    }

    const updatedOrder = result.value;

    // Шаг 4: Для venue-initiated отмен — освободить резервацию Portfolio.
    // Проверяем актуальный статус в orderStateStore (синхронно, без yield) —
    // защита от concurrent fill: если fill уже применён и обновил order в store,
    // резервация потреблена → пропускаем release.
    if (update.type === 'CANCELLED' || update.type === 'EXPIRED') {
      const currentStoredOrder = this._deps.orderStateStore.getOrder(orderId);
      if (currentStoredOrder && currentStoredOrder.status !== updatedOrder.status) {
        this._logger.debug(
          'Order status changed during cancel (concurrent fill) — skipping reservation release',
          {
            orderId: String(orderId),
            cancelledStatus: updatedOrder.status,
            currentStatus: currentStoredOrder.status,
          },
        );
      } else if (order.side === 'BUY') {
        const remainingNotional = updatedOrder.price.value().times(updatedOrder.remainingSize.value());
        const releaseResult = this._deps.portfolioService.releaseReservation(accountId, remainingNotional);
        if (!releaseResult.ok) {
          this._logger.error('Failed to release USDC reservation after BUY cancel/expire', {
            orderId: String(orderId),
            error: releaseResult.error.message,
          });
          // Не прерываем — ордер уже отменён
        }
      } else {
        // SELL: освободить резервацию токенов
        const instrumentId = assetIdToInstrumentId(updatedOrder.asset);
        if (instrumentId) {
          const releaseResult = this._deps.portfolioService.releaseTokenReservation(
            accountId,
            instrumentId,
            updatedOrder.remainingSize.value(),
          );
          if (!releaseResult.ok) {
            this._logger.error('Failed to release token reservation after SELL cancel/expire', {
              orderId: String(orderId),
              error: releaseResult.error.message,
            });
            // Не прерываем — ордер уже отменён
          }
        } else {
          this._logger.warn('Could not resolve instrumentId for SELL order cancel/expire', {
            orderId: String(orderId),
            asset: String(updatedOrder.asset),
          });
        }
      }
    }

    // Шаг 5: Сохранить обновлённый Order
    const events = updatedOrder.pullEvents();
    try {
      await this._deps.orderRepo.save(updatedOrder);
    } catch (err) {
      this._logger.error('Failed to save order after venue update', {
        orderId: String(orderId),
        updateType: update.type,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return Err(new TradingError(
        `Failed to save order: ${err instanceof Error ? err.message : String(err)}`,
        { context: { orderId: String(orderId) } },
      ));
    }

    // Шаг 6: Опубликовать OrderEvent[]
    if (events.length > 0) {
      try {
        await this._deps.eventBus.publishAll(events as readonly ApplicationEvent[]);
      } catch (err) {
        this._logger.error('Failed to publish order events', {
          orderId: String(orderId),
          updateType: update.type,
          err: err instanceof Error ? err : new Error(String(err)),
        });
        return Err(new TradingError(
          `Failed to publish events: ${err instanceof Error ? err.message : String(err)}`,
          { context: { orderId: String(orderId) } },
        ));
      }
    }

    this._logger.info('Order update applied', {
      orderId: String(orderId),
      updateType: update.type,
    });

    return Ok(undefined);
  }
}
