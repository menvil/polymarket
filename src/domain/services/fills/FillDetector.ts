/**
 * Fill Detector - ОПТИМИСТИЧНАЯ детекция потенциальных fills
 *
 * @remarks
 * КРИТИЧНО: Одинаковая логика для backtest, simulation, и live!
 *
 * **ВАЖНО: Это ОПТИМИСТИЧНАЯ (не 100% точная) детекция!**
 *
 * В live режиме:
 * - FillDetector используется как ТРИГГЕР для проверки статуса ордера
 * - НЕ генерирует fills напрямую!
 * - Публикует CheckOrderStatus → проверка через API + баланс
 * - Только после подтверждения → OrderFilled event
 *
 * В backtest/simulation:
 * - FillDetector генерирует fills напрямую (оптимистично)
 * - Acceptable для симуляции, но НЕ для live!
 *
 * Детерминированная функция: (order, orderbook, trades) → result
 *
 * Fill detection priority:
 * 1. CROSSED_BOOK (highest realism ~95%)
 * 2. TRADE_THROUGH (medium realism ~60% - ignores queue position!)
 * 3. BOOK_TOUCH (lowest realism ~20% - ignores time priority!)
 *
 * Volume check:
 * - Если volume < orderSize → NO fill
 * - Partial fills не поддерживаются в v1
 *
 * @example
 * ```typescript
 * const detector = new FillDetector();
 *
 * const result = detector.detectFill(
 *   { orderId: '1', side: 'buy', price: 0.55, size: 10 },
 *   { bestBid: 0.54, bestAsk: 0.50, bids: [], asks: [{ price: 0.50, size: 20 }] },
 *   [],
 *   5000
 * );
 *
 * if (result.shouldFill) {
 *   // LIVE MODE: Trigger CheckOrderStatus (confirm via API + balance)
 *   // BACKTEST MODE: Generate fill directly
 *   console.log('Potential fill detected:', result.reason);
 * }
 * ```
 */

/**
 * Order для проверки на fill
 */
export interface OrderForFillCheck {
  /** Order ID */
  orderId: string;

  /** Order side */
  side: 'buy' | 'sell';

  /** Order price */
  price: number;

  /** Order size */
  size: number;
}

/**
 * Orderbook для проверки на fill
 */
export interface OrderbookForFillCheck {
  /** Best bid price */
  bestBid: number;

  /** Best ask price */
  bestAsk: number;

  /** Bid levels */
  bids: Array<{ price: number; size: number }>;

  /** Ask levels */
  asks: Array<{ price: number; size: number }>;
}

/**
 * Trade для проверки на fill (TRADE_THROUGH detection)
 */
export interface TradeForFillCheck {
  /** Trade price */
  price: number;

  /** Trade size */
  size: number;

  /** Trade side (who took liquidity) */
  side: 'buy' | 'sell';

  /** Trade timestamp (for time window check) */
  timestamp: number;
}

/**
 * Fill reason type - matches backtest FillReason enum
 */
export type FillReasonType = 'CROSSED_BOOK' | 'TRADE_THROUGH' | 'BOOK_TOUCH';

/**
 * Fill detection result
 */
export interface FillDetectionResult {
  /** Should order be filled? */
  shouldFill: boolean;

  /** Fill reason (null if no fill) */
  reason: FillReasonType | null;

  /** Available volume at price level (undefined if no fill) */
  availableVolume?: number;
}

// Re-export FillReasonType as FillReason for compatibility
export type { FillReasonType as FillReason };

/**
 * Fill Detector - ОПТИМИСТИЧНАЯ детекция потенциальных fills
 *
 * @remarks
 * КРИТИЧНО: Одинаковая логика для backtest и live!
 *
 * **ВАЖНО: Не дает 100% гарантии исполнения!**
 *
 * Детерминированная: (order, orderbook, trades) → result
 *
 * Algorithm:
 * 1. Check CROSSED_BOOK (order price crosses spread) - ~95% accuracy
 * 2. Check TRADE_THROUGH (trade at/through our price) - ~60% accuracy (ignores queue!)
 * 3. Check BOOK_TOUCH (order at top of book) - ~20% accuracy (ignores priority!)
 *
 * Each check includes volume validation.
 *
 * В live режиме результат FillDetector должен триггерить проверку:
 * - Запрос статуса ордера через API
 * - Проверка изменения баланса/позиции
 * - Только после подтверждения → OrderFilled
 */
export class FillDetector {
  /**
   * Detect if order POTENTIALLY should be filled (OPTIMISTIC!)
   *
   * @param order - Order to check
   * @param orderbook - Current orderbook state
   * @param recentTrades - Recent trades (for TRADE_THROUGH detection)
   * @param tradeWindowMs - Time window for trades (default: 5000ms)
   * @returns Fill detection result
   *
   * @remarks
   * КРИТИЧНО: Это ОПТИМИСТИЧНАЯ детекция - НЕ 100% точная!
   *
   * Детерминированная функция - одинаковые входы → одинаковый результат.
   * Используется в backtest, simulation, и live режимах.
   *
   * **В live режиме:**
   * - shouldFill=true → ТРИГГЕР для проверки (CheckOrderStatus)
   * - Требуется подтверждение через API (getOpenOrders + getOutcomeBalance)
   * - Только после подтверждения → OrderFilled
   *
   * **В backtest/simulation:**
   * - shouldFill=true → генерирует fill напрямую
   * - Оптимистичная симуляция (acceptable для тестирования)
   *
   * **Почему не 100% точно?**
   * - TRADE_THROUGH: Игнорирует очередь ордеров на price level
   * - BOOK_TOUCH: Игнорирует time priority (FIFO)
   * - CROSSED_BOOK: Наиболее точный (~95%)
   *
   * @example
   * ```typescript
   * const result = detector.detectFill(
   *   { orderId: '1', side: 'buy', price: 0.55, size: 10 },
   *   { bestBid: 0.54, bestAsk: 0.50, bids: [], asks: [{ price: 0.50, size: 20 }] },
   *   [],
   *   5000
   * );
   *
   * if (result.shouldFill) {
   *   // LIVE: Publish CheckOrderStatus (confirm via API)
   *   // BACKTEST: Generate OrderFilled directly
   *   console.log(`Potential fill detected: ${result.reason}`);
   *   console.log(`Available volume: ${result.availableVolume}`);
   * }
   * ```
   */
  detectFill(
    order: OrderForFillCheck,
    orderbook: OrderbookForFillCheck,
    recentTrades: TradeForFillCheck[],
    tradeWindowMs: number = 5000
  ): FillDetectionResult {
    if (order.side === 'buy') {
      return this.detectBuyFill(order, orderbook, recentTrades, tradeWindowMs);
    } else {
      return this.detectSellFill(order, orderbook, recentTrades, tradeWindowMs);
    }
  }

  /**
   * Detect BUY order fill (OPTIMISTIC!)
   *
   * @param order - BUY order to check
   * @param orderbook - Current orderbook
   * @param recentTrades - Recent trades
   * @param tradeWindowMs - Trade time window
   * @returns Fill detection result
   *
   * @remarks
   * BUY order POTENTIALLY fills when:
   * 1. CROSSED_BOOK: buy price > bestAsk (агрессивный ордер) - ~95% accurate
   * 2. TRADE_THROUGH: sell trade at/below our price - ~60% accurate (ignores queue!)
   * 3. BOOK_TOUCH: buy price == bestAsk (на top of book) - ~20% accurate (ignores FIFO!)
   *
   * **КРИТИЧНО для live режима:**
   * - Результат this метода = ТРИГГЕР для CheckOrderStatus
   * - НЕ означает что ордер 100% filled!
   * - Требуется подтверждение через API + balance check
   */
  private detectBuyFill(
    order: OrderForFillCheck,
    orderbook: OrderbookForFillCheck,
    recentTrades: TradeForFillCheck[],
    tradeWindowMs: number
  ): FillDetectionResult {
    const { bestAsk, asks } = orderbook;

    // 1. CROSSED_BOOK: buy price > bestAsk
    // КРИТИЧНО: Strict inequality (>), NOT (>=)
    if (order.price > bestAsk) {
      const availableVolume = this.getVolumeAtPrice(asks, bestAsk);

      // ✅ Volume check: Insufficient volume → NO fill
      if (availableVolume < order.size) {
        return { shouldFill: false, reason: null };
      }

      return {
        shouldFill: true,
        reason: 'CROSSED_BOOK',
        availableVolume,
      };
    }

    // 2. TRADE_THROUGH: trade at or below our price
    const now = Date.now();
    const matchingTrade = recentTrades.find(
      (t) =>
        t.side === 'sell' &&
        t.price <= order.price &&
        now - t.timestamp < tradeWindowMs
    );

    if (matchingTrade) {
      // ✅ Volume check
      if (matchingTrade.size < order.size) {
        return { shouldFill: false, reason: null };
      }

      return {
        shouldFill: true,
        reason: 'TRADE_THROUGH',
        availableVolume: matchingTrade.size,
      };
    }

    // 3. BOOK_TOUCH: our price == bestAsk
    // КРИТИЧНО: Exact equality check with floating point tolerance
    if (Math.abs(order.price - bestAsk) < 0.0001) {
      const availableVolume = this.getVolumeAtPrice(asks, bestAsk);

      // ✅ Volume check
      if (availableVolume < order.size) {
        return { shouldFill: false, reason: null };
      }

      return {
        shouldFill: true,
        reason: 'BOOK_TOUCH',
        availableVolume,
      };
    }

    return { shouldFill: false, reason: null };
  }

  /**
   * Detect SELL order fill (OPTIMISTIC!)
   *
   * @param order - SELL order to check
   * @param orderbook - Current orderbook
   * @param recentTrades - Recent trades
   * @param tradeWindowMs - Trade time window
   * @returns Fill detection result
   *
   * @remarks
   * SELL order POTENTIALLY fills when:
   * 1. CROSSED_BOOK: sell price < bestBid (агрессивный ордер) - ~95% accurate
   * 2. TRADE_THROUGH: buy trade at/above our price - ~60% accurate (ignores queue!)
   * 3. BOOK_TOUCH: sell price == bestBid (на top of book) - ~20% accurate (ignores FIFO!)
   *
   * **КРИТИЧНО для live режима:**
   * - Результат this метода = ТРИГГЕР для CheckOrderStatus
   * - НЕ означает что ордер 100% filled!
   * - Требуется подтверждение через API + balance check
   */
  private detectSellFill(
    order: OrderForFillCheck,
    orderbook: OrderbookForFillCheck,
    recentTrades: TradeForFillCheck[],
    tradeWindowMs: number
  ): FillDetectionResult {
    const { bestBid, bids } = orderbook;

    // 1. CROSSED_BOOK: sell price < bestBid
    // КРИТИЧНО: Strict inequality (<), NOT (<=)
    if (order.price < bestBid) {
      const availableVolume = this.getVolumeAtPrice(bids, bestBid);

      if (availableVolume < order.size) {
        return { shouldFill: false, reason: null };
      }

      return {
        shouldFill: true,
        reason: 'CROSSED_BOOK',
        availableVolume,
      };
    }

    // 2. TRADE_THROUGH: trade at or above our price
    const now = Date.now();
    const matchingTrade = recentTrades.find(
      (t) =>
        t.side === 'buy' &&
        t.price >= order.price &&
        now - t.timestamp < tradeWindowMs
    );

    if (matchingTrade) {
      if (matchingTrade.size < order.size) {
        return { shouldFill: false, reason: null };
      }

      return {
        shouldFill: true,
        reason: 'TRADE_THROUGH',
        availableVolume: matchingTrade.size,
      };
    }

    // 3. BOOK_TOUCH: our price == bestBid
    if (Math.abs(order.price - bestBid) < 0.0001) {
      const availableVolume = this.getVolumeAtPrice(bids, bestBid);

      if (availableVolume < order.size) {
        return { shouldFill: false, reason: null };
      }

      return {
        shouldFill: true,
        reason: 'BOOK_TOUCH',
        availableVolume,
      };
    }

    return { shouldFill: false, reason: null };
  }

  /**
   * Get volume at specific price level
   *
   * @param levels - Price levels (bids or asks)
   * @param targetPrice - Target price
   * @returns Volume at price level (0 if not found)
   *
   * @remarks
   * Uses floating point tolerance (0.0001) for price comparison.
   */
  private getVolumeAtPrice(
    levels: Array<{ price: number; size: number }>,
    targetPrice: number
  ): number {
    const level = levels.find((l) => Math.abs(l.price - targetPrice) < 0.0001);
    return level ? level.size : 0;
  }
}
