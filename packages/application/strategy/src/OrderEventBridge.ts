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
 * - FILL_RECEIVED → scheduler.onFillForInstrument(instrumentId) — fallback для direct fill path
 * - FILL_CONFIRMED → scheduler.onFillConfirmed(instrumentId) — сброс rejection cooldown + тик
 *
 * ### Определение strategyId:
 * OrderEvent содержит только orderId. Bridge ищет Order через IOrderStateStore
 * (sync read) для получения strategyId.
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
import { assetIdToInstrumentId } from '@polymarket/ids';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IOrderStateStore } from '@polymarket/ports';
import type { StrategyScheduler } from './StrategyScheduler.js';
import type { ExecutionEngine } from './ExecutionEngine.js';

// ── Публичные типы ─────────────────────────────────────────

/**
 * Зависимости OrderEventBridge.
 */
export interface OrderEventBridgeDeps {
  readonly eventBus: IEventBus;
  readonly scheduler: StrategyScheduler;
  readonly executionEngine: ExecutionEngine;
  readonly orderStateStore: IOrderStateStore;
  readonly orderRepo: IOrderRepository;
  readonly logger: ILogger;
}

// ── Реализация ─────────────────────────────────────────────

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

    // FILL_RECEIVED → notify scheduler по instrumentId (для direct fill path).
    // Когда fill приходит на отсутствующий/terminal ордер, ProcessFillUseCase
    // обновляет Portfolio, но не публикует ORDER_* событий.
    // Этот fallback гарантирует, что стратегия тикнет после любого fill.
    this._unsubs.push(
      this._deps.eventBus.subscribe('FILL_RECEIVED', (event) => {
        const instrumentId = assetIdToInstrumentId(event.fill.tokenId);
        if (instrumentId) {
          this._deps.scheduler.onFillForInstrument(instrumentId);
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
          const instrumentId = assetIdToInstrumentId(fill.tokenId);
          if (instrumentId) {
            this._deps.orderStateStore.clearInFlightFills(instrumentId);
            this._deps.executionEngine.clearExchangeRejectionCooldown(instrumentId);
            this._deps.scheduler.onFillForInstrument(instrumentId);
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

    const strategyId = order.strategyId;
    if (!strategyId) {
      return; // Ордер без стратегии — не маршрутизируем
    }

    this._deps.scheduler.onOrderChanged(strategyId, reason);
  }

  /**
   * Удаляет терминальный ордер из репозитория.
   *
   * @param orderId - ID ордера для удаления
   *
   * @remarks
   * Best-effort: ошибки логируются, но не прерывают обработку.
   */
  private async _cleanupOrder(orderId: OrderId): Promise<void> {
    try {
      await this._deps.orderRepo.delete(orderId);
    } catch (err) {
      this._logger.error('OrderEventBridge: failed to delete terminal order', {
        orderId: String(orderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
