/**
 * FillOrchestrator — связывает FILL_RECEIVED → ProcessFillUseCase,
 * а также FILL_FAILED → откат Portfolio + очистка in-flight флагов.
 *
 * @remarks
 * Единственный компонент, отвечающий на вопрос «кто вызывает ProcessFillUseCase?».
 *
 * ### Принципы разделения ответственности:
 * - FillEventHandler (Phase 3): парсит WS-сообщения, публикует FILL_RECEIVED / FILL_FAILED
 * - FillOrchestrator (этот класс): подписывается и запускает ProcessFillUseCase / откатывает
 * - ProcessFillUseCase (Phase 5): применяет fill к Order, Portfolio, Ledger
 *
 * ### Обработка FILL_FAILED (on-chain revert после MATCHED):
 * При early processing (публикация на MATCHED) fill применяется к Portfolio немедленно.
 * Если on-chain settlement проваливается (FAILED), нужно откатить Portfolio:
 * 1. Для каждого fill из события вызываем PortfolioService.reverseFill()
 * 2. Снимаем in-flight флаги (matchedOnExchange, inFlightFills)
 * 3. Ордер остаётся в текущем состоянии — CLOB ордер может быть ещё жив
 *
 * Decoupling позволяет:
 * - Буферизировать fills при out-of-order сценариях (fills раньше ордера)
 * - Тестировать каждый компонент изолированно
 * - Заменять оркестратор без изменения use-case или handler
 *
 * @example
 * ```typescript
 * const orchestrator = new FillOrchestrator({
 *   eventBus,
 *   processFill: processFillUseCase,
 *   orderStateStore,
 *   portfolioService,
 *   logger,
 * });
 * orchestrator.register();
 * // Теперь каждый FILL_RECEIVED запускает ProcessFillUseCase,
 * // а FILL_FAILED откатывает Portfolio и снимает in-flight флаги.
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderStateStore, IFillReverter, IFillProcessor } from '@polymarket/ports';
import { assetIdToInstrumentId } from '@polymarket/ids';

/**
 * Зависимости FillOrchestrator.
 */
export interface FillOrchestratorDeps {
  readonly eventBus: IEventBus;
  readonly processFill: IFillProcessor;
  readonly logger: ILogger;
  /** Хранилище ордеров — для очистки in-flight флагов при FILL_FAILED */
  readonly orderStateStore: IOrderStateStore;
  /** Reverter для отката Portfolio при FILL_FAILED (on-chain revert) */
  readonly portfolioService: IFillReverter;
}

/**
 * Оркестратор обработки fill-событий.
 *
 * @remarks
 * Подписывается на FILL_RECEIVED (→ ProcessFillUseCase) и FILL_FAILED (→ откат + очистка флагов).
 * Ошибки логируются, но не останавливают subscription loop.
 */
export class FillOrchestrator {
  private readonly _eventBus: IEventBus;
  private readonly _processFill: IFillProcessor;
  private readonly _orderStateStore: IOrderStateStore;
  private readonly _portfolioService: IFillReverter;
  private readonly _logger: ILogger;
  private _unsubFillReceived?: () => void;
  private _unsubFillFailed?: () => void;

  /**
   * @param deps - Зависимости оркестратора
   */
  constructor(deps: FillOrchestratorDeps) {
    this._eventBus = deps.eventBus;
    this._processFill = deps.processFill;
    this._orderStateStore = deps.orderStateStore;
    this._portfolioService = deps.portfolioService;
    this._logger = deps.logger.child({ component: 'FillOrchestrator' });
  }

  /**
   * Регистрирует подписки на FILL_RECEIVED и FILL_FAILED.
   *
   * @remarks
   * Идемпотентен — повторный вызов register() без предварительного unregister()
   * сначала отписывается от предыдущих подписок, затем регистрирует новые.
   *
   * @example
   * ```typescript
   * orchestrator.register();
   * // При shutdown:
   * orchestrator.unregister();
   * ```
   */
  public register(): void {
    if (this._unsubFillReceived) {
      this._unsubFillReceived();
    }
    if (this._unsubFillFailed) {
      this._unsubFillFailed();
    }

    this._unsubFillReceived = this._eventBus.subscribe('FILL_RECEIVED', async (event) => {
      try {
        const result = await this._processFill.execute(event.fill);
        if (!result.ok) {
          this._logger.error('ProcessFillUseCase failed', {
            fillId: String(event.fill.id),
            error: result.error.message,
          });
        }
      } catch (err) {
        this._logger.error('Unexpected error processing fill', {
          fillId: String(event.fill.id),
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });

    // FILL_FAILED: on-chain revert (MATCHED → MINED → FAILED).
    // При early processing (MATCHED) fill уже применён к Portfolio — нужен откат.
    // Снимаем in-flight флаги — ордер может быть ещё жив на CLOB.
    this._unsubFillFailed = this._eventBus.subscribe('FILL_FAILED', async (event) => {
      this._logger.warn('Fill failed on-chain — reversing portfolio and clearing flags', {
        fillId: String(event.fillId),
        orderId: String(event.orderId),
        hasFillsForRollback: !!(event.fills && event.fills.length > 0),
      });

      // Откат Portfolio для каждого fill
      if (event.fills && event.fills.length > 0) {
        for (const fill of event.fills) {
          try {
            const result = this._portfolioService.reverseFill(fill);
            if (!result.ok) {
              this._logger.error('Failed to reverse fill in portfolio', {
                fillId: String(fill.id),
                orderId: String(fill.orderId),
                error: result.error.message,
              });
            } else {
              this._logger.info('Fill reversed in portfolio successfully', {
                fillId: String(fill.id),
                orderId: String(fill.orderId),
                side: fill.side,
              });
            }
          } catch (err) {
            this._logger.error('Unexpected error reversing fill in portfolio', {
              fillId: String(fill.id),
              err: err instanceof Error ? err : new Error(String(err)),
            });
          }
        }
      } else {
        this._logger.warn('No cached fills for failed event — cannot reverse (manual reconciliation required)', {
          fillId: String(event.fillId),
        });
      }

      // Очистка in-flight флагов
      this._orderStateStore.clearMatchedOnExchange(event.orderId);

      const order = this._orderStateStore.getOrder(event.orderId);
      if (order) {
        const instrumentId = assetIdToInstrumentId(order.asset);
        if (instrumentId) {
          this._orderStateStore.clearInFlightFills(instrumentId);
        }
      } else {
        this._logger.debug('Order not found for failed fill — in-flight instrument flag may remain', {
          orderId: String(event.orderId),
        });
      }
    });

    this._logger.info('FillOrchestrator registered');
  }

  /**
   * Отписывается от FILL_RECEIVED и FILL_FAILED.
   *
   * @remarks
   * Вызывать при graceful shutdown.
   */
  public unregister(): void {
    this._unsubFillReceived?.();
    this._unsubFillReceived = undefined;
    this._unsubFillFailed?.();
    this._unsubFillFailed = undefined;
    this._logger.debug('FillOrchestrator unregistered');
  }
}
