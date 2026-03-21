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
import { assetIdToInstrumentId } from '@polymarket/ids';
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

      return Ok(undefined);
    }

    // Шаги 3–6 выполняются синхронно (без yield) — атомарное обновление состояния.
    // Первый await появляется только на шаге 7 (publishAll).
    //
    // КРИТИЧНО: clearMatchedOnExchange вызывается ВСЕГДА (в finally-pattern).
    // Без этого ошибка на любом шаге (applyFill, portfolio, ledger) оставляет
    // флаг matchedOnExchange навсегда → hasMatchedOrders: true → стратегия зависает в HOLD.

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
      // Снимаем флаг MATCHED даже при ошибке — fill уже on-chain,
      // повторная пометка произойдёт при следующем fill-событии если нужно.
      this._clearInFlightFlags(fill);
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
      // Снимаем флаг MATCHED даже при ошибке portfolio.
      // Ордер уже сохранён как terminal (шаг 4), поэтому он не появится
      // в getOpenOrdersByInstrument. Но для чистоты — снимаем флаг.
      this._clearInFlightFlags(fill);
      return Err(new TradingError(
        `Failed to update portfolio: ${portfolioResult.error.message}`,
        { context: { fillId: String(fill.id) } },
      ));
    }

    // Шаг 5b: Снять остаток резервации при FILLED через dust threshold.
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

    // Шаг 6: Запись в Ledger (sync)
    this._deps.ledgerService.recordFill(fill);

    // Шаг 7: Снимаем все in-flight флаги ПЕРЕД публикацией событий.
    // КРИТИЧНО: publishAll (шаг 8) — await, создаёт yield-окно.
    // Обработчики ORDER_FILLED (OrderEventBridge) запланируют тик стратегии
    // через microtask (Promise.resolve().then(processQueue)).
    // Если флаги не сняты ДО yield — стратегия увидит hasInFlightFills=true
    // на тике, который выполнится ВНУТРИ await → зависнет в HOLD навсегда.
    // Безопасно: если другой fill для того же ордера ещё в пути,
    // следующий MATCHED-event заново поставит флаг.
    this._clearInFlightFlags(fill);

    // Шаг 8: Публикация событий.
    // К этому моменту: Order = terminal, Portfolio = обновлён, флаги сняты.
    // Стратегия на тике увидит чистое состояние.
    const events = updatedOrder.pullEvents();
    await this._deps.eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);

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
   * Снимает все in-flight флаги: order-level matchedOnExchange + instrument-level inFlightFills.
   *
   * @param fill - Обработанный fill
   *
   * @remarks
   * Вызывается после обработки CONFIRMED fill (или на error path).
   * Очищает оба уровня tracking:
   * - `clearMatchedOnExchange(orderId)` — order-level (для CancelOrderUseCase)
   * - `clearInFlightFills(instrumentId)` — instrument-level (для StrategyScheduler snapshot)
   */
  private _clearInFlightFlags(fill: Fill): void {
    this._deps.orderStateStore.clearMatchedOnExchange(fill.orderId);
    const instrumentId = assetIdToInstrumentId(fill.tokenId);
    if (instrumentId) {
      this._deps.orderStateStore.clearInFlightFills(instrumentId);
    }
  }
}
