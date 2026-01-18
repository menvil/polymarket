/**
 * StrategyContextImpl - реализация sandbox для стратегии
 *
 * @remarks
 * ctx = единственный шлюз стратегии в execution infrastructure.
 *
 * v4 changes:
 * - constructor принимает clock: IClock (dependency injection)
 * - now() → clock.now() (NO new Date()!)
 * - Deterministic replay через ReplayClock
 *
 * КРИТИЧНО v4:
 * - Стратегия НЕ создаёт время (clock = dependency)
 * - Стратегия НЕ делает REST/WS напрямую
 * - Стратегия НЕ читает Order aggregate напрямую
 * - Стратегия НЕ публикует в EventBus напрямую
 *
 * Если стратегия может что-то сделать без ctx — это баг архитектуры.
 *
 * @example
 * ```typescript
 * // Production (LIVE mode):
 * const liveClock = new LiveClock();
 * const ctx = new StrategyContextImpl(executionAdapter, 'LIVE', liveClock);
 *
 * // Testing (PAPER mode):
 * const paperClock = new PaperClock(new Date('2024-01-01'));
 * const ctx = new StrategyContextImpl(executionAdapter, 'PAPER', paperClock);
 * paperClock.tick(1000); // Advance time by 1 second
 *
 * // Replay (REPLAY mode):
 * const replayClock = new ReplayClock(new Date('2024-01-01'));
 * const ctx = new StrategyContextImpl(executionAdapter, 'REPLAY', replayClock);
 * replayClock.update(eventTimestamp); // Update from event
 * ```
 */

import type { StrategyContext, PlaceLimitOrderParams } from '../../domain/strategies/StrategyContext.js';
import type { Environment } from '../../domain/execution/Environment.js';
import type { IExecutionAdapter } from '../../domain/ports/IExecutionAdapter.js';
import { FillReason } from '../../infrastructure/backtest/types/FillReason.js';
import type { IClock } from '../../domain/time/IClock.js';
import type { IOrderbookProjector } from '../../domain/services/orderbook/OrderbookProjector.js';
import type { IEventBus } from '../../shared/events/IEventBus.js';
import type { OrderAccepted, OrderCancelled } from '../../domain/events/ExecutionEvent.js';
import { createProductionEnvelope } from '../../shared/events/EventEnvelope.js';
import type { ExecutionContext } from '../../domain/execution/ExecutionContext.js';
import type { ITradeAccumulator } from '../../domain/services/trades/TradeAccumulator.js';
import { TradeAccumulator } from '../../domain/services/trades/TradeAccumulator.js';
import { Trade } from '../../domain/entities/Trade.js';
import { Price } from '../../domain/value-objects/Price.js';
import { Quantity } from '../../domain/value-objects/Quantity.js';
import { randomUUID } from 'crypto';
// ✅ v7.7.15: OrderFilled УДАЛЁН, используем локальный тип FillEvent
import type { FillEvent, IPortfolioProjector } from '../../domain/services/portfolio/PortfolioProjector.js';
// ✅ v7.7.16: StrategyMetricsProjector для получения orders/fills
import type { OrderDisplayData, FillRecordDisplayData } from '../../infrastructure/ui/types.js';
import type { IStrategyMetricsProjector } from '../services/StrategyMetricsProjector.js';

/**
 * StrategyContextImpl - sandbox implementation
 *
 * @remarks
 * КРИТИЧНО v4:
 * - clock: IClock injected (NO new Date() внутри!)
 * - now() → clock.now() (deterministic)
 * - LiveClock для LIVE mode
 * - PaperClock для PAPER mode
 * - ReplayClock для REPLAY mode
 *
 * Async handling:
 * - placeLimitOrder() синхронный (возвращает orderId сразу)
 * - Async operation запускается в фоне (fire-and-forget)
 * - Результат приходит через ExecutionEvent (OrderAccepted/OrderRejected)
 * - Strategy обрабатывает event через FSM
 *
 * @example
 * ```typescript
 * const ctx = new StrategyContextImpl(adapter, 'LIVE', liveClock);
 *
 * // Synchronous call:
 * const orderId = ctx.placeLimitOrder({
 *   tokenId: '0xabc',
 *   side: 'buy',
 *   price: 0.52,
 *   size: 100
 * });
 * // → orderId = '123abc' (returned immediately)
 *
 * // Async result later via EventBus:
 * // → OrderAccepted { orderId: '123abc', ... }
 * // or
 * // → OrderRejected { orderId: '123abc', reason: '...' }
 * ```
 */
/**
 * ActiveOrder - информация об активном ордере для fill detection
 *
 * @remarks
 * v5.5: Event-driven fill detection!
 * Храним информацию о текущем ордере чтобы при получении
 * trade или orderbook update сразу проверять fill.
 */
interface ActiveOrder {
  orderId: string;
  strategyId: string;
  tokenId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  filledQuantity: number; // Для partial fills
  placedAt: Date; // Время размещения
  outcomeName?: string; // ✅ v5.5: Имя outcome (e.g., "Up", "Down")
}

// FillReason импортирован из ExecutionEvent.ts

/**
 * FillRecord - запись о заполненном ордере
 *
 * @remarks
 * v5.5: Для отображения истории fills в обратном хронологическом порядке.
 */
export interface FillRecord {
  orderId: string;
  strategyId: string;
  tokenId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  fillReason: FillReason;
  filledAt: Date;
  placedAt: Date;
  /** Детали причины fill */
  details: string;
}

export class StrategyContextImpl implements StrategyContext {
  /**
   * v5.3: Trade accumulator для trade-based fill detection
   */
  private readonly tradeAccumulator: ITradeAccumulator;

  /**
   * v5.5: Active order для event-driven fill detection
   */
  private activeOrder: ActiveOrder | null = null;

  /**
   * v5.6: Флаг для предотвращения дублирования fill'ов
   * Проблема: checkTradeFill() и checkOrderbookFill() могут сработать одновременно
   * Решение: Первый кто начал fill устанавливает флаг, второй пропускается
   */
  private isFillingInProgress = false;

  /**
   * v5.5: История заполненных ордеров (для логирования)
   */
  private fillHistory: FillRecord[] = [];
  private readonly MAX_FILL_HISTORY = 50; // Храним последние 50 fills

  /**
   * КРИТИЧНО v4: clock injected (dependency injection)
   * КРИТИЧНО v5 (БЛОКЕР 2): orderbookProjector injected для dynamic pricing
   * КРИТИЧНО v5.2: eventBus и executionContext для PAPER mode симуляции
   * КРИТИЧНО v5.3: tradeAccumulator для trade-based fill detection
   * КРИТИЧНО v5.4: strategyId для корректной маршрутизации событий
   * КРИТИЧНО v6.3: reconciliationService для gatekeeper проверки pending orders
   * КРИТИЧНО v7.4: portfolioProjector для получения РЕАЛЬНОГО inventory
   * КРИТИЧНО v7.7.16: metricsProjector для получения orders/fills в стратегии
   *
   * @param executionAdapter - Execution adapter (for placing/cancelling orders)
   * @param environment - Execution mode (LIVE/PAPER/REPLAY)
   * @param clock - Clock source (LiveClock/PaperClock/ReplayClock)
   * @param orderbookProjector - Orderbook projector (для получения best bid/ask)
   * @param eventBus - Event bus (для PAPER mode - публикация симулированных событий)
   * @param executionContext - Execution context (для PAPER mode - envelope creation)
   * @param strategyId - Strategy ID (для корректной маршрутизации событий в PAPER mode)
   * @param tradeAccumulator - Trade accumulator (для trade-based fill detection, optional)
   * @param reconciliationService - Order reconciliation service (для проверки pending orders, optional)
   * @param portfolioProjector - Portfolio projector (для получения cumulative inventory, optional)
   * @param metricsProjector - Metrics projector (для получения orders/fills в стратегии, optional)
   */
  constructor(
    private readonly executionAdapter: IExecutionAdapter,
    private readonly environment: Environment,
    private readonly clock: IClock, // ✅ v4: Dependency injection
    private readonly orderbookProjector: IOrderbookProjector, // ✅ v5 (БЛОКЕР 2): Dependency injection
    private readonly eventBus?: IEventBus, // ✅ v5.2: Для PAPER mode симуляции
    private readonly executionContext?: ExecutionContext, // ✅ v5.2: Для envelope creation
    private readonly strategyId?: string, // ✅ v5.4: Для корректной маршрутизации событий
    tradeAccumulator?: ITradeAccumulator, // ✅ v5.3: Для trade-based fill detection
    private readonly reconciliationService?: { hasPendingOrders(strategyId: string): boolean }, // ✅ v6.3: Gatekeeper
    private readonly portfolioProjector?: IPortfolioProjector, // ✅ v7.7.17: Source of truth (fills + orders + inventory)
    _metricsProjector?: IStrategyMetricsProjector // ✅ v7.7.16: DEPRECATED v7.7.17 - не используется! (parameter only for backward compatibility)
  ) {
    // Создаём trade accumulator если не передан
    this.tradeAccumulator = tradeAccumulator || new TradeAccumulator(60000);
  }

  get mode(): Environment {
    return this.environment;
  }

  /**
   * Current timestamp
   *
   * @returns Current timestamp from clock
   *
   * @remarks
   * КРИТИЧНО v4: NO new Date()!
   * Использует clock.now() (dependency injection).
   *
   * - LiveClock: Date.now() (production)
   * - PaperClock: controllable time (testing)
   * - ReplayClock: frozen time (replay)
   *
   * Гарантирует:
   * - Deterministic replay (bit-for-bit)
   * - NO race conditions с временем
   * - Testable (PaperClock)
   */
  now(): Date {
    return this.clock.now(); // ✅ NO new Date()
  }

  /**
   * Place limit order
   *
   * @param params - Order parameters
   * @returns Order ID (placeholder in LIVE mode, real UUID in PAPER/REPLAY mode)
   *
   * @remarks
   * ✅ **v6.4 CRITICAL FIX**: Removed duplicate OrderAccepted publishing in LIVE mode!
   *
   * **LIVE mode:**
   * - ExecutionAdapter publishes OrderAccepted with REAL exchange orderId
   * - Returns placeholder orderId (not used by Strategy)
   * - Strategy FSM gets real orderId from OrderAccepted event
   *
   * **PAPER/REPLAY mode:**
   * - Generates UUID and publishes OrderAccepted
   * - Returns the same UUID
   *
   * **WHY THIS FIX WAS NEEDED:**
   * Before v6.4, we published OrderAccepted TWICE in LIVE mode:
   * 1. ExecutionAdapter published with REAL exchange orderId (correct)
   * 2. StrategyContextImpl published with RANDOM UUID (wrong!)
   *
   * This caused Strategy FSM to track the wrong orderId.
   * When OrderReconciliationService published OrderFilled with real orderId,
   * FSM couldn't match it → state never updated → inventory remained 0 →
   * Strategy kept generating BUY orders instead of SELL orders.
   *
   * **Алгоритм (LIVE mode):**
   * 1. Call executionAdapter.placeOrder() (async, fire-and-forget)
   * 2. ExecutionAdapter publishes OrderAccepted with real exchange orderId
   * 3. Return placeholder orderId (synchronously)
   * 4. Strategy FSM receives OrderAccepted event and tracks real orderId
   *
   * @example
   * ```typescript
   * // LIVE mode:
   * const orderId = ctx.placeLimitOrder({
   *   tokenId: '0xabc',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 100,
   * });
   * // → 'pending-a1b2c3d4' (placeholder, NOT used by Strategy)
   *
   * // Later via EventBus:
   * // → OrderAccepted { orderId: '0x0fe724...', ... } (REAL exchange orderId)
   *
   * // PAPER mode:
   * const orderId = ctx.placeLimitOrder({ ... });
   * // → '550e8400-...' (UUID, same as in OrderAccepted event)
   * ```
   */
  placeLimitOrder(params: PlaceLimitOrderParams): string {
    // ✅ v5.2: PAPER mode - симулируем OrderAccepted, НЕ вызываем реальную биржу
    if (this.environment === 'PAPER' || this.environment === 'REPLAY') {
      // Generate orderId for PAPER/REPLAY mode
      const orderId = randomUUID();

      // В PAPER/REPLAY mode публикуем симулированный OrderAccepted
      if (this.eventBus && this.executionContext) {
        const acceptedEvent: OrderAccepted = {
          type: 'OrderAccepted',
          orderId,
          strategyId: params.strategyId || 'unknown',
          side: params.side.toUpperCase() as 'BUY' | 'SELL', // Convert to uppercase
          marketId: params.tokenId, // OrderAccepted uses marketId
          price: params.price,
          size: params.size,
          timestamp: this.clock.now(),
        };

        // Публикуем через setImmediate чтобы не блокировать
        setImmediate(() => {
          const envelope = createProductionEnvelope(
            acceptedEvent,
            this.executionContext!
          );
          this.eventBus!.publish(envelope);
        });

        console.log('[StrategyContextImpl] PAPER mode: simulated OrderAccepted', {
          orderId: orderId.substring(0, 12) + '...',
          side: params.side,
          price: params.price,
        });
      }

      return orderId;
    }

    // ✅ LIVE mode: вызываем реальную биржу
    // CRITICAL FIX: Pass primitive params directly to adapter
    // PolymarketRestAdapter expects PlaceOrderParams (primitives), not Order entity
    // v4.2: Propagate strategyId для multi-strategy изоляции
    const adapterParams = {
      tokenId: params.tokenId,
      side: params.side, // Keep original lowercase ('buy'/'sell')
      price: params.price, // Number, not Price object
      size: params.size, // Number, not Quantity object
      strategyId: params.strategyId,
    };

    // ✅ v6.4 CRITICAL FIX: ExecutionAdapter publishes OrderAccepted with real exchange orderId
    // Fire-and-forget: запускаем async operation
    // Результат придёт через EventBus (OrderAccepted/OrderRejected)
    // ExecutionAdapter ALREADY publishes OrderAccepted - DO NOT duplicate!
    (this.executionAdapter as any)
      .placeOrder(adapterParams)
      .then((order: any) => {
        // SUCCESS: ExecutionAdapter already published OrderAccepted with real orderId
        console.log('[StrategyContextImpl] Order placed successfully', {
          orderId: order.orderId?.substring(0, 8) + '...',
          strategyId: params.strategyId,
          side: params.side,
          price: order.price,
          size: order.size,
        });
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);

        console.error('[StrategyContextImpl] placeOrder failed', {
          error: errorMessage,
        });

        // Проверяем причину ошибки
        const isInsufficientBalance = errorMessage.includes('Insufficient USDC') ||
                                       errorMessage.includes('Insufficient balance');
        const isSizeBelowMinimum = errorMessage.includes('below minimum');

        if (isInsufficientBalance) {
          // НЕ публикуем OrderRejected - стратегия остаётся в IDLE
          // На следующем тике цена может снизиться и ордер разместится
          console.warn('[StrategyContextImpl] Insufficient balance - waiting for better price', {
            strategyId: params.strategyId,
          });
          return;
        }

        if (isSizeBelowMinimum) {
          // НЕ публикуем OrderRejected - это config проблема, просто логируем
          console.error('[StrategyContextImpl] Size below market minimum - check config.size', {
            strategyId: params.strategyId,
            error: errorMessage,
          });
          // Публикуем OrderRejected чтобы стратегия остановилась (нужно исправить config)
        }

        // Для других ошибок ExecutionAdapter уже публикует OrderRejected
        // Не дублируем публикацию здесь
      });

    // ✅ v6.4: Return placeholder orderId
    // Real orderId will come via OrderAccepted event from ExecutionAdapter
    // Strategy FSM will track the REAL orderId from the event
    return 'pending-' + randomUUID().substring(0, 8);
  }

  /**
   * Cancel order
   *
   * @param orderId - Order ID to cancel
   *
   * @remarks
   * Synchronous method (void).
   * Async operation запускается в фоне.
   * Результат придёт через ExecutionEvent (OrderCancelled).
   *
   * @example
   * ```typescript
   * ctx.cancelOrder('123abc');
   * // → void (returned immediately)
   *
   * // Later:
   * // → OrderCancelled { orderId: '123abc', ... }
   * ```
   */
  cancelOrder(orderId: string): void {
    // ✅ v5.2: PAPER mode - симулируем OrderCancelled
    if (this.environment === 'PAPER' || this.environment === 'REPLAY') {
      if (this.eventBus && this.executionContext) {
        const cancelledEvent: OrderCancelled = {
          type: 'OrderCancelled',
          orderId,
          strategyId: this.strategyId || 'unknown', // ✅ v5.4: Используем strategyId из конструктора
          timestamp: this.clock.now(),
        };

        setImmediate(() => {
          const envelope = createProductionEnvelope(
            cancelledEvent,
            this.executionContext!
          );
          this.eventBus!.publish(envelope);
        });

        console.log('[StrategyContextImpl] PAPER mode: simulated OrderCancelled', {
          orderId: orderId.substring(0, 12) + '...',
        });
      }
      return;
    }

    // ✅ LIVE mode: вызываем реальную биржу
    this.executionAdapter
      .cancelOrder(orderId)
      .catch((error) => {
        // Error handling: логируем ошибку
        console.error('[StrategyContextImpl] cancelOrder failed', {
          orderId,
          error,
        });
      });
  }

  /**
   * Get best bid price from orderbook
   *
   * @param tokenId - Token ID (asset ID)
   * @returns Best bid price или null если нет данных
   *
   * @remarks
   * КРИТИЧНО v5 (БЛОКЕР 2): Orderbook integration!
   *
   * Делегирует вызов в OrderbookProjector.
   * Данные обновляются через WebSocket 'orderbook' события.
   *
   * @example
   * ```typescript
   * const bestBid = ctx.getBestBid(tokenId);
   * if (bestBid) {
   *   console.log('Best bid:', bestBid);
   * }
   * ```
   */
  getBestBid(tokenId: string): number | null {
    return this.orderbookProjector.getBestBid(tokenId);
  }

  /**
   * Get best ask price from orderbook
   *
   * @param tokenId - Token ID (asset ID)
   * @returns Best ask price или null если нет данных
   *
   * @remarks
   * КРИТИЧНО v5 (БЛОКЕР 2): Orderbook integration!
   *
   * Делегирует вызов в OrderbookProjector.
   * Данные обновляются через WebSocket 'orderbook' события.
   *
   * @example
   * ```typescript
   * const bestAsk = ctx.getBestAsk(tokenId);
   * if (bestAsk) {
   *   console.log('Best ask:', bestAsk);
   * }
   * ```
   */
  getBestAsk(tokenId: string): number | null {
    return this.orderbookProjector.getBestAsk(tokenId);
  }

  /**
   * Emit virtual OrderFilled event (PAPER/REPLAY mode only)
   *
   * @param params - Fill parameters
   * @param fillReason - Причина fill (TRADE или ORDERBOOK)
   * @param details - Детали причины fill
   *
   * @remarks
   * КРИТИЧНО v5.2: Для PAPER/REPLAY mode симуляции fills!
   *
   * В LIVE mode этот метод НЕ делает ничего (noop).
   * В PAPER/REPLAY mode публикует симулированный OrderFilled event.
   *
   * v5.5: Добавлено отслеживание причины fill и история.
   */
  emitVirtualFill(
    params: {
      orderId: string;
      strategyId: string;
      tokenId: string;
      side: 'buy' | 'sell';
      price: number;
      size: number;
    },
    fillReason: FillReason = FillReason.TRADE_THROUGH,
    details: string = ''
  ): void {
    // В LIVE mode - noop (ждём реальных fills от биржи)
    if (this.environment === 'LIVE') {
      return;
    }

    const now = this.clock.now();

    // ✅ v5.5: Сохраняем в историю fills
    const fillRecord: FillRecord = {
      orderId: params.orderId,
      strategyId: params.strategyId,
      tokenId: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
      fillReason,
      filledAt: now,
      placedAt: this.activeOrder?.placedAt || now,
      details,
    };

    this.fillHistory.unshift(fillRecord); // Добавляем в начало (новые сверху)
    if (this.fillHistory.length > this.MAX_FILL_HISTORY) {
      this.fillHistory.pop(); // Удаляем старые
    }

    // ✅ v5.5: Логируем fill с причиной и outcome
    const reasonEmoji = fillReason === FillReason.TRADE_THROUGH ? '📈' : '📊';
    const sideEmoji = params.side === 'buy' ? '🟢' : '🔴';
    const duration = now.getTime() - fillRecord.placedAt.getTime();
    const durationStr = duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`;
    const outcomeStr = this.activeOrder?.outcomeName ? ` ${this.activeOrder.outcomeName}` : '';

    console.log('\n' + '═'.repeat(70));
    console.log(
      `${reasonEmoji} VIRTUAL FILL ${sideEmoji} ${params.side.toUpperCase()}${outcomeStr} @ ${params.price.toFixed(4)}`,
      `| Size: ${params.size}`,
      `| Duration: ${durationStr}`
    );
    console.log(`   Reason: ${fillReason} - ${details || 'No details'}`);

    // Показываем последние 3 fills для контекста
    if (this.fillHistory.length > 1) {
      console.log(`   ─ Recent fills (newest first):`);
      const recentFills = this.fillHistory.slice(0, 3);
      for (let i = 0; i < recentFills.length; i++) {
        const fill = recentFills[i];
        const fSideEmoji = fill.side === 'buy' ? '🟢' : '🔴';
        const fReasonEmoji = fill.fillReason === FillReason.TRADE_THROUGH ? '📈' : '📊';
        const fDuration = fill.filledAt.getTime() - fill.placedAt.getTime();
        const fDurationStr = fDuration < 1000 ? `${fDuration}ms` : `${(fDuration / 1000).toFixed(1)}s`;
        console.log(
          `     ${i + 1}. ${fSideEmoji} ${fill.side.toUpperCase().padEnd(4)} @ ${fill.price.toFixed(4)}`,
          `| ${fReasonEmoji} ${fill.fillReason.padEnd(9)}`,
          `| ${fDurationStr.padStart(6)}`
        );
      }
    }
    console.log('═'.repeat(70));

    // ✅ v7.7.15: В PAPER/REPLAY mode - публикуем симулированный FillEvent
    if (this.eventBus && this.executionContext) {
      const filledEvent: FillEvent = {
        type: 'OrderFilled',
        orderId: params.orderId,
        strategyId: params.strategyId,
        side: params.side.toUpperCase() as 'BUY' | 'SELL',
        price: params.price,
        filledDelta: params.size,
        tokenId: params.tokenId,
        timestamp: now,
        fillReason, // ✅ v5.5: Источник fill
        // ✅ v7.7.15: fillDetails удалён из FillEvent
        // fillDetails: details, // ✅ v5.5: Детали fill
      };

      setImmediate(() => {
        const envelope = createProductionEnvelope(
          filledEvent,
          this.executionContext!
        );
        this.eventBus!.publish(envelope);
      });
    }
  }

  /**
   * Получить историю fills в обратном хронологическом порядке
   *
   * @param limit - Максимальное количество записей (default: 10)
   * @returns Массив FillRecord, новые сверху
   *
   * @remarks
   * v5.5: Для отображения истории fills.
   */
  getFillHistory(limit: number = 10): FillRecord[] {
    return this.fillHistory.slice(0, limit);
  }

  /**
   * Логирует историю fills в консоль
   *
   * @param limit - Количество записей для отображения
   */
  logFillHistory(limit: number = 10): void {
    const fills = this.getFillHistory(limit);
    if (fills.length === 0) {
      console.log('\n📋 FILL HISTORY: No fills yet');
      return;
    }

    console.log(`\n📋 FILL HISTORY (last ${fills.length} fills, newest first):`);
    console.log('─'.repeat(80));

    for (let i = 0; i < fills.length; i++) {
      const fill = fills[i];
      const sideEmoji = fill.side === 'buy' ? '🟢' : '🔴';
      const reasonEmoji = fill.fillReason === FillReason.TRADE_THROUGH ? '📈' : '📊';
      const duration = fill.filledAt.getTime() - fill.placedAt.getTime();
      const durationStr = duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`;

      console.log(
        `  ${i + 1}. ${sideEmoji} ${fill.side.toUpperCase().padEnd(4)}`,
        `@ ${fill.price.toFixed(4)}`,
        `| ${reasonEmoji} ${fill.fillReason.padEnd(9)}`,
        `| Duration: ${durationStr.padStart(6)}`,
        `| ${fill.details || 'No details'}`
      );
    }
    console.log('─'.repeat(80));
  }

  /**
   * Get filled volume from recent trades
   *
   * @param tokenId - Token ID (asset ID)
   * @param orderPrice - Price of our order
   * @param orderSide - Side of our order ('buy' or 'sell')
   * @param windowMs - Time window in milliseconds (default: 5000)
   * @returns Volume of trades that would fill our order
   *
   * @remarks
   * КРИТИЧНО v5.3: Trade-based fill detection!
   *
   * Для PAPER/REPLAY mode возвращает объём трейдов из TradeAccumulator.
   * Для LIVE mode возвращает 0 (ждём реальных fills от биржи).
   *
   * Логика fill detection:
   * - BUY order @ X: считаем SELL трейды (taker sells) по цене <= X
   * - SELL order @ X: считаем BUY трейды (taker buys) по цене >= X
   */
  getFilledVolume(
    tokenId: string,
    orderPrice: number,
    orderSide: 'buy' | 'sell',
    windowMs: number = 5000
  ): number {
    // В LIVE mode ждём реальных fills от биржи
    if (this.environment === 'LIVE') {
      return 0;
    }

    // В PAPER/REPLAY mode используем TradeAccumulator
    return this.tradeAccumulator.getFilledVolume(tokenId, orderPrice, orderSide, windowMs);
  }

  /**
   * Add trade to accumulator
   *
   * @param tokenId - Token ID (asset ID)
   * @param trade - Trade object with price, quantity, side
   *
   * @remarks
   * КРИТИЧНО v5.3: Для накопления трейдов из WebSocket!
   *
   * Этот метод вызывается инфраструктурным слоем когда приходит
   * trade event из WebSocket.
   */
  addTrade(
    tokenId: string,
    trade: { price: number; quantity: number; side: 'BUY' | 'SELL' | null }
  ): void {
    // Создаём Trade entity для TradeAccumulator
    const tradeEntity = Trade.create({
      id: randomUUID(),
      marketId: tokenId,
      price: Price.fromNumber(trade.price),
      quantity: Quantity.fromNumber(trade.quantity),
      side: trade.side,
      timestamp: this.clock.now(),
    });

    this.tradeAccumulator.addTrade(tokenId, tradeEntity);

    // ✅ v5.5: Event-driven fill detection - проверяем fill сразу при получении trade!
    this.checkTradeFill(tokenId, trade);
  }

  /**
   * Register active order for fill detection
   *
   * @param order - Order information
   *
   * @remarks
   * v5.5: Event-driven fill detection!
   *
   * Вызывается после получения OrderAccepted.
   * Сохраняет информацию об ордере для проверки fills
   * при получении trade и orderbook events.
   *
   * @example
   * ```typescript
   * // В DumbStrategy после OrderAccepted:
   * ctx.registerActiveOrder({
   *   orderId: event.orderId,
   *   strategyId: this.config.id,
   *   tokenId: this.config.tokenId,
   *   side: 'buy',
   *   price: event.price,
   *   size: this.config.size,
   * });
   * ```
   */
  registerActiveOrder(order: {
    orderId: string;
    strategyId: string;
    tokenId: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    outcomeName?: string;
  }): void {
    this.activeOrder = {
      ...order,
      filledQuantity: 0,
      placedAt: this.clock.now(), // ✅ v5.5: Время размещения
    };
    // ✅ v5.6: Сбрасываем флаг для нового ордера
    this.isFillingInProgress = false;
  }

  /**
   * Clear active order (after fill or cancel)
   *
   * @remarks
   * v5.5: Вызывается после OrderFilled или OrderCancelled.
   */
  clearActiveOrder(): void {
    this.activeOrder = null;
    // ✅ v5.6: Сбрасываем флаг
    this.isFillingInProgress = false;
  }

  /**
   * v6.3: GATEKEEPER - Check if strategy has pending orders
   *
   * @returns true if strategy has any pending orders on exchange
   *
   * @remarks
   * **КРИТИЧНО**: Единственный источник истины для "можно ли генерировать новый intent".
   *
   * Делегирует OrderReconciliationService.hasPendingOrders(strategyId).
   *
   * If reconciliationService not provided → returns false (fail-open for backtest/replay).
   * In LIVE mode, reconciliationService MUST be provided!
   */
  hasPendingOrders(): boolean {
    if (!this.reconciliationService || !this.strategyId) {
      // Backtest/Replay mode or missing strategyId → fail-open (allow intent)
      return false;
    }

    return this.reconciliationService.hasPendingOrders(this.strategyId);
  }

  /**
   * v6.3: Untrack filled/cancelled order
   *
   * @param orderId - Order ID to untrack
   *
   * @remarks
   * **КРИТИЧНО**: Вызывается Strategy ПЕРЕД генерацией reverse order intent!
   * Делегирует OrderReconciliationService.untrackOrder(orderId).
   */
  untrackOrder(orderId: string): void {
    if (!this.reconciliationService) {
      // Backtest/Replay mode - no-op
      return;
    }

    // Delegate to ReconciliationService
    (this.reconciliationService as any).untrackOrder?.(orderId);
  }

  /**
   * v7.4: Get current inventory from PortfolioProjector
   *
   * @param tokenId - Token ID (market identifier)
   * @returns Current inventory (cumulative position quantity)
   *
   * @remarks
   * **КРИТИЧНО v7.4**: MUST GET POSITIONS FROM POLYMARKET AND CALCULATE INVENTORY!
   *
   * Queries PortfolioProjector which accumulates OrderFilled events:
   * - BUY fills: increase inventory
   * - SELL fills: decrease inventory
   * - Returns cumulative position (5+5+5 = 15, not just last fill size!)
   *
   * **Fallback**: Returns 0 if portfolioProjector not available (backtest/replay mode).
   *
   * @example
   * ```typescript
   * const inventory = ctx.getInventory(tokenId);
   * // After 3 BUY fills of 5 shares each: inventory = 15 ✓
   * // (NOT 5 like the old getInventoryFromState()!)
   * ```
   */
  getInventory(_tokenId: string): number {
    // ✅ v7.7.17: Читаем из PortfolioProjector.getSnapshot() (inventory вычислен из fills)
    // tokenId не используется - inventory берётся из snapshot!
    if (!this.portfolioProjector || !this.strategyId) {
      return 0;
    }

    const snapshot = this.portfolioProjector.getSnapshot(this.strategyId);
    return snapshot?.inventory ?? 0;
  }

  /**
   * ✅ v7.7.17: Get position with averageCost (для profitable SELL pricing)
   */
  getPosition(_tokenId: string): { quantity: number; averageCost: number; realizedPnL: number } | null {
    // ✅ v7.7.17: Читаем из PortfolioProjector.getSnapshot()
    // tokenId не используется - position берётся из snapshot!
    if (!this.portfolioProjector || !this.strategyId) {
      return null;
    }

    const snapshot = this.portfolioProjector.getSnapshot(this.strategyId);
    if (!snapshot || snapshot.inventory === 0) {
      return null;
    }

    return {
      quantity: snapshot.inventory,
      averageCost: snapshot.averageCost,
      realizedPnL: snapshot.realizedPnL,
    };
  }

  /**
   * ✅ v7.7.15: Get minimum order size from market constraints
   *
   * @param _tokenId - Token ID (market identifier) - not used yet
   * @returns Minimum order size for this market
   *
   * @remarks
   * For now, returns 1.0 (typical Polymarket minimum).
   * In future, can be enhanced to query IMarketConstraintsProvider per tokenId.
   */
  getMinOrderSize(_tokenId: string): number {
    // TODO: Query market constraints provider when available
    // For now, return typical Polymarket minimum (independent of tokenId)
    return 1.0;
  }

  /**
   * ✅ v7.7.16: Get list of open orders for this strategy
   *
   * @returns Array of open orders (from MetricsProjector)
   *
   * @remarks
   * Strategy self-sufficiency: Strategy получает РЕАЛЬНОЕ состояние ордеров.
   * Используется для snapshot перед PlaceOrder и обнаружения изменений.
   *
   * **Источник данных**: StrategyMetricsProjector
   * **Обновление**: Каждые 4 секунды через OrderReconciliationService
   *
   * @example
   * ```typescript
   * // In DumbStrategy:
   * const orders = ctx.getOrders();
   * this.snapshot = {
   *   orderIds: orders.map(o => o.id),
   *   timestamp: ctx.now().getTime()
   * };
   * ```
   */
  getOrders(): OrderDisplayData[] {
    // ✅ v7.7.17: Читаем из PortfolioProjector (source of truth)
    if (!this.portfolioProjector || !this.strategyId) {
      return [];
    }

    const snapshot = this.portfolioProjector.getSnapshot(this.strategyId);
    return snapshot?.orders ?? [];
  }

  /**
   * ✅ v7.7.16: Get list of all fills/trades for this strategy
   *
   * @returns Array of fills (from MetricsProjector)
   *
   * @remarks
   * Strategy self-sufficiency: Strategy получает ВСЕ fills/trades.
   * Используется для snapshot, обнаружения новых fills, и расчёта inventory.
   *
   * **Источник данных**: StrategyMetricsProjector
   * **Обновление**: Каждые 4 секунды через OrderReconciliationService
   *
   * **Расчёт inventory из fills**:
   * ```typescript
   * const fills = ctx.getFills();
   * let inventory = 0;
   * for (const fill of fills) {
   *   if (fill.side === 'BUY') inventory += fill.size;
   *   else if (fill.side === 'SELL') inventory -= fill.size;
   * }
   * inventory = Math.floor(inventory * 100) / 100; // Truncate to 2 decimals
   * ```
   *
   * @example
   * ```typescript
   * // In DumbStrategy:
   * const fills = ctx.getFills();
   * this.snapshot = {
   *   fillIds: fills.map(f => f.id),
   *   inventory: this.calculateInventoryFromFills(fills),
   *   timestamp: ctx.now().getTime()
   * };
   * ```
   */
  getFills(): FillRecordDisplayData[] {
    // ✅ v7.7.17: Читаем из PortfolioProjector (source of truth)
    if (!this.portfolioProjector || !this.strategyId) {
      return [];
    }

    const snapshot = this.portfolioProjector.getSnapshot(this.strategyId);
    return snapshot?.fills ?? [];
  }

  /**
   * Get current active order (for debugging/logging)
   */
  getActiveOrder(): ActiveOrder | null {
    return this.activeOrder;
  }

  /**
   * Check if incoming trade fills our active order
   *
   * @param tokenId - Token ID of the trade
   * @param trade - Trade data
   *
   * @remarks
   * v5.5: Event-driven fill detection!
   *
   * Вызывается сразу при получении trade event.
   * Проверяет:
   * - Есть ли активный ордер
   * - Совпадает ли tokenId
   * - Может ли этот trade заполнить наш ордер (по цене и side)
   *
   * Логика:
   * - BUY order @ X: SELL trade по цене <= X → fill
   * - SELL order @ X: BUY trade по цене >= X → fill
   */
  private checkTradeFill(
    tokenId: string,
    trade: { price: number; quantity: number; side: 'BUY' | 'SELL' | null }
  ): void {
    // Не в PAPER/REPLAY mode - не проверяем
    if (this.environment === 'LIVE') {
      return;
    }

    // Нет активного ордера - нечего проверять
    if (!this.activeOrder) {
      return;
    }

    // Не тот tokenId - не наш ордер
    if (this.activeOrder.tokenId !== tokenId) {
      return;
    }

    // Проверяем может ли этот trade заполнить наш ордер
    let canFill = false;
    let fillQuantity = 0;

    if (this.activeOrder.side === 'buy') {
      // Наш BUY ордер: ищем SELL trades по цене <= нашей
      // SELL trade означает что кто-то продаёт (taker) и бьёт по нашему BUY (maker)
      if (trade.side === 'SELL' || trade.side === null) {
        if (trade.price <= this.activeOrder.price) {
          canFill = true;
          fillQuantity = trade.quantity;
        }
      }
    } else {
      // Наш SELL ордер: ищем BUY trades по цене >= нашей
      // BUY trade означает что кто-то покупает (taker) и бьёт по нашему SELL (maker)
      if (trade.side === 'BUY' || trade.side === null) {
        if (trade.price >= this.activeOrder.price) {
          canFill = true;
          fillQuantity = trade.quantity;
        }
      }
    }

    if (canFill && fillQuantity > 0) {
      // ✅ v5.6: Защита от race condition - если уже заполняется, пропускаем
      if (this.isFillingInProgress) {
        return;
      }

      // Накапливаем filled quantity
      const remainingSize = this.activeOrder.size - this.activeOrder.filledQuantity;
      const actualFill = Math.min(fillQuantity, remainingSize);
      this.activeOrder.filledQuantity += actualFill;

      // Проверяем полный fill
      if (this.activeOrder.filledQuantity >= this.activeOrder.size) {
        // ✅ v5.6: Устанавливаем флаг ПЕРЕД emitVirtualFill
        this.isFillingInProgress = true;

        // ✅ v5.5: Формируем детали причины fill
        const tradeInfo = trade.side
          ? `${trade.side} trade @ ${trade.price.toFixed(4)} (qty: ${trade.quantity})`
          : `Trade @ ${trade.price.toFixed(4)} (qty: ${trade.quantity})`;
        const details = `Matched by ${tradeInfo}`;

        // Полный fill - emit OrderFilled event с причиной
        this.emitVirtualFill(
          {
            orderId: this.activeOrder.orderId,
            strategyId: this.activeOrder.strategyId,
            tokenId: this.activeOrder.tokenId,
            side: this.activeOrder.side,
            price: this.activeOrder.price,
            size: this.activeOrder.size,
          },
          FillReason.TRADE_THROUGH,
          details
        );

        // Очищаем активный ордер и флаг
        this.activeOrder = null;
        this.isFillingInProgress = false;
      }
    }
  }

  /**
   * Check if orderbook can fill our active order
   *
   * @remarks
   * v5.5: Orderbook-based fill detection!
   *
   * Вызывается при получении orderbook update.
   * Проверяет:
   * - Есть ли активный ордер
   * - Может ли противоположная сторона orderbook сматчить наш ордер
   *
   * Логика:
   * - BUY order @ X: если best ASK <= X → fill
   * - SELL order @ X: если best BID >= X → fill
   *
   * @example
   * ```typescript
   * // В MultiStrategyCoordinator при orderbook update:
   * wsManager.on('orderbook', (data) => {
   *   orderbookProjector.project(data);
   *   context.checkOrderbookFill();
   * });
   * ```
   */
  checkOrderbookFill(): void {
    // Не в PAPER/REPLAY mode - не проверяем
    if (this.environment === 'LIVE') {
      return;
    }

    // Нет активного ордера - нечего проверять
    if (!this.activeOrder) {
      return;
    }

    const tokenId = this.activeOrder.tokenId;
    let canFill = false;
    let details = '';

    if (this.activeOrder.side === 'buy') {
      // Наш BUY ордер: проверяем best ASK
      // Если best ASK <= нашей цены, биржа бы сматчила ордера
      const bestAsk = this.orderbookProjector.getBestAsk(tokenId);
      if (bestAsk !== null && bestAsk <= this.activeOrder.price) {
        canFill = true;
        details = `Best ASK ${bestAsk.toFixed(4)} <= order price ${this.activeOrder.price.toFixed(4)}`;
      }
    } else {
      // Наш SELL ордер: проверяем best BID
      // Если best BID >= нашей цены, биржа бы сматчила ордера
      const bestBid = this.orderbookProjector.getBestBid(tokenId);
      if (bestBid !== null && bestBid >= this.activeOrder.price) {
        canFill = true;
        details = `Best BID ${bestBid.toFixed(4)} >= order price ${this.activeOrder.price.toFixed(4)}`;
      }
    }

    if (canFill) {
      // ✅ v5.6: Защита от race condition - если уже заполняется, пропускаем
      if (this.isFillingInProgress) {
        return;
      }

      // ✅ v5.6: Устанавливаем флаг ПЕРЕД emitVirtualFill
      this.isFillingInProgress = true;

      // Emit OrderFilled event с причиной ORDERBOOK
      this.emitVirtualFill(
        {
          orderId: this.activeOrder.orderId,
          strategyId: this.activeOrder.strategyId,
          tokenId: this.activeOrder.tokenId,
          side: this.activeOrder.side,
          price: this.activeOrder.price,
          size: this.activeOrder.size,
        },
        FillReason.BOOK_TOUCH,
        details
      );

      // Очищаем активный ордер и флаг
      this.activeOrder = null;
      this.isFillingInProgress = false;
    }
  }
}
