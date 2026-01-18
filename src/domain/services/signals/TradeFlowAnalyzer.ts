/**
 * TradeFlowAnalyzer - анализ торгового потока
 *
 * @remarks
 * Event-driven анализатор торгового потока с:
 * - **Fragility**: Насколько легко цена движется при объёме
 * - **Exponential Decay**: Старые данные плавно теряют вес
 * - **Time-to-next-fill**: Усилитель fragility по скорости реакции
 * - **Market States**: DEAD / FRAGILE / DIRECTIONAL / PRESSURE
 *
 * Алгоритм:
 * 1. При каждой сделке: recordTrade() → обновляет trade imbalance
 * 2. При каждом тике цены: recordPriceTick() → обновляет fragility
 * 3. При каждом снапшоте стакана: recordOrderBook() → обновляет book imbalance
 * 4. getMarketState() → возвращает агрегированные метрики
 *
 * Exponential Decay:
 * ```
 * x_new = x_old × exp(-λ × dt)
 * ```
 * - Старые данные плавно теряют влияние
 * - Нет резкого отсечения по границе окна
 * - Мгновенная реакция на новые события
 *
 * @example
 * ```typescript
 * const analyzer = new TradeFlowAnalyzer(config, logger);
 *
 * // Event-driven updates
 * analyzer.recordTrade({ side: 'BUY', price: 0.65, size: 100, timestamp: Date.now() });
 * analyzer.recordPriceTick(2, Date.now()); // 2 ticks up
 * analyzer.recordOrderBook(bookSnapshot);
 *
 * // Get current state
 * const metrics = analyzer.getMarketState();
 * console.log(`State: ${metrics.state}, Fragility: ${metrics.fragilityScore}`);
 * ```
 */
import { ILogger } from '../../ports/ILogger.js';
import {
  TradeEvent,
  OrderBookSnapshot,
  MarketState,
  TradeFlowMetrics,
  TradeFlowConfig,
  MarketContext,
  getMarketLogInfo,
  DEFAULT_TRADE_FLOW_CONFIG,
} from './types.js';

/**
 * FragilityState - внутреннее состояние для расчёта fragility
 *
 * @remarks
 * Хранит накопленные ticks и volume с exponential decay.
 * Рассчитывает fragility score и time-to-fill score.
 */
class FragilityState {
  /** Накопленные тики (с decay) */
  public ticks: number = 0;
  /** Накопленный объём (с decay) */
  public volume: number = 0;
  /** Timestamp последнего обновления */
  public lastUpdate: number = Date.now();
  /** Timestamp последнего тика цены */
  public lastTickTime: number | null = null;
  /** Time-to-next-fill после последнего тика (с decay) */
  public lastFillAfterTick: number | null = null;

  constructor(private readonly config: TradeFlowConfig) {}

  /**
   * Применяет exponential decay к состоянию
   *
   * @param now - Текущий timestamp
   * @returns decay factor
   *
   * @remarks
   * Формула: x_new = x_old × exp(-λ × dt)
   * Где dt = now - lastUpdate в миллисекундах
   */
  public decay(now: number): number {
    const dt = now - this.lastUpdate;
    if (dt <= 0) return 1;

    const factor = Math.exp(-this.config.decayLambda * dt);
    this.ticks *= factor;
    this.volume *= factor;

    if (this.lastFillAfterTick !== null) {
      this.lastFillAfterTick *= factor;
    }

    this.lastUpdate = now;
    return factor;
  }

  /**
   * Записывает тик цены
   *
   * @param deltaTicks - Количество тиков (положительное или отрицательное)
   * @param timestamp - Timestamp тика
   */
  public onTick(deltaTicks: number, timestamp: number): void {
    this.decay(timestamp);
    this.ticks += Math.abs(deltaTicks);
    this.lastTickTime = timestamp;
  }

  /**
   * Записывает сделку (для time-to-fill)
   *
   * @param size - Размер сделки
   * @param timestamp - Timestamp сделки
   */
  public onTrade(size: number, timestamp: number): void {
    this.decay(timestamp);
    this.volume += size;

    // Рассчитываем time-to-fill если был недавний тик
    if (this.lastTickTime !== null) {
      const timeToFill = timestamp - this.lastTickTime;
      // Обновляем lastFillAfterTick только если это быстрая реакция
      if (timeToFill < this.config.timeToFillSlow) {
        this.lastFillAfterTick = timeToFill;
      }
    }
  }

  /**
   * Возвращает time-to-fill score
   *
   * @returns Score 0-1 (1 = очень быстрая реакция, 0 = медленная/нет)
   */
  public getTimeToFillScore(): number {
    if (this.lastFillAfterTick === null) return 0;

    const dt = this.lastFillAfterTick;
    if (dt < this.config.timeToFillFast) return 1.0;
    if (dt < this.config.timeToFillMedium) return 0.7;
    if (dt < this.config.timeToFillSlow) return 0.3;
    return 0;
  }

  /**
   * Возвращает fragility score
   *
   * @returns Score 0-1
   *
   * @remarks
   * Формула: clamp((ticks / volume) × fragilityScale) × timeToFillScore
   * - Высокий ticks/volume = хрупкий рынок
   * - Умножаем на timeToFillScore для усиления при быстрой реакции
   */
  public getFragilityScore(): number {
    if (this.volume < this.config.minAggressiveVolume) return 0;
    if (this.ticks === 0) return 0;

    const raw = this.ticks / this.volume;
    const scaled = raw * this.config.fragilityScale;
    const clamped = Math.max(0, Math.min(1, scaled));

    return clamped * this.getTimeToFillScore();
  }

  /**
   * Сбрасывает состояние
   */
  public reset(): void {
    this.ticks = 0;
    this.volume = 0;
    this.lastUpdate = Date.now();
    this.lastTickTime = null;
    this.lastFillAfterTick = null;
  }
}

/**
 * TradeFlowAnalyzer
 *
 * @remarks
 * Event-driven анализатор торгового потока.
 * Все методы record* обновляют внутреннее состояние с O(1) сложностью.
 */
export class TradeFlowAnalyzer {
  private readonly config: TradeFlowConfig;
  private readonly logger: ILogger;

  /** Market context for logging */
  private marketContext: MarketContext | null = null;

  /** Fragility state с decay */
  private fragility: FragilityState;

  /** Последний снапшот стакана */
  private lastBook: OrderBookSnapshot | null = null;

  /** Накопленный объём агрессивных покупок (с decay) */
  private buyAggressive: number = 0;

  /** Накопленный объём агрессивных продаж (с decay) */
  private sellAggressive: number = 0;

  /** Timestamp последнего обновления trade volumes */
  private lastTradeUpdate: number = Date.now();

  /** Счётчик для periodic logging */
  private logCounter: number = 0;

  /**
   * Создаёт TradeFlowAnalyzer
   *
   * @param config - Конфигурация (опционально)
   * @param logger - Логгер
   *
   * @example
   * ```typescript
   * const analyzer = new TradeFlowAnalyzer(DEFAULT_TRADE_FLOW_CONFIG, logger);
   * ```
   */
  constructor(
    config: Partial<TradeFlowConfig> = {},
    logger: ILogger
  ) {
    this.config = { ...DEFAULT_TRADE_FLOW_CONFIG, ...config };
    this.logger = logger.child?.('TradeFlowAnalyzer') || logger;
    this.fragility = new FragilityState(this.config);
  }

  /**
   * Sets market context for logging
   *
   * @param context - Market context with id, slug, question, expiry
   */
  public setMarketContext(context: MarketContext): void {
    this.marketContext = context;
    this.logger.debug('[TradeFlow] Market context set', {
      ...getMarketLogInfo(context),
      marketId: context.marketId,
      marketSlug: context.marketSlug,
    });
  }

  /**
   * Gets market info for log JSON
   */
  private getMarketInfo(): { market: string; marketUrl: string; expiresInSec: number; expiresIn: string } {
    return getMarketLogInfo(this.marketContext);
  }

  /**
   * Записывает сделку (event-driven)
   *
   * @param trade - Событие сделки
   *
   * @remarks
   * Обновляет:
   * - buyAggressive / sellAggressive (с decay)
   * - FragilityState.volume и time-to-fill
   *
   * @example
   * ```typescript
   * analyzer.recordTrade({
   *   side: 'BUY',
   *   price: 0.65,
   *   size: 100,
   *   timestamp: Date.now()
   * });
   * ```
   */
  public recordTrade(trade: TradeEvent): void {
    const now = trade.timestamp;

    // Apply decay to trade volumes
    this.applyTradeDecay(now);

    // Update fragility state
    this.fragility.onTrade(trade.size, now);

    // Update trade imbalance
    if (trade.side === 'BUY') {
      this.buyAggressive += trade.size;
    } else if (trade.side === 'SELL') {
      this.sellAggressive += trade.size;
    }
    // UNKNOWN trades are ignored for imbalance

    this.logger.trace('[TradeFlow] Trade recorded', {
      ...this.getMarketInfo(),
      side: trade.side,
      price: trade.price.toFixed(4),
      size: trade.size.toFixed(2),
      buyAggressive: this.buyAggressive.toFixed(2),
      sellAggressive: this.sellAggressive.toFixed(2),
    });
  }

  /**
   * Записывает снапшот стакана (event-driven)
   *
   * @param book - Снапшот стакана
   *
   * @remarks
   * Обновляет lastBook для расчёта bookImbalance.
   *
   * @example
   * ```typescript
   * analyzer.recordOrderBook({
   *   bids: [{ price: 0.64, size: 100 }, { price: 0.63, size: 50 }],
   *   asks: [{ price: 0.66, size: 80 }, { price: 0.67, size: 60 }],
   *   timestamp: Date.now()
   * });
   * ```
   */
  public recordOrderBook(book: OrderBookSnapshot): void {
    this.lastBook = book;
  }

  /**
   * Записывает тик цены (event-driven)
   *
   * @param deltaTicks - Количество тиков изменения (может быть отрицательным)
   * @param timestamp - Timestamp тика
   *
   * @remarks
   * Используется для расчёта fragility.
   * deltaTicks = (newPrice - oldPrice) / tickSize
   *
   * @example
   * ```typescript
   * // Цена выросла на 2 тика
   * analyzer.recordPriceTick(2, Date.now());
   *
   * // Цена упала на 1 тик
   * analyzer.recordPriceTick(-1, Date.now());
   * ```
   */
  public recordPriceTick(deltaTicks: number, timestamp: number): void {
    if (deltaTicks === 0) return;

    this.fragility.onTick(deltaTicks, timestamp);

    this.logger.trace('[TradeFlow] Price tick recorded', {
      ...this.getMarketInfo(),
      deltaTicks,
      totalTicks: this.fragility.ticks.toFixed(4),
      volume: this.fragility.volume.toFixed(2),
    });
  }

  /**
   * Возвращает текущие метрики и состояние рынка
   *
   * @returns TradeFlowMetrics
   *
   * @remarks
   * Рассчитывает:
   * - fragilityScore: (ticks / volume) × timeToFillScore
   * - tradeImbalance: (buy - sell) / (buy + sell)
   * - bookImbalance: (bidDepth - askDepth) / (bidDepth + askDepth)
   * - marketPressureScore: fragility × bookImbalance × confirmation
   * - state: DEAD / FRAGILE / DIRECTIONAL / PRESSURE
   *
   * @example
   * ```typescript
   * const metrics = analyzer.getMarketState();
   *
   * console.log(`State: ${metrics.state}`);
   * console.log(`Fragility: ${metrics.fragilityScore}`);
   * console.log(`Trade Imbalance: ${metrics.tradeImbalance}`);
   * console.log(`Book Imbalance: ${metrics.bookImbalance}`);
   * ```
   */
  public getMarketState(): TradeFlowMetrics {
    const now = Date.now();

    // Apply decay to get current values
    const decayFactor = this.fragility.decay(now);
    this.applyTradeDecay(now);

    // Calculate metrics
    const fragilityScore = this.fragility.getFragilityScore();
    const { bidDepth, askDepth, bookImbalance } = this.computeBookImbalance();
    const tradeImbalance = this.computeTradeImbalance(fragilityScore);

    // Calculate market pressure and state
    let marketPressureScore = 0;
    let state: MarketState = 'DEAD';

    if (fragilityScore === 0) {
      state = 'DEAD';
    } else if (Math.abs(bookImbalance) < this.config.bookMinThreshold) {
      state = 'FRAGILE';
    } else {
      // Check if trade and book imbalance confirm each other
      const tradeSign = Math.sign(tradeImbalance);
      const bookSign = Math.sign(bookImbalance);
      const confirmation = tradeSign === bookSign
        ? Math.abs(tradeImbalance)
        : -Math.abs(tradeImbalance);

      marketPressureScore = fragilityScore * bookImbalance * confirmation;
      state = confirmation > 0 ? 'PRESSURE' : 'DIRECTIONAL';
    }

    const metrics: TradeFlowMetrics = {
      fragilityScore,
      tradeImbalance,
      bookImbalance,
      marketPressureScore,
      state,
      bidDepth,
      askDepth,
      buyVolume: this.buyAggressive,
      sellVolume: this.sellAggressive,
      totalTicks: this.fragility.ticks,
    };

    // TRACE: Detailed calculation breakdowns
    this.logger.trace('[TradeFlow] Fragility calculation breakdown', {
      ...this.getMarketInfo(),
      // Step 1: Raw values
      rawTicks: this.fragility.ticks.toFixed(4),
      rawVolume: this.fragility.volume.toFixed(2),
      minAggressiveVolume: this.config.minAggressiveVolume,
      volumeCheck: this.fragility.volume >= this.config.minAggressiveVolume ? 'PASS' : 'FAIL (volume too low)',

      // Step 2: Raw ratio
      rawRatio: this.fragility.volume > 0 ? (this.fragility.ticks / this.fragility.volume).toFixed(6) : '0 (no volume)',

      // Step 3: Scaled value
      fragilityScale: this.config.fragilityScale,
      scaledValue: this.fragility.volume > 0
        ? ((this.fragility.ticks / this.fragility.volume) * this.config.fragilityScale).toFixed(4)
        : '0',

      // Step 4: Time-to-fill score
      timeToFillScore: this.fragility.getTimeToFillScore().toFixed(2),
      lastFillAfterTick: this.fragility.lastFillAfterTick?.toFixed(0) || 'null',

      // Step 5: Final clamped
      finalFragilityScore: fragilityScore.toFixed(4),
      formula: 'clamp(0,1)[(ticks/volume) × scale] × timeToFillScore',
    });

    this.logger.trace('[TradeFlow] Book imbalance calculation', {
      ...this.getMarketInfo(),
      // Step 1: Get levels
      bookLevels: this.config.bookLevels,
      bidLevelsCount: this.lastBook?.bids.length || 0,
      askLevelsCount: this.lastBook?.asks.length || 0,

      // Step 2: Sum depths
      bidDepth: bidDepth.toFixed(2),
      askDepth: askDepth.toFixed(2),
      totalDepth: (bidDepth + askDepth).toFixed(2),

      // Step 3: Calculate imbalance
      bookImbalance: bookImbalance.toFixed(4),
      formula: '(bidDepth - askDepth) / (bidDepth + askDepth)',
    });

    this.logger.trace('[TradeFlow] Trade imbalance calculation', {
      ...this.getMarketInfo(),
      buyAggressive: this.buyAggressive.toFixed(2),
      sellAggressive: this.sellAggressive.toFixed(2),
      totalAggressive: (this.buyAggressive + this.sellAggressive).toFixed(2),
      tradeImbalance: tradeImbalance.toFixed(4),
      formula: '(buy - sell) / (buy + sell)',
      note: fragilityScore === 0 ? 'Zeroed because fragilityScore=0' : '',
    });

    // Periodic logging (every 10 calls)
    this.logCounter++;
    if (this.logCounter >= 10) {
      this.logCounter = 0;
      this.logger.info('[TradeFlow] Market state', {
        ...this.getMarketInfo(),
        state: metrics.state,
        fragilityScore: metrics.fragilityScore.toFixed(4),
        tradeImbalance: metrics.tradeImbalance.toFixed(4),
        bookImbalance: metrics.bookImbalance.toFixed(4),
        marketPressureScore: metrics.marketPressureScore.toFixed(4),
        buyVolume: metrics.buyVolume.toFixed(2),
        sellVolume: metrics.sellVolume.toFixed(2),
        totalTicks: metrics.totalTicks.toFixed(4),
      });
    } else {
      this.logger.debug('[TradeFlow] Fragility update', {
        ...this.getMarketInfo(),
        fragilityScore: metrics.fragilityScore.toFixed(4),
        ticks: this.fragility.ticks.toFixed(4),
        volume: this.fragility.volume.toFixed(2),
        timeToFillScore: this.fragility.getTimeToFillScore().toFixed(2),
        decayFactor: decayFactor.toFixed(6),
      });
    }

    return metrics;
  }

  /**
   * Сбрасывает состояние анализатора
   *
   * @remarks
   * Вызывать при смене маркета или reset сессии.
   *
   * @example
   * ```typescript
   * analyzer.reset();
   * ```
   */
  public reset(): void {
    this.fragility.reset();
    this.lastBook = null;
    this.buyAggressive = 0;
    this.sellAggressive = 0;
    this.lastTradeUpdate = Date.now();
    this.logCounter = 0;

    this.logger.info('[TradeFlow] State reset', {
      ...this.getMarketInfo(),
    });
  }

  /**
   * Применяет decay к trade volumes
   */
  private applyTradeDecay(now: number): void {
    const dt = now - this.lastTradeUpdate;
    if (dt <= 0) return;

    const factor = Math.exp(-this.config.decayLambda * dt);
    this.buyAggressive *= factor;
    this.sellAggressive *= factor;
    this.lastTradeUpdate = now;
  }

  /**
   * Рассчитывает book imbalance
   */
  private computeBookImbalance(): {
    bidDepth: number;
    askDepth: number;
    bookImbalance: number;
  } {
    if (!this.lastBook) {
      return { bidDepth: 0, askDepth: 0, bookImbalance: 0 };
    }

    const bidDepth = this.lastBook.bids
      .slice(0, this.config.bookLevels)
      .reduce((sum, level) => sum + level.size, 0);

    const askDepth = this.lastBook.asks
      .slice(0, this.config.bookLevels)
      .reduce((sum, level) => sum + level.size, 0);

    const total = bidDepth + askDepth;
    const bookImbalance = total > 0 ? (bidDepth - askDepth) / total : 0;

    return { bidDepth, askDepth, bookImbalance };
  }

  /**
   * Рассчитывает trade imbalance
   */
  private computeTradeImbalance(fragilityScore: number): number {
    const total = this.buyAggressive + this.sellAggressive;

    // Если нет активности или fragility = 0, imbalance = 0
    if (total === 0 || fragilityScore === 0) {
      return 0;
    }

    return (this.buyAggressive - this.sellAggressive) / total;
  }
}
