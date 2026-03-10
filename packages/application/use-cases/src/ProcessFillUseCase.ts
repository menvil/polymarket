/**
 * ProcessFillUseCase — оркестрация обработки исполнения ордера (Fill).
 *
 * @remarks
 * ### Алгоритм:
 * 1. Idempotency guard (IProcessedFillRepository.markIfNotExists)
 *    — при дублирующемся fill возвращает Ok без повторной обработки
 * 2. Получение Order из репозитория
 * 3. Применение Fill к Order (OrderService.applyFill)
 * 4. Обновление Portfolio (PortfolioService.applyFill)
 * 5. Запись в Ledger (LedgerService.recordFill)
 * 6. Публикация доменных событий Order
 *
 * ### Идемпотентность:
 * Повторный вызов с тем же fillId безопасен — шаг 1 предотвращает
 * повторную обработку. Гарантирует «exactly once» семантику.
 *
 * ### Консистентность:
 * Order и Portfolio обновляются независимо. При VersionConflictError
 * на Portfolio caller должен повторить операцию.
 *
 * @example
 * ```typescript
 * const useCase = new ProcessFillUseCase({
 *   orderService, portfolioService, ledgerService,
 *   processedFillRepo, orderRepo, eventBus, logger,
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
import type { IOrderRepository, IProcessedFillRepository } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import type { Fill } from '@polymarket/fill';
import type { FillData } from '@polymarket/order';
import type { OrderService } from './services/OrderService.js';
import type { PortfolioService } from './services/PortfolioService.js';
import type { LedgerService } from './services/LedgerService.js';

/** Зависимости ProcessFillUseCase */
export interface ProcessFillDeps {
  readonly orderService: OrderService;
  readonly portfolioService: PortfolioService;
  readonly ledgerService: LedgerService;
  readonly orderRepo: IOrderRepository;
  readonly processedFillRepo: IProcessedFillRepository;
  readonly eventBus: IEventBus;
  readonly logger: ILogger;
}

/**
 * Use case обработки Fill исполнения.
 *
 * @remarks
 * Оркестрирует идемпотентное обновление Order, Portfolio и Ledger
 * при получении нового исполнения ордера.
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
   * @returns Ok(void) при успехе, Err(TradingError) при ошибке
   *
   * @remarks
   * Повторный вызов с тем же fill.id вернёт Ok(void) без повторной обработки
   * (idempotency guard на шаге 1).
   */
  public async execute(fill: Fill): Promise<Result<void, TradingError>> {
    // Шаг 1: Idempotency guard
    const isNew = await this._deps.processedFillRepo.markIfNotExists(fill.id);
    if (!isNew) {
      this._logger.debug('Duplicate fill ignored', { fillId: String(fill.id) });
      return Ok(undefined);
    }

    // Шаг 2: Получить Order
    const order = await this._deps.orderRepo.get(fill.orderId);
    if (!order) {
      this._logger.warn('Order not found for fill', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
      });
      return Err(new TradingError(
        `Order not found: ${String(fill.orderId)}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }

    // Шаг 3: Применить Fill к Order
    const fillData: FillData = {
      id: fill.id,
      orderId: fill.orderId,
      asset: fill.tokenId,
      side: fill.side,
      size: fill.size,
      price: fill.price,
    };
    const applyResult = await this._deps.orderService.applyFill(order, fillData);
    if (!applyResult.ok) {
      return Err(new TradingError(
        `Failed to apply fill to order: ${applyResult.error.message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }
    const updatedOrder = applyResult.value;

    // Шаг 4: Обновить Portfolio
    const portfolioResult = this._deps.portfolioService.applyFill(fill);
    if (!portfolioResult.ok) {
      this._logger.error('Failed to apply fill to portfolio', {
        fillId: String(fill.id),
        error: portfolioResult.error.message,
      });
      return Err(new TradingError(
        `Failed to update portfolio: ${portfolioResult.error.message}`,
        { context: { fillId: String(fill.id) } },
      ));
    }

    // Шаг 5: Запись в Ledger
    this._deps.ledgerService.recordFill(fill);

    // Шаг 6: Публикация событий
    const events = updatedOrder.pullEvents();
    await this._deps.eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);

    this._logger.info('Fill processed successfully', {
      fillId: String(fill.id),
      orderId: String(fill.orderId),
      newOrderStatus: updatedOrder.status,
    });

    return Ok(undefined);
  }
}
