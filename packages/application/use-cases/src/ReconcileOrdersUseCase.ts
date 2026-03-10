/**
 * ReconcileOrdersUseCase — сверка локальных открытых ордеров с биржевыми.
 *
 * @remarks
 * ### Назначение:
 * Обнаруживает ордера, которые существуют локально в статусе OPEN/PARTIALLY_FILLED,
 * но отсутствуют на бирже (внешняя отмена, истечение, технический сбой).
 *
 * ### Алгоритм:
 * 1. `orderRepo.getAll()` — получить все локальные ордера
 * 2. Фильтр: только OPEN/PARTIALLY_FILLED (не терминальные)
 * 3. `exchangeClient.getOpenOrders(accountId)` — получить открытые ордера биржи
 * 4. Построить Set из orderId биржи для O(1)-поиска
 * 5. Для каждого локального ордера, отсутствующего на бирже:
 *    - `order.cancel()` → новый Order в статусе CANCELED
 *    - Сохранить через `orderRepo.save(cancelledOrder)`
 *    - Опубликовать ORDER_CANCELLED событие через eventBus
 * 6. Вернуть ReconciliationReport
 *
 * ### Идемпотентность:
 * Повторный вызов с теми же данными безопасен — ордера уже в CANCELED статусе
 * и будут отфильтрованы на шаге 2.
 *
 * @example
 * ```typescript
 * const useCase = new ReconcileOrdersUseCase({
 *   orderRepo, exchangeClient, eventBus, logger,
 * });
 *
 * const result = await useCase.execute({ accountId });
 * if (result.ok) {
 *   logger.info('Reconciliation complete', result.value);
 * }
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import type { IOrderRepository, IExchangeClient } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';

/** Зависимости ReconcileOrdersUseCase */
export interface ReconcileOrdersDeps {
  readonly orderRepo: IOrderRepository;
  readonly exchangeClient: IExchangeClient;
  readonly eventBus: IEventBus;
  readonly logger: ILogger;
}

/** Входные данные для ReconcileOrdersUseCase */
export interface ReconcileOrdersInput {
  /** ID аккаунта для сверки */
  readonly accountId: AccountId;
}

/**
 * Отчёт о результатах сверки ордеров.
 */
export interface ReconciliationReport {
  /** Количество проверенных открытых ордеров */
  readonly checkedCount: number;
  /** Количество обнаруженных исполненных ордеров (заполнено биржей) */
  readonly filledCount: number;
  /** Количество ордеров, отменённых внешне (отсутствуют на бирже) */
  readonly externalCancelCount: number;
  /** Количество ошибок при обработке */
  readonly errorCount: number;
}

/**
 * Use case сверки открытых ордеров с биржей.
 *
 * @remarks
 * Обнаруживает внешние отмены ордеров, переводит их в CANCELED статус
 * и публикует ORDER_CANCELLED события.
 */
export class ReconcileOrdersUseCase {
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости use case
   */
  constructor(private readonly _deps: ReconcileOrdersDeps) {
    this._logger = _deps.logger.child({ component: 'ReconcileOrdersUseCase' });
  }

  /**
   * Выполняет сверку открытых ордеров.
   *
   * @param input - Входные данные с accountId
   * @returns Ok(ReconciliationReport) при успехе, Err при критической ошибке
   *
   * @remarks
   * Ошибки биржи (ExchangeError) приводят к Err.
   * Ошибки отдельных ордеров логируются и отражаются в errorCount.
   */
  public async execute(input: ReconcileOrdersInput): Promise<Result<ReconciliationReport, TradingError>> {
    this._logger.info('Starting order reconciliation', {
      accountId: String(input.accountId),
    });

    // Шаг 1: Получить все локальные ордера
    const allOrders = await this._deps.orderRepo.getAll();

    // Шаг 2: Фильтр — только открытые (не терминальные)
    const openOrders = allOrders.filter(
      (order) => order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED',
    );

    if (openOrders.length === 0) {
      this._logger.debug('No open orders to reconcile');
      return Ok({ checkedCount: 0, filledCount: 0, externalCancelCount: 0, errorCount: 0 });
    }

    // Шаг 3: Получить открытые ордера от биржи
    const exchangeResult = await this._deps.exchangeClient.getOpenOrders(input.accountId);
    if (!exchangeResult.ok) {
      this._logger.error('Failed to fetch open orders from exchange', {
        error: exchangeResult.error.message,
      });
      return Err(new TradingError(
        `Exchange getOpenOrders failed: ${exchangeResult.error.message}`,
        { context: { accountId: String(input.accountId) } },
      ));
    }

    // Шаг 4: Set из orderId биржи для O(1)-поиска
    const venueOrderIds = new Set(
      exchangeResult.value.map((snap) => String(snap.orderId)),
    );

    let externalCancelCount = 0;
    let errorCount = 0;

    // Шаг 5: Сверка — ордера, отсутствующие на бирже
    for (const order of openOrders) {
      const orderIdStr = String(order.id);

      if (!venueOrderIds.has(orderIdStr)) {
        // Ордер есть локально, но отсутствует на бирже → внешняя отмена
        this._logger.warn('Order not found on exchange, marking as externally cancelled', {
          orderId: orderIdStr,
          status: order.status,
        });

        // Отменить Order entity
        const cancelResult = order.cancel('External cancel: order not found on exchange');
        if (!cancelResult.ok) {
          this._logger.error('Failed to cancel order entity during reconciliation', {
            orderId: orderIdStr,
            error: cancelResult.error.message,
          });
          errorCount++;
          continue;
        }

        const cancelledOrder = cancelResult.value;

        try {
          // Сохранить обновлённое состояние
          await this._deps.orderRepo.save(cancelledOrder);

          // Опубликовать доменные события
          const events = cancelledOrder.pullEvents();
          await this._deps.eventBus.publishAll(
            events as Parameters<IEventBus['publishAll']>[0],
          );

          externalCancelCount++;
        } catch (err) {
          this._logger.error('Failed to persist or publish reconciled cancel', {
            orderId: orderIdStr,
            error: err instanceof Error ? err.message : String(err),
          });
          errorCount++;
        }
      }
    }

    const report: ReconciliationReport = {
      checkedCount: openOrders.length,
      filledCount: 0,
      externalCancelCount,
      errorCount,
    };

    this._logger.info('Order reconciliation complete', { ...report });

    return Ok(report);
  }
}
