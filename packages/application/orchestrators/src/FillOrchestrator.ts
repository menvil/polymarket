/**
 * FillOrchestrator — связывает FILL_RECEIVED → ProcessFillUseCase,
 * а также FILL_FAILED → откат Portfolio + очистка in-flight флагов.
 *
 * @remarks
 * Единственный компонент, отвечающий на вопрос «кто вызывает ProcessFillUseCase?».
 *
 * ### Принципы разделения ответственности:
 * (номера Phase — этапы поэтапного плана монорепо, см. master-plan.md → "Порядок выполнения фаз";
 * этот пакет orchestrators — Phase 6)
 * - FillEventHandler (Phase 3, @polymarket/handlers): парсит WS-сообщения, публикует FILL_RECEIVED / FILL_FAILED
 * - FillOrchestrator (этот класс, Phase 6): подписывается и запускает ProcessFillUseCase / откатывает
 * - ProcessFillUseCase (Phase 5, @polymarket/use-cases): применяет fill к Order, Portfolio, Ledger
 *
 * ### TODO (follow-up, не входит в текущий refactor):
 * - Алертинг/телеметрия для веток "manual reconciliation required" — сейчас это только
 *   error-логи, нет сигнала во внешнюю систему мониторинга
 * - Отдельно оценить синхронизацию token balance (баланс токенов на бирже может
 *   разойтись с Portfolio независимо от fill-отката — не покрывается этим классом)
 *
 * ### Обработка FILL_FAILED (on-chain revert после MATCHED):
 * При early processing (публикация на MATCHED) fill применяется к Portfolio немедленно.
 * Если on-chain settlement проваливается (FAILED), нужно откатить Portfolio:
 * 1. Из event.fills отбираем eligible fills: только те, что относятся к event.orderId,
 *    и дедуплицированные по fill.id (FillEventHandler может опубликовать несколько
 *    FILL_FAILED на один trade с несколькими maker-ордерами, передавая один и тот же
 *    закэшированный массив fills в каждое событие)
 * 2. Для каждого eligible fill вызываем PortfolioService.reverseFill()
 * 3. Снимаем flags и помечаем `processedFillRepo.markReverted(fill.id)` — но ТОЛЬКО
 *    для fill-ов, чей rollback прошёл успешно. Fill, для которого reverseFill упал,
 *    остаётся matched/in-flight — иначе система решит, что риска больше нет, хотя
 *    Portfolio может остаться в рассинхроне с реальностью.
 *    Очистка теперь fillId-scoped (`clearOrderFillMatched(orderId, fill.id)` /
 *    `clearInFlightFill(fill.id)`) — НЕ требует вывода единого instrumentId для
 *    всей пачки rollback fills (в отличие от старой counter-based реализации):
 *    каждый fill снимает СВОЁ собственное состояние независимо от остальных.
 * 4. Статус ордера не меняем — CLOB ордер может быть ещё жив
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
 *   processedFillRepo,
 *   logger,
 * });
 * orchestrator.register();
 * // Теперь каждый FILL_RECEIVED запускает ProcessFillUseCase,
 * // а FILL_FAILED откатывает Portfolio и снимает in-flight флаги.
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderStateStore, IFillReverter, IFillProcessor, IProcessedFillRepository } from '@polymarket/ports';

/**
 * Зависимости FillOrchestrator.
 */
export interface FillOrchestratorDeps {
  readonly eventBus: IEventBus;
  readonly processFill: IFillProcessor;
  readonly logger: ILogger;
  /** Хранилище ордеров — для очистки in-flight/matched флагов при FILL_FAILED */
  readonly orderStateStore: IOrderStateStore;
  /** Reverter для отката Portfolio при FILL_FAILED (on-chain revert) */
  readonly portfolioService: IFillReverter;
  /** Idempotency repo — помечает успешно откаченные fills как REVERTED */
  readonly processedFillRepo: IProcessedFillRepository;
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
  private readonly _processedFillRepo: IProcessedFillRepository;
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
    this._processedFillRepo = deps.processedFillRepo;
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
    // Флаги (matched, in-flight) снимаются ПО КАЖДОМУ fill НЕЗАВИСИМО, только если
    // его собственный rollback прошёл успешно — иначе система ошибочно решит,
    // что риска больше нет, хотя Portfolio может остаться в рассинхроне с
    // реальностью. Весь обработчик обёрнут в try/catch, чтобы сбой в
    // orderStateStore не уронил subscription loop.
    this._unsubFillFailed = this._eventBus.subscribe('FILL_FAILED', async (event) => {
      try {
        this._logger.warn('Fill failed on-chain — attempting portfolio rollback', {
          fillId: String(event.fillId),
          orderId: String(event.orderId),
          hasFillsForRollback: !!(event.fills && event.fills.length > 0),
        });

        if (!event.fills || event.fills.length === 0) {
          this._logger.error(
            'No cached fills for failed event — cannot reverse, flags left untouched (manual reconciliation required)',
            { fillId: String(event.fillId), orderId: String(event.orderId) },
          );
          return;
        }

        // FillEventHandler публикует один FILL_FAILED на каждый наш maker_order,
        // но передаёт один и тот же cachedFills во все события. Фильтруем по
        // event.orderId и дедуплицируем по fill.id — иначе тот же fill может
        // откатиться несколько раз (несколько maker-ордеров в одном trade,
        // либо WS replay/reconnect задублировал закэшированные fills).
        const matchingFills = event.fills.filter((fill) => fill.orderId === event.orderId);
        const rollbackFillsById = new Map<string, (typeof event.fills)[number]>();
        for (const fill of matchingFills) {
          rollbackFillsById.set(String(fill.id), fill);
        }
        const rollbackFills = [...rollbackFillsById.values()];

        if (rollbackFills.length < matchingFills.length) {
          this._logger.warn('Duplicate rollback fills collapsed by fillId', {
            orderId: String(event.orderId),
            matchingCount: matchingFills.length,
            dedupedCount: rollbackFills.length,
          });
        }

        if (rollbackFills.length === 0) {
          this._logger.error(
            'Cached fills present but none match event.orderId — cannot reverse, flags left untouched (manual reconciliation required)',
            { fillId: String(event.fillId), orderId: String(event.orderId) },
          );
          return;
        }

        // Откатываем и чистим состояние КАЖДОГО fill НЕЗАВИСИМО — партиальный
        // rollback (часть fills откатилась, часть нет) для multi-fill ордера
        // больше не блокирует очистку успешно откаченных fills.
        let reversedCount = 0;
        for (const fill of rollbackFills) {
          let reversed = false;
          try {
            const result = this._portfolioService.reverseFill(fill);
            if (!result.ok) {
              this._logger.error('Failed to reverse fill in portfolio — leaving flags set for this fill (manual reconciliation required)', {
                fillId: String(fill.id),
                orderId: String(fill.orderId),
                error: result.error.message,
              });
            } else {
              reversed = true;
            }
          } catch (err) {
            this._logger.error('Unexpected error reversing fill in portfolio — leaving flags set for this fill (manual reconciliation required)', {
              fillId: String(fill.id),
              err: err instanceof Error ? err : new Error(String(err)),
            });
          }

          if (!reversed) continue;

          this._orderStateStore.clearOrderFillMatched(fill.orderId, fill.id);
          this._orderStateStore.clearInFlightFill(fill.id);
          await this._processedFillRepo.markReverted(fill.id);
          reversedCount++;
          this._logger.info('Fill reversed in portfolio and flags cleared', {
            fillId: String(fill.id),
            orderId: String(fill.orderId),
            side: fill.side,
          });
        }

        if (reversedCount < rollbackFills.length) {
          this._logger.error(
            'Portfolio rollback incomplete for some fills — manual reconciliation required',
            {
              fillId: String(event.fillId),
              orderId: String(event.orderId),
              reversedCount,
              totalCount: rollbackFills.length,
            },
          );
        }
      } catch (err) {
        this._logger.error(
          'Unexpected error handling failed fill — rollback/cleanup state unknown, manual reconciliation required',
          {
            fillId: String(event.fillId),
            orderId: String(event.orderId),
            err: err instanceof Error ? err : new Error(String(err)),
          },
        );
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
