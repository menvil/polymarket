/**
 * FillOrchestrator — связывает FILL_RECEIVED → ProcessFillUseCase.
 *
 * @remarks
 * Единственный компонент, отвечающий на вопрос «кто вызывает ProcessFillUseCase?».
 *
 * ### Принципы разделения ответственности:
 * - FillEventHandler (Phase 3): парсит WS-сообщения, публикует FILL_RECEIVED
 * - FillOrchestrator (этот класс): подписывается и запускает ProcessFillUseCase
 * - ProcessFillUseCase (Phase 5): применяет fill к Order, Portfolio, Ledger
 *
 * Decoupling позволяет:
 * - Буферизировать fills при out-of-order сценариях (fills раньше ордера)
 * - Тестировать каждый компонент изолированно
 * - Заменять оркестратор без изменения use-case или handler
 *
 * @example
 * ```typescript
 * const orchestrator = new FillOrchestrator({ eventBus, processFill: processFillUseCase, logger });
 * orchestrator.register();
 * // Теперь каждый FILL_RECEIVED автоматически запускает ProcessFillUseCase
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { ProcessFillUseCase } from '@polymarket/use-cases';

/**
 * Зависимости FillOrchestrator.
 */
export interface FillOrchestratorDeps {
  readonly eventBus: IEventBus;
  readonly processFill: ProcessFillUseCase;
  readonly logger: ILogger;
}

/**
 * Оркестратор обработки fill-событий.
 *
 * @remarks
 * Подписывается на FILL_RECEIVED и делегирует ProcessFillUseCase.
 * Ошибки логируются, но не останавливают subscription loop.
 */
export class FillOrchestrator {
  private readonly _eventBus: IEventBus;
  private readonly _processFill: ProcessFillUseCase;
  private readonly _logger: ILogger;
  private _unsubscribe?: () => void;

  /**
   * @param deps - Зависимости оркестратора
   */
  constructor(deps: FillOrchestratorDeps) {
    this._eventBus = deps.eventBus;
    this._processFill = deps.processFill;
    this._logger = deps.logger.child({ component: 'FillOrchestrator' });
  }

  /**
   * Регистрирует подписку на FILL_RECEIVED.
   *
   * @remarks
   * Идемпотентен — повторный вызов register() без предварительного unregister()
   * сначала отписывается от предыдущей подписки, затем регистрирует новую.
   *
   * @example
   * ```typescript
   * orchestrator.register();
   * // После shutdown:
   * orchestrator.unregister();
   * ```
   */
  public register(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
    }

    this._unsubscribe = this._eventBus.subscribe('FILL_RECEIVED', async (event) => {
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

    this._logger.info('FillOrchestrator registered');
  }

  /**
   * Отписывается от FILL_RECEIVED.
   *
   * @remarks
   * Вызывать при graceful shutdown.
   */
  public unregister(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._logger.debug('FillOrchestrator unregistered');
  }
}
