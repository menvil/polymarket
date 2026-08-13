/**
 * OrderEventBridge — мост между Order domain events и StrategyScheduler.
 *
 * @remarks
 * ### Назначение:
 * Подписывается на OrderEvent'ы из EventBus и маршрутизирует их к:
 * 1. StrategyScheduler — уведомление о изменении ордеров (onOrderChanged)
 * 2. IOrderRepository — cleanup терминальных ордеров (ORDER_FILLED, ORDER_CANCELLED, ORDER_EXPIRED)
 *
 * ### Маршрутизация событий:
 * - ORDER_ACCEPTED / ORDER_REJECTED → scheduler.onOrderChanged(strategyId, 'ORDER_UPDATE')
 * - ORDER_CANCELLED / ORDER_EXPIRED → scheduler.onOrderChanged(strategyId, 'ORDER_UPDATE') + delete from repo
 * - ORDER_PARTIALLY_FILLED → scheduler.onOrderChanged(strategyId, 'FILL')
 * - ORDER_FILLED → scheduler.onOrderChanged(strategyId, 'FILL') + delete from repo
 * - FILL_RECEIVED → scheduler.onFillReceivedForInstrument(instrumentId) — ТОЛЬКО dirty+enqueue
 *   (до finality: cooldown НЕ снимается, finality-dependent cleanup НЕ выполняется)
 * - FILL_CONFIRMED → scheduler.onFillConfirmedForInstrument(instrumentId) — finality cleanup:
 *   сброс post-cancel и exchange-rejection cooldown + dirty+enqueue
 *
 * ### Определение strategyId:
 * OrderEvent содержит только orderId. Bridge ищет Order через IOrderStateStore
 * (sync read) для получения strategyId.
 *
 * ### Граница валидации StrategyId (Этап 10b, ADR Решение 12):
 * `Order`/`OrderEvent` (`@polymarket/order`) хранят `strategyId` как сырой
 * `string` — явный event-replay/journal формат (`Order.fromEvents()`
 * воспроизводит историю без валидации), вне мандата типизации этой миграции.
 * `StrategyScheduler`, наоборот, типизирует `strategyId` как branded
 * `StrategyId`. Этот файл — единственная точка, где сырое значение
 * пересекает границу: оба read-сайта (`ORDER_REJECTED`-handler,
 * `_notifyScheduler()`) валидируют через `asStrategyId()` перед вызовом
 * `scheduler.onOrderChanged()`. Домен `Order`/`OrderEvent` не типизируется —
 * валидация происходит здесь, а не распространяется внутрь сущности.
 *
 * ### Unreserve баланса:
 * Для INTERNAL cancels (через CancelOrderUseCase) — unreserve выполняется в use case.
 * Для EXTERNAL cancels (venue-initiated) — unreserve должен выполняться в OrderUpdateHandler.
 * OrderEventBridge НЕ дублирует unreserve чтобы избежать double-release.
 *
 * @example
 * ```typescript
 * const bridge = new OrderEventBridge({
 *   eventBus, scheduler, orderStateStore, orderRepo, logger,
 * });
 * bridge.start();
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { OrderId } from '@polymarket/ids';
import { assetIdToInstrumentId, asStrategyId } from '@polymarket/ids';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IOrderStateStore } from '@polymarket/ports';
import { pendingMatchFillId } from '@polymarket/ports';
import type { OrderStatus } from '@polymarket/order';
import type { StrategyScheduler } from './StrategyScheduler.js';

/**
 * Терминальные статусы Order — только в них cleanup-удаление разрешено.
 *
 * @remarks
 * Локальная копия (type-only импорт `@polymarket/order`): пакет strategy
 * не имеет runtime-зависимости от order entity, поэтому `TERMINAL_STATUSES`
 * оттуда импортировать нельзя.
 */
const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'];

// ── Публичные типы ─────────────────────────────────────────

/**
 * Зависимости OrderEventBridge.
 */
export interface OrderEventBridgeDeps {
  readonly eventBus: IEventBus;
  readonly scheduler: StrategyScheduler;
  readonly orderStateStore: IOrderStateStore;
  readonly orderRepo: IOrderRepository;
  readonly logger: ILogger;
}

// ── Реализация ─────────────────────────────────────────────

/**
 * Мост между Order domain events (EventBus) и `StrategyScheduler`.
 *
 * @remarks
 * Подробное описание маршрутизации событий и правил unreserve — см. TSDoc
 * модуля в начале файла.
 */
export class OrderEventBridge {
  private readonly _logger: ILogger;
  private readonly _unsubs: Array<() => void> = [];

  constructor(private readonly _deps: OrderEventBridgeDeps) {
    this._logger = _deps.logger.child({ component: 'OrderEventBridge' });
  }

  /**
   * Запускает подписки на OrderEvent'ы.
   *
   * @remarks
   * Повторный вызов без stop() безопасен — отписывает предыдущие подписки.
   */
  public start(): void {
    this.stop();

    // ORDER_ACCEPTED → notify scheduler
    this._unsubs.push(
      this._deps.eventBus.subscribe('ORDER_ACCEPTED', (event) => {
        this._notifyScheduler(event.orderId, 'ORDER_UPDATE');
      }),
    );

    // ORDER_REJECTED → notify scheduler
    this._unsubs.push(
      this._deps.eventBus.subscribe('ORDER_REJECTED', (event) => {
        const rawStrategyId = 'strategyId' in event ? event.strategyId : undefined;
        const strategyId = typeof rawStrategyId === 'string' ? asStrategyId(rawStrategyId) : undefined;
        if (strategyId !== undefined) {
          this._deps.scheduler.onOrderChanged(strategyId, 'ORDER_UPDATE');
          return;
        }
        this._notifyScheduler(event.orderId, 'ORDER_UPDATE');
      }),
    );

    // ORDER_CANCELLED → notify scheduler + cleanup
    this._unsubs.push(
      this._deps.eventBus.subscribe('ORDER_CANCELLED', (event) => {
        this._notifyScheduler(event.orderId, 'ORDER_UPDATE');
        void this._cleanupOrder(event.orderId);
      }),
    );

    // ORDER_EXPIRED → notify scheduler + cleanup
    this._unsubs.push(
      this._deps.eventBus.subscribe('ORDER_EXPIRED', (event) => {
        this._notifyScheduler(event.orderId, 'ORDER_UPDATE');
        void this._cleanupOrder(event.orderId);
      }),
    );

    // ORDER_PARTIALLY_FILLED → notify scheduler (FILL reason)
    this._unsubs.push(
      this._deps.eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
        this._notifyScheduler(event.orderId, 'FILL');
      }),
    );

    // ORDER_FILLED → notify scheduler (FILL reason) + cleanup
    this._unsubs.push(
      this._deps.eventBus.subscribe('ORDER_FILLED', (event) => {
        this._notifyScheduler(event.orderId, 'FILL');
        void this._cleanupOrder(event.orderId);
      }),
    );

    // FILL_RECEIVED → received-семантика: ТОЛЬКО dirty+enqueue связанных
    // стратегий (direct fill path). Finality-dependent cleanup (снятие
    // post-cancel cooldown) здесь ЗАПРЕЩЁН: fill ещё не финален, размещение
    // поверх него небезопасно — cleanup выполняет ТОЛЬКО FILL_CONFIRMED.
    this._unsubs.push(
      this._deps.eventBus.subscribe('FILL_RECEIVED', (event) => {
        const instrumentId = assetIdToInstrumentId(event.fill.tokenId);
        if (instrumentId) {
          this._deps.scheduler.onFillReceivedForInstrument(instrumentId);
        }
      }),
    );

    // FILL_CONFIRMED → сброс cooldowns + очистка in-flight флагов + тик стратегии.
    // Когда CONFIRMED приходит для fill, уже обработанного при MATCHED —
    // токены on-chain, SELL больше не будет отклонён биржей.
    //
    // Очистка inFlightFills здесь — страховка от deadlock:
    // если MINED ре-маркировал инструмент после того как ProcessFillUseCase
    // снял флаг при MATCHED, CONFIRMED гарантированно снимет его.
    this._unsubs.push(
      this._deps.eventBus.subscribe('FILL_CONFIRMED', (event) => {
        for (const fill of event.fills) {
          // fillId-scoped: снимает ТОЛЬКО этот fill — другой ещё не подтверждённый
          // partial fill того же ордера/инструмента не затрагивается.
          // Placeholder pendingMatchFillId снимается ЯВНО (контракт store —
          // exact-ID cleanup): CONFIRMED реального fill «разрешает» более
          // раннюю неоднозначную пометку (cancel ALREADY_FILLED / submit FILLED).
          const placeholder = pendingMatchFillId(fill.orderId);
          this._deps.orderStateStore.clearOrderFillMatched(fill.orderId, fill.id);
          this._deps.orderStateStore.clearOrderFillMatched(fill.orderId, placeholder);
          this._deps.orderStateStore.clearInFlightFill(fill.id);
          this._deps.orderStateStore.clearInFlightFill(placeholder);
          const instrumentId = assetIdToInstrumentId(fill.tokenId);
          if (instrumentId) {
            // Confirmed-семантика: finality-dependent cleanup (post-cancel +
            // exchange-rejection cooldown) выполняется внутри scheduler-метода.
            this._deps.scheduler.onFillConfirmedForInstrument(instrumentId);
          }
        }
      }),
    );

    this._logger.info('OrderEventBridge started');
  }

  /**
   * Останавливает подписки.
   */
  public stop(): void {
    for (const unsub of this._unsubs) {
      unsub();
    }
    this._unsubs.length = 0;
    this._logger.debug('OrderEventBridge stopped');
  }

  // ── Приватные методы ───────────────────────────────────

  /**
   * Уведомляет scheduler об изменении ордера.
   *
   * @param orderId - ID ордера из события
   * @param reason - TriggerReason ('ORDER_UPDATE' или 'FILL')
   *
   * @remarks
   * Ищет strategyId через IOrderStateStore (sync).
   * Если ордер не найден или без strategyId — событие пропускается.
   */
  private _notifyScheduler(orderId: OrderId, reason: 'ORDER_UPDATE' | 'FILL'): void {
    const order = this._deps.orderStateStore.getOrder(orderId);
    if (!order) {
      this._logger.debug('OrderEventBridge: order not found, skipping', {
        orderId: String(orderId),
        reason,
      });
      return;
    }

    const rawStrategyId = order.strategyId;
    if (!rawStrategyId) {
      return; // Ордер без стратегии — не маршрутизируем
    }

    const strategyId = asStrategyId(rawStrategyId);
    if (strategyId === undefined) {
      this._logger.warn('OrderEventBridge: order.strategyId failed StrategyId format validation, skipping', {
        orderId: String(orderId),
        rawStrategyId,
      });
      return;
    }

    this._deps.scheduler.onOrderChanged(strategyId, reason);
  }

  /**
   * Удаляет терминальный ордер из репозитория (условно, по статусу).
   *
   * @param orderId - ID ордера для удаления
   *
   * @remarks
   * Best-effort: ошибки логируются, но не прерывают обработку.
   * Использует `deleteIfState()` вместо безусловного delete — если ордер
   * успел вернуться в не-терминальный статус (гонка событий) или был
   * перезаписан более свежим состоянием, удаление не выполняется и
   * логируется warning вместо молчаливой потери актуального ордера.
   * `NOT_FOUND` — идемпотентный no-op (ордер уже удалён другим событием).
   */
  private async _cleanupOrder(orderId: OrderId): Promise<void> {
    try {
      const result = await this._deps.orderRepo.deleteIfState(orderId, TERMINAL_ORDER_STATUSES);
      if (!result.ok) {
        this._logger.warn('OrderEventBridge: skipping cleanup — order not in terminal state', {
          orderId: String(orderId),
          actualState: result.error.actualState,
        });
      }
    } catch (err) {
      this._logger.error('OrderEventBridge: failed to delete terminal order', {
        orderId: String(orderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
