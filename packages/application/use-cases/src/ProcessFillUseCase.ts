/**
 * ProcessFillUseCase — оркестрация обработки исполнения ордера (Fill).
 *
 * @remarks
 * ### Алгоритм:
 * 1. Idempotency guard (IProcessedFillRepository.markIfNotExists)
 *    — при дублирующемся fill возвращает Ok без повторной обработки
 * 2. Получение Order из репозитория
 *    — если ордер не найден или уже terminal (CANCELLED/FILLED): direct fill path.
 *    Portfolio обновляется немедленно через applyDirectFill (без резерваций).
 * 3. Применение Fill к Order (sync, order.applyFill)
 * 4. Синхронное сохранение обновлённого Order (orderStateStore.saveSync)
 * 5. Обновление Portfolio (PortfolioService.applyFill)
 * 6. Запись в Ledger (LedgerService.recordFill)
 * 7. Публикация доменных событий Order (await)
 *
 * ### Идемпотентность:
 * Повторный вызов с тем же fillId безопасен — шаг 1 предотвращает
 * повторную обработку. Гарантирует «exactly once» семантику.
 *
 * ### Консистентность (устранение race condition):
 * Шаги 3–6 выполняются синхронно, без yield между ними.
 * `await` появляется только на шаге 7 (publishAll).
 * К моменту первого yield ордер уже помечен как terminal (FILED/CANCELLED),
 * поэтому любой тик стратегии или CancelOrderUseCase, запущенный в этом окне,
 * увидит `order.isTerminal === true` и пропустит отмену:
 * ```
 * // CancelOrderUseCase, строка 100:
 * if (order.isTerminal) return Ok(undefined);  // no-op
 * ```
 * Это устраняет ошибку «Cannot unfreeze/consume X: only 0 reserved».
 *
 * @example
 * ```typescript
 * const useCase = new ProcessFillUseCase({
 *   orderStateStore, portfolioService, ledgerService,
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
import type { IOrderRepository, IProcessedFillRepository, IOrderStateStore } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import type { Fill } from '@polymarket/fill';
import type { FillData } from '@polymarket/order';
import type { PortfolioService } from './services/PortfolioService.js';
import type { LedgerService } from './services/LedgerService.js';

/** Зависимости ProcessFillUseCase */
export interface ProcessFillDeps {
  readonly orderStateStore: IOrderStateStore;
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
 * Все state-мутации выполняются синхронно до первого await.
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
        // Не останавливаем: ledger всё равно запишем
      }

      this._deps.ledgerService.recordFill(fill);
      this._deps.orderStateStore.clearMatchedOnExchange(fill.orderId);
      return Ok(undefined);
    }

    // Шаги 3–6 выполняются синхронно (без yield) — атомарное обновление состояния.
    // Первый await появляется только на шаге 7 (publishAll).

    // Шаг 3: Применить Fill к Order (sync)
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
      return Err(new TradingError(
        `Failed to apply fill to order: ${applyResult.error.message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }
    const updatedOrder = applyResult.value;

    // Шаг 4: Синхронно сохранить обновлённый Order (terminal = true)
    // После этой строки любой читатель IOrderStateStore увидит ордер как FILED/terminal.
    // CancelOrderUseCase: if (order.isTerminal) return Ok(undefined) — пропустит cancel.
    this._deps.orderStateStore.saveSync(updatedOrder);

    // Шаг 5: Обновить Portfolio (sync)
    // Передаём цену ордера, чтобы точно совпасть с зарезервированной суммой
    // (fill.price может быть округлена биржей: 0.829 → 0.83, что вызывает «Cannot unfreeze/consume»).
    const portfolioResult = this._deps.portfolioService.applyFill(fill, order.price.value());
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

    // Шаг 6: Запись в Ledger (sync)
    this._deps.ledgerService.recordFill(fill);

    // Шаг 7: Публикация событий (первый await — yield-окно открывается здесь)
    // К этому моменту: Order = FILED (terminal), Portfolio = обновлён.
    const events = updatedOrder.pullEvents();
    await this._deps.eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);

    // Шаг 8: Снимаем флаг MATCHED — fill осел on-chain, опасность "in-flight" миновала.
    // Если другой fill для того же ордера ещё в пути, следующий MATCHED-event
    // заново поставит флаг. Без очистки ордер навсегда в matchedOrders snapshot'а.
    this._deps.orderStateStore.clearMatchedOnExchange(fill.orderId);

    this._logger.info('Fill processed successfully', {
      fillId: String(fill.id),
      orderId: String(fill.orderId),
      newOrderStatus: updatedOrder.status,
    });

    return Ok(undefined);
  }
}
