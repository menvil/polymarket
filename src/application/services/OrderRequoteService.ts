/**
 * Order Requote Service
 *
 * @remarks
 * Monitors orderbook updates and requotes (cancel + replace) orders
 * when market price moves away from our order price.
 *
 * Key responsibilities:
 * - Listen to OrderbookUpdate events
 * - Compare current market price with active order price
 * - Cancel + replace order if price moved > threshold
 *
 * @example
 * ```typescript
 * const service = new OrderRequoteService(
 *   eventBus,
 *   restAdapter,
 *   logger,
 *   { threshold: 0.02, cooldownMs: 5000 }
 * );
 *
 * // Track active order
 * service.trackOrder({
 *   orderId: 'abc-123',
 *   tokenId: '0x123',
 *   side: 'buy',
 *   price: 0.50,
 *   size: 100,
 * });
 *
 * // Service listens to OrderbookUpdate events
 * // If market price moves to 0.55 (> 2% threshold)
 * // → Cancel order 'abc-123'
 * // → Place new order at ~0.55
 * ```
 */

import type { IEventBus } from '../../shared/events/IEventBus.js';
import type { ILogger } from '../../domain/ports/ILogger.js';
import { FillDetector } from '../../domain/services/fills/FillDetector.js';
import { createProductionEnvelope } from '../../shared/events/EventEnvelope.js';

/**
 * Orderbook update event (from WebSocket or replay)
 */
interface OrderbookUpdate {
  type: 'OrderbookUpdate';
  tokenId: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp?: Date;
}

/**
 * Active order being tracked for requote
 */
interface TrackedOrder {
  /** Order ID */
  orderId: string;

  /** Token ID (market) */
  tokenId: string;

  /** Order side */
  side: 'buy' | 'sell';

  /** Order price */
  price: number;

  /** Order size */
  size: number;

  /** Strategy ID (for correlation) */
  strategyId: string;

  /** Last requote timestamp (to prevent rapid requotes) */
  lastRequoteTime?: number;
}

/**
 * Requote configuration
 */
export interface RequoteConfig {
  /** Price deviation threshold (default: 0.02 = 2%) */
  threshold?: number;

  /** Minimum time between requotes in ms (default: 5000ms) */
  cooldownMs?: number;

  /** Enable/disable requoting (default: true) */
  enabled?: boolean;
}

/**
 * Order Requote Service
 *
 * @remarks
 * IMPORTANT: This service only DECIDES when to requote.
 * Actual cancellation + placement is done by StrategyExecutor.
 */
export class OrderRequoteService {
  private readonly trackedOrders: Map<string, TrackedOrder> = new Map();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly enabled: boolean;
  private unsubscribe?: () => void;
  private readonly fillDetector = new FillDetector();

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: ILogger,
    config: RequoteConfig = {}
  ) {
    this.threshold = config.threshold ?? 0.02;
    this.cooldownMs = config.cooldownMs ?? 5000;
    this.enabled = config.enabled ?? true;

    if (this.enabled) {
      this.subscribeToOrderbookUpdates();
    }
  }

  /**
   * Track order for requoting
   *
   * @param order - Order to track
   *
   * @remarks
   * Called by StrategyRunner when order is placed (OrderAccepted).
   */
  trackOrder(order: TrackedOrder): void {
    this.trackedOrders.set(order.orderId, order);

    this.logger.debug('[OrderRequoteService] Tracking order for requote', {
      orderId: order.orderId,
      tokenId: order.tokenId,
      side: order.side,
      price: order.price,
      threshold: this.threshold,
    });
  }

  /**
   * Stop tracking order
   *
   * @param orderId - Order ID to untrack
   *
   * @remarks
   * Called when order is filled, cancelled, or rejected.
   */
  untrackOrder(orderId: string): void {
    this.trackedOrders.delete(orderId);
    this.logger.debug('[OrderRequoteService] Stopped tracking order', { orderId });
  }

  /**
   * Subscribe to market events (orderbook updates + trades)
   */
  private subscribeToOrderbookUpdates(): void {
    // Subscribe to all events and filter by type
    this.unsubscribe = this.eventBus.subscribe('*', (envelope: any) => {
      if (envelope.event.type === 'OrderbookUpdate') {
        this.handleOrderbookUpdate(envelope.event as OrderbookUpdate);
      } else if (envelope.event.type === 'TradeMatched') {
        this.handleTradeMatched(envelope.event as any);
      }
    });

    this.logger.info('[OrderRequoteService] Subscribed to OrderbookUpdate + TradeMatched events');
  }

  /**
   * Handle trade matched event
   *
   * @param event - Trade matched event
   *
   * @remarks
   * CRITICAL: When a trade happens, check if it could have filled our order.
   * If trade price matches our order price → TRIGGER order status check.
   *
   * **ВАЖНО: Трейд по нашей цене НЕ означает что ордер filled!**
   * - Могут быть другие ордера в очереди на этой цене
   * - Нужно проверить реальный статус через API
   *
   * This handler publishes CheckOrderStatus event → main.ts handler confirms via API.
   * Polling (OrderReconciliationService) is only a fallback for missed events.
   */
  private handleTradeMatched(event: any): void {
    const { tokenId, price, side } = event;

    // Get tracked orders for this market
    const ordersForMarket = Array.from(this.trackedOrders.values()).filter(
      (order) => order.tokenId === tokenId
    );

    if (ordersForMarket.length === 0) {
      return; // No tracked orders for this market
    }

    // Check if any of our orders could have been filled
    for (const order of ordersForMarket) {
      // Trade on sell side can fill our buy order
      // Trade on buy side can fill our sell order
      const tradeSideMatchesOurs =
        (side === 'sell' && order.side === 'buy') ||
        (side === 'buy' && order.side === 'sell');

      if (!tradeSideMatchesOurs) {
        continue;
      }

      // Check if trade price matches our order price (with small tolerance)
      const priceTolerance = 0.0001;
      const priceMatches = Math.abs(price - order.price) < priceTolerance;

      if (priceMatches) {
        this.logger.info('[OrderRequoteService] Trade matched at our order price, checking order status', {
          orderId: order.orderId,
          tokenId: order.tokenId,
          orderPrice: order.price,
          tradePrice: price,
        });

        // Publish event to trigger order status check
        this.eventBus.publish(
          createProductionEnvelope(
            {
              type: 'CheckOrderStatus',
              orderId: order.orderId,
              strategyId: order.strategyId,
              reason: 'Trade matched at order price',
              timestamp: new Date(),
            },
            {
              environment: 'LIVE',
              accountId: 'default',
            }
          )
        );
      }
    }
  }

  /**
   * Handle orderbook update
   *
   * @param event - Orderbook update event
   *
   * @remarks
   * Algorithm:
   * 1. Get tracked orders for this market
   * 2. Calculate current mid price
   * 3. For each tracked order:
   *    A. CHECK IF ORDER POTENTIALLY FILLED (using FillDetector)
   *       - FillDetector → ОПТИМИСТИЧНАЯ детекция (не 100% точная!)
   *       - Если shouldFill=true → TRIGGER CheckOrderStatus
   *       - CheckOrderStatus handler (main.ts) подтверждает через API
   *       - **ВАЖНО: НЕ генерируем OrderFilled напрямую!**
   *    B. Calculate price deviation (for requoting)
   *       - If deviation > threshold AND cooldown passed:
   *         → Publish RequoteNeeded event
   *
   * **КРИТИЧНО:** FillDetector = триггер, не окончательное решение!
   * - TRADE_THROUGH ignores queue position (~60% accuracy)
   * - BOOK_TOUCH ignores time priority (~20% accuracy)
   * - Требуется подтверждение через API + balance check
   */
  private handleOrderbookUpdate(event: OrderbookUpdate): void {
    // Get tracked orders for this market
    const ordersForMarket = Array.from(this.trackedOrders.values()).filter(
      (order) => order.tokenId === event.tokenId
    );

    if (ordersForMarket.length === 0) {
      return; // No tracked orders for this market
    }

    // Calculate current market prices
    const bestBid = event.bids[0]?.price ?? 0;
    const bestAsk = event.asks[0]?.price ?? 1;
    const midPrice = (bestBid + bestAsk) / 2;

    const now = Date.now();

    for (const order of ordersForMarket) {
      // ✅ v6: Use FillDetector (shared logic with backtest!)
      // КРИТИЧНО: Одинаковая логика детекции fills в backtest и live!
      //
      // **ВАЖНО:** FillDetector → ОПТИМИСТИЧНАЯ детекция (не 100% точная!)
      // - shouldFill=true → ТРИГГЕР для проверки (не окончательное решение!)
      // - Требуется подтверждение через CheckOrderStatus handler
      const fillResult = this.fillDetector.detectFill(
        {
          orderId: order.orderId,
          side: order.side,
          price: order.price,
          size: order.size,
        },
        {
          bestBid,
          bestAsk,
          bids: event.bids.map((b) => ({ price: b.price, size: b.size })),
          asks: event.asks.map((a) => ({ price: a.price, size: a.size })),
        },
        [], // TODO: Track recent trades from WebSocket
        5000
      );

      if (fillResult.shouldFill) {
        // Order POTENTIALLY filled → trigger status check (NOT confirmed yet!)
        // CheckOrderStatus handler will confirm via API + balance check
        this.logger.info('[OrderRequoteService] Potential fill detected (TRIGGERING status check)', {
          orderId: order.orderId,
          reason: fillResult.reason,
          availableVolume: fillResult.availableVolume,
          orderSide: order.side,
          orderPrice: order.price,
          bestBid,
          bestAsk,
        });

        // Publish event to trigger immediate order status check
        this.eventBus.publish(
          createProductionEnvelope(
            {
              type: 'CheckOrderStatus',
              orderId: order.orderId,
              strategyId: order.strategyId,
              reason: `FillDetector: ${fillResult.reason}`,
              timestamp: new Date(),
            },
            {
              environment: 'LIVE',
              accountId: 'default',
            }
          )
        );

        // Don't requote if order should be filled
        continue;
      }

      // Check cooldown for requoting
      if (order.lastRequoteTime && now - order.lastRequoteTime < this.cooldownMs) {
        continue; // Still in cooldown
      }

      // Calculate price deviation for requoting
      const deviation = Math.abs(midPrice - order.price) / order.price;

      if (deviation > this.threshold) {
        this.logger.warn('[OrderRequoteService] Price moved beyond threshold, requoting', {
          orderId: order.orderId,
          tokenId: order.tokenId,
          side: order.side,
          ourPrice: order.price,
          currentMid: midPrice,
          deviation: `${(deviation * 100).toFixed(2)}%`,
          threshold: `${(this.threshold * 100).toFixed(0)}%`,
        });

        // Publish RequoteIntent event (StrategyRunner will handle)
        this.eventBus.publish(
          createProductionEnvelope(
            {
              type: 'RequoteNeeded',
              orderId: order.orderId,
              strategyId: order.strategyId,
              tokenId: order.tokenId,
              oldPrice: order.price,
              newPrice: midPrice,
              side: order.side,
              size: order.size,
              timestamp: new Date(),
            },
            {
              environment: 'LIVE',
              accountId: 'default',
            }
          )
        );

        // Update last requote time
        order.lastRequoteTime = now;
      }
    }
  }

  /**
   * Cleanup (unsubscribe from events)
   */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }

    this.trackedOrders.clear();
    this.logger.info('[OrderRequoteService] Destroyed');
  }
}
