/**
 * Стратегия торговли на отбой (rejection) от стенок в стакане CEX-биржи.
 *
 * @remarks
 * ### Логика:
 * 1. Читает историю стакана CEX (`cryptoVenueHistory`) за последние `lookbackMs` мс.
 * 2. Детектирует «стенки» (уровни с аномальным объёмом) через WallDetector.
 * 3. Отслеживает поглощение стенок трейдами через ConsumptionTracker.
 * 4. Классифицирует сигнал через WallSignalComputer.
 * 5. На основе сигнала и GBM fair-value принимает решение BUY/SELL/HOLD.
 *
 * ### Торговые правила:
 * - **BUY (UP)**: сигнал REJECTION_DOWN (BID-стенка держится → цена вверх).
 * - **BUY (DOWN)**: сигнал REJECTION_UP (ASK-стенка держится → цена вниз).
 * - **SELL** (стоп-лосс): позиция открыта + midCents < entryPrice - stopLossCents.
 * - **SELL** (тайм-аут): позиция удерживается дольше holdMaxMs.
 * - **SELL** (разворот): появился противоположный сигнал (BREAKOUT или REJECTION в другую сторону).
 * - **HOLD**: кулдаун после выхода, нет сигнала или недостаточный edge.
 *
 * @example
 * ```typescript
 * const strategy = new OrderBookWallStrategy('obw-up-1', config, logger);
 * ```
 */

import { BaseStrategy } from '@polymarket/strategy';
import type { StrategyIntent, StrategySnapshot, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { StrategyId } from '@polymarket/ids';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';
import type { CexTradeTick, CexVenue } from '@polymarket/strategy';

import type { OBWAction, OBWData, OrderBookWallConfig, WallSignal } from './types.js';
import { WallDetector } from './WallDetector.js';
import { ConsumptionTracker } from './ConsumptionTracker.js';
import { WallSignalComputer } from './WallSignalComputer.js';

// ── Вспомогательные функции GBM ───────────────────────────────────────────────

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

function clampNumber(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.319381530 +
      t * (-0.356563782 +
        t * (1.781477937 +
          t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;
  return z >= 0 ? cdf : 1 - cdf;
}

/**
 * Вероятность UP-исхода по GBM (binary digital call).
 *
 * @param price - Текущая цена базового актива
 * @param strike - Strike цена рынка
 * @param sigmaAnnual - Годовая волатильность
 * @param tauSec - Секунды до экспирации
 * @returns Вероятность [0.01, 0.99]
 */
function binaryUpProbability(
  price: number,
  strike: number,
  sigmaAnnual: number,
  tauSec: number,
): number {
  if (tauSec <= 0) return price >= strike ? 0.99 : 0.01;
  if (price <= 0 || strike <= 0 || sigmaAnnual <= 0) return 0.5;

  const tauYears = tauSec / SECONDS_PER_YEAR;
  const denom = sigmaAnnual * Math.sqrt(tauYears);
  if (denom <= 0) return price >= strike ? 0.99 : 0.01;

  const z =
    (Math.log(price / strike) - 0.5 * sigmaAnnual * sigmaAnnual * tauYears) /
    denom;

  return clampNumber(normalCdf(z), 0.01, 0.99);
}

// ── Стратегия ─────────────────────────────────────────────────────────────────

/**
 * Стратегия анализа стенок в стакане CEX для торговли на Polymarket.
 */
export class OrderBookWallStrategy extends BaseStrategy<OBWData, OBWAction> {
  public readonly id: StrategyId;
  public readonly name = 'OrderBookWallStrategy';

  // ── Параметры (resolved с defaults) ──────────────────────────────────────
  private readonly _side: 'up' | 'down';
  private readonly _orderSize: number;
  private readonly _venue: CexVenue;
  private readonly _lookbackMs: number;
  private readonly _minSignalStrength: number;
  private readonly _minEdgeCents: number;
  private readonly _holdMaxMs: number;
  private readonly _stopLossCents: number;
  private readonly _sigmaAnnual: number;
  private readonly _minWallAgeMs: number;
  private readonly _windowMs: number;
  private readonly _recentWindowMs: number;
  private readonly _rejectionMaxAbsorption: number;
  private readonly _minWallTestVolume: number;
  private readonly _flowDecelerationFactor: number;
  /** Кулдаун после выхода из позиции — защита от немедленного реентри. */
  private readonly _exitCooldownMs: number = 20_000;

  // ── Stateful компоненты ───────────────────────────────────────────────────
  private readonly _consumptionTracker: ConsumptionTracker;
  private readonly _detectorParams: { bandSizePct: number; wallThresholdFactor: number; minWallSize: number };

  // ── Состояние позиции ─────────────────────────────────────────────────────
  private _entryPriceCents: number | null = null;
  private _entryMs: number | null = null;
  private _currentExpirationMs: number | null = null;
  private _lastExitMs: number | null = null;

  // ── Состояние EWMA для Polymarket mid ────────────────────────────────────
  private _ewma: number | null = null;
  private static readonly EWMA_ALPHA = 0.1;

  // ── Логгер и диагностика ──────────────────────────────────────────────────
  private readonly _logger: ILogger | undefined;
  private _lastDiagMs = 0;
  private _lastSignal: WallSignal = { type: 'NEUTRAL', strength: 0 };

  /**
   * Создаёт стратегию OrderBookWall.
   *
   * @param id - Уникальный идентификатор экземпляра стратегии
   * @param config - Конфигурация стратегии
   * @param logger - Опциональный логгер
   *
   * @example
   * ```typescript
   * const strategy = new OrderBookWallStrategy(
   *   'obw-btc-up',
   *   { side: 'up', orderSize: 10, venue: 'coinbase' },
   *   logger,
   * );
   * ```
   */
  public constructor(id: StrategyId, config: OrderBookWallConfig, logger?: ILogger) {
    super();
    this.id = id;
    this._side = config.side;
    this._orderSize = config.orderSize;
    this._venue = config.venue;
    this._lookbackMs = config.lookbackMs ?? 60_000;
    this._minSignalStrength = config.minSignalStrength ?? 0.4;
    this._minEdgeCents = config.minEdgeCents ?? 0;
    this._holdMaxMs = config.holdMaxMs ?? 240_000;
    this._stopLossCents = config.stopLossCents ?? 5;
    this._sigmaAnnual = config.sigmaAnnual ?? 0.6;
    this._minWallAgeMs = config.minWallAgeMs ?? 3_000;
    this._windowMs = config.consumptionWindowMs ?? 30_000;
    this._recentWindowMs = config.recentWindowMs ?? 8_000;
    this._rejectionMaxAbsorption = config.rejectionMaxAbsorption ?? 0.2;
    this._minWallTestVolume = config.minWallTestVolume ?? 0.05;
    this._flowDecelerationFactor = config.flowDecelerationFactor ?? 0.4;
    this._logger = logger;

    this._detectorParams = {
      bandSizePct: config.bandSizePct ?? 0.00005,
      wallThresholdFactor: config.wallThresholdFactor ?? 2.0,
      minWallSize: config.minWallSize ?? 0.3,
    };

    this._consumptionTracker = new ConsumptionTracker({
      windowMs: this._windowMs,
      recentWindowMs: this._recentWindowMs,
      ttlMs: this._windowMs * 2,
    });
  }

  // ── gather() ──────────────────────────────────────────────────────────────

  /**
   * Извлекает типизированные данные из StrategySnapshot.
   *
   * @param snapshot - Generic snapshot от scheduler
   * @returns OBWData или undefined если данных недостаточно
   *
   * @remarks
   * Требует: cryptoPrice, cryptoVenueHistory, eventStartMs, portfolio, topOfBook.
   * Сбрасывает состояние при смене экспирации (новый рынок).
   */
  protected gather(snapshot: StrategySnapshot): OBWData | undefined {
    const { cryptoPrice, cryptoVenueHistory, eventStartMs, portfolio, nowMs } = snapshot;
    if (!cryptoPrice || !cryptoVenueHistory || eventStartMs === undefined || !portfolio) return undefined;

    const chainlink = cryptoPrice.chainlink;
    if (!chainlink || !Number.isFinite(chainlink.price) || chainlink.price <= 0) return undefined;

    const targetPrice = cryptoPrice.targetPrice;
    if (!targetPrice || targetPrice <= 0) return undefined;

    const expiresMs = snapshot.market.expirationMs;
    const tauSec = Math.max(0, (expiresMs - nowMs) / 1_000);

    // Сбрасываем при смене рынка
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._entryPriceCents = null;
      this._entryMs = null;
      this._lastExitMs = null;
      this._ewma = null;
      this._consumptionTracker.reset();
    }

    // Обновляем EWMA Polymarket mid
    this._updateEwma(snapshot);

    // Читаем свежий стакан CEX (окно привязано к nowMs — анти look-ahead)
    const recentBooks = cryptoVenueHistory.getRecentBooks(this._venue, this._lookbackMs, nowMs);
    if (recentBooks.length === 0) return undefined;
    const latestBook = recentBooks[recentBooks.length - 1]!;

    // Читаем свежие трейды CEX
    const recentTrades = cryptoVenueHistory.getRecentTrades(this._venue, this._lookbackMs, nowMs);

    // Детектируем стенки
    const walls = WallDetector.detect(
      latestBook.bids as readonly [number, number][],
      latestBook.asks as readonly [number, number][],
      nowMs,
      this._detectorParams,
    );

    // Обновляем трекер поглощения
    this._consumptionTracker.updateFromBook(walls, nowMs);

    // Новые трейды → передаём в трекер (только свежие с последнего тика)
    const freshTrades = this._extractFreshTrades(recentTrades, nowMs);
    this._consumptionTracker.recordTrades(freshTrades, walls, nowMs);

    // Вычисляем метрики и сигнал
    const metrics = this._consumptionTracker.computeMetrics(walls, nowMs);
    const wallSignal = WallSignalComputer.compute(metrics, {
      minWallAgeMs: this._minWallAgeMs,
      rejectionMaxAbsorption: this._rejectionMaxAbsorption,
      minWallTestVolume: this._minWallTestVolume,
      flowDecelerationFactor: this._flowDecelerationFactor,
      windowMs: this._windowMs,
      recentWindowMs: this._recentWindowMs,
    });
    this._lastSignal = wallSignal;

    // Fair value из GBM
    const upProb = binaryUpProbability(chainlink.price, targetPrice, this._sigmaAnnual, tauSec);
    const fairCents = this._side === 'up' ? upProb * 100 : (1 - upProb) * 100;

    // Позиция
    const position = portfolio.getPosition(snapshot.instrumentId);
    const positionQty = position ? position.quantity.value().toNumber() : 0;
    const availableTokenQty = portfolio.availableTokenQuantity(snapshot.instrumentId).toNumber();
    const availableUsdc = portfolio.balance.available().value().toNumber();

    // Открытые ордера
    const openBuyOrder = snapshot.openOrders.find(
      (o) => o.side === 'BUY' && !o.isTerminal,
    );
    const openBuyPriceCents = openBuyOrder
      ? openBuyOrder.price.value().toNumber() * 100
      : undefined;
    const hasOpenSell = snapshot.openOrders.some((o) => o.side === 'SELL' && !o.isTerminal);

    return {
      nowMs,
      currentPrice: chainlink.price,
      targetPrice,
      tauSec,
      wallSignal,
      fairCents,
      ewmaMidCents: this._ewma ?? undefined,
      openBuyPriceCents,
      positionQty,
      availableTokenQty,
      availableUsdc,
      hasInFlightFills: snapshot.hasInFlightFills,
      hasOpenSell,
    };
  }

  // ── decide() ──────────────────────────────────────────────────────────────

  /**
   * Чистая торговая логика на основе данных snapshot.
   *
   * @param data - Типизированные данные из gather()
   * @param _reasons - Что изменилось (не используется)
   * @returns Массив действий стратегии
   *
   * @remarks
   * ### Приоритеты решений (сверху вниз):
   * 1. Стоп-лосс: позиция открыта, цена упала ниже entry - stopLoss.
   * 2. Тайм-аут: позиция удерживается дольше holdMaxMs.
   * 3. Разворотный сигнал: BREAKOUT или REJECTION в противоположную сторону.
   * 4. BUY: нет позиции, кулдаун прошёл, REJECTION_DOWN/UP, edge >= minEdgeCents.
   * 5. HOLD: иначе.
   */
  protected decide(data: OBWData, _reasons: ReadonlySet<TriggerReason>): OBWAction[] {
    const { nowMs, wallSignal, fairCents, positionQty, availableTokenQty, availableUsdc,
      openBuyPriceCents, hasInFlightFills, hasOpenSell } = data;

    const midCents = data.ewmaMidCents ?? fairCents;

    // ── 1. Стоп-лосс ──────────────────────────────────────────────────────
    if (this._entryPriceCents !== null && positionQty > 0 && !hasOpenSell) {
      const loss = this._entryPriceCents - midCents;
      if (loss >= this._stopLossCents) {
        this._log('stop-loss triggered', { entryPriceCents: this._entryPriceCents, midCents, loss });
        return this._exitPosition(nowMs, midCents, availableTokenQty > 0 ? availableTokenQty : positionQty, 'stop-loss');
      }
    }

    // ── 2. Тайм-аут ───────────────────────────────────────────────────────
    if (this._entryMs !== null && positionQty > 0 && !hasOpenSell &&
        nowMs - this._entryMs >= this._holdMaxMs) {
      this._log('hold timeout', { holdMs: nowMs - this._entryMs, holdMaxMs: this._holdMaxMs });
      return this._exitPosition(nowMs, midCents, availableTokenQty > 0 ? availableTokenQty : positionQty, 'timeout');
    }

    // ── 3. Разворотный сигнал при открытой позиции ────────────────────────
    if (positionQty > 0 && !hasOpenSell && this._isReverseSignal(wallSignal)) {
      this._log('reverse signal exit', { signal: wallSignal.type, strength: wallSignal.strength });
      return this._exitPosition(nowMs, midCents, availableTokenQty > 0 ? availableTokenQty : positionQty, 'reverse-signal');
    }

    // ── 4. BUY ────────────────────────────────────────────────────────────
    const inCooldown = this._lastExitMs !== null && nowMs - this._lastExitMs < this._exitCooldownMs;
    const edge = fairCents - midCents;

    const canBuy =
      positionQty === 0 &&
      !openBuyPriceCents &&
      !hasInFlightFills &&
      !inCooldown &&
      this._isEntrySignal(wallSignal) &&
      wallSignal.strength >= this._minSignalStrength &&
      edge >= this._minEdgeCents &&
      availableUsdc >= this._orderSize;

    if (canBuy) {
      const orderPriceCents = clampNumber(fairCents, 1, 99);
      this._entryPriceCents = orderPriceCents;
      this._entryMs = nowMs;
      this._log('entry BUY', {
        signal: wallSignal.type,
        strength: wallSignal.strength.toFixed(3),
        fairCents: fairCents.toFixed(2),
        midCents: midCents.toFixed(2),
        edge: edge.toFixed(2),
        orderPriceCents: orderPriceCents.toFixed(2),
        size: this._orderSize,
      });
      return [{ type: 'BUY', priceCents: orderPriceCents, sizeTokens: this._orderSize }];
    }

    // ── 5. Диагностика ───────────────────────────────────────────────────
    this._maybeDiag(data, { inCooldown, edge });

    return [{ type: 'HOLD' }];
  }

  // ── toIntents() ───────────────────────────────────────────────────────────

  /**
   * Конвертирует domain-действия в StrategyIntent[].
   *
   * @param actions - Действия из decide()
   * @returns Массив StrategyIntent для ExecutionEngine
   */
  protected toIntents(actions: OBWAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      switch (action.type) {
        case 'BUY': {
          const priceDecimal = new Decimal(action.priceCents / 100).toDecimalPlaces(4);
          const sizeDecimal = new Decimal(action.sizeTokens);
          intents.push({
            type: 'PLACE',
            side: 'BUY',
            price: Price.of(priceDecimal),
            size: Quantity.of(sizeDecimal),
          });
          break;
        }
        case 'SELL': {
          const priceDecimal = new Decimal(action.priceCents / 100).toDecimalPlaces(4);
          const sizeDecimal = new Decimal(action.sizeTokens);
          intents.push({
            type: 'PLACE',
            side: 'SELL',
            price: Price.of(priceDecimal),
            size: Quantity.of(sizeDecimal),
          });
          break;
        }
        case 'CANCEL_ALL':
          intents.push({ type: 'CANCEL_ALL' });
          break;
        case 'HOLD':
          break;
      }
    }

    return intents;
  }

  // ── getMetrics() ──────────────────────────────────────────────────────────

  /**
   * Возвращает метрики стратегии для мониторинга.
   *
   * @returns Объект с метриками
   */
  public override getMetrics(): Record<string, unknown> {
    return {
      side: this._side,
      venue: this._venue,
      lastSignalType: this._lastSignal.type,
      lastSignalStrength: this._lastSignal.strength.toFixed(3),
      entryPriceCents: this._entryPriceCents,
      entryMs: this._entryMs,
      ewmaMidCents: this._ewma?.toFixed(2),
      trackedWalls: this._consumptionTracker.trackedCount,
    };
  }

  // ── Вспомогательные методы ────────────────────────────────────────────────

  /**
   * Генерирует действия для выхода из позиции и сбрасывает состояние.
   *
   * @param nowMs - Текущее время
   * @param midCents - Текущий mid в центах (для расчёта цены SELL)
   * @param positionQty - Размер позиции для продажи
   * @param reason - Причина выхода (для логов)
   * @returns [CANCEL_ALL, SELL]
   */
  private _exitPosition(
    nowMs: number,
    midCents: number,
    positionQty: number,
    reason: string,
  ): OBWAction[] {
    this._entryPriceCents = null;
    this._entryMs = null;
    this._lastExitMs = nowMs;
    const sellPriceCents = Math.max(0.01, midCents - 0.5);
    this._log(`exit [${reason}]`, { midCents, positionQty, sellPriceCents });
    return [
      { type: 'CANCEL_ALL' },
      { type: 'SELL', priceCents: sellPriceCents, sizeTokens: positionQty },
    ];
  }

  /**
   * Проверяет, является ли сигнал входным для текущей стороны.
   *
   * @param signal - Торговый сигнал
   * @returns true если сигнал соответствует стороне стратегии
   *
   * @remarks
   * UP-стратегия: входим на REJECTION_DOWN — BID-стенка держится, цена пойдёт вверх.
   * DOWN-стратегия: входим на REJECTION_UP — ASK-стенка держится, цена пойдёт вниз.
   */
  private _isEntrySignal(signal: WallSignal): boolean {
    if (this._side === 'up') {
      return signal.type === 'REJECTION_DOWN';
    }
    return signal.type === 'REJECTION_UP';
  }

  /**
   * Проверяет, является ли сигнал разворотным для текущей позиции.
   *
   * @param signal - Торговый сигнал
   * @returns true если нужно закрыть позицию по сигналу разворота
   *
   * @remarks
   * UP-позиция: выходим когда цена пойдёт вниз:
   *   - BREAKOUT_DOWN: BID-стенка пробита → цена падает
   *   - REJECTION_UP: ASK-стенка держится → цена отскакивает вниз
   * DOWN-позиция: симметрично.
   */
  private _isReverseSignal(signal: WallSignal): boolean {
    if (signal.strength < this._minSignalStrength) return false;
    if (this._side === 'up') {
      return signal.type === 'BREAKOUT_DOWN' || signal.type === 'REJECTION_UP';
    }
    return signal.type === 'BREAKOUT_UP' || signal.type === 'REJECTION_DOWN';
  }

  /**
   * Обновляет EWMA Polymarket mid по публичным трейдам.
   *
   * @param snapshot - StrategySnapshot
   *
   * @remarks
   * Используется как reference price для стоп-лосса.
   * α = 0.1 (медленный EWMA для фильтрации шума).
   */
  private _updateEwma(snapshot: StrategySnapshot): void {
    const tape = snapshot.tradeTape;
    if (!tape) return;
    const recent = tape.getRecent(5_000);
    if (recent.length === 0) return;

    for (const record of recent) {
      const priceCents = record.price.value().toNumber() * 100;
      this._ewma = this._ewma === null
        ? priceCents
        : this._ewma + OrderBookWallStrategy.EWMA_ALPHA * (priceCents - this._ewma);
    }
  }

  /**
   * Извлекает свежие трейды CEX за последние 2 секунды.
   *
   * @param trades - Все недавние трейды из getRecentTrades()
   * @param nowMs - Текущее время
   * @returns Трейды за последние 2 секунды в формате TradeRecord
   *
   * @remarks
   * 2 секунды выбраны как разумный интервал между тиками стратегии.
   * Гарантирует что каждый трейд будет записан ровно один раз.
   */
  private _extractFreshTrades(
    trades: readonly CexTradeTick[],
    nowMs: number,
  ): Array<{ price: number; size: number; timestampMs: number }> {
    const cutoff = nowMs - 2_000;
    return trades
      .filter((t) => t.exchangeTsMs >= cutoff)
      .map((t) => ({ price: t.price, size: t.size, timestampMs: t.exchangeTsMs }));
  }

  private _log(event: string, data?: Record<string, unknown>): void {
    this._logger?.info(`[OBWall:${this._side}] ${event}`, data ?? {});
  }

  private _maybeDiag(data: OBWData, extra: Record<string, unknown>): void {
    if (data.nowMs - this._lastDiagMs < 30_000) return;
    this._lastDiagMs = data.nowMs;
    this._logger?.info('[OBWall] status', {
      side: this._side,
      venue: this._venue,
      signal: data.wallSignal.type,
      strength: data.wallSignal.strength.toFixed(3),
      fairCents: data.fairCents.toFixed(2),
      ewmaMidCents: data.ewmaMidCents?.toFixed(2),
      positionQty: data.positionQty,
      trackedWalls: this._consumptionTracker.trackedCount,
      entryPriceCents: this._entryPriceCents?.toFixed(2),
      ...extra,
    });
  }
}
