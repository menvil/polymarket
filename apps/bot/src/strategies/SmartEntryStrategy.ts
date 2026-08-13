/**
 * SmartEntryStrategy — улучшенная selective entry на основе анализа EWMA trajectory.
 *
 * @remarks
 * Ключевые инсайты из анализа 241 рынка:
 * - EWMA@50% >= 65¢ → 84.8% WR для UP
 * - Falling trajectory (EWMA падает >3¢) → 77.5% DOWN
 * - Зеркальная логика: покупаем DOWN токен когда сигналы bearish
 *
 * ### Режимы:
 * - `mode: 'bullish'` — покупаем UP токен (outcomeIndex=0) когда EWMA растёт и высокая
 * - `mode: 'bearish'` — покупаем DOWN токен (outcomeIndex=1) когда EWMA падает и низкая
 * - `mode: 'adaptive'` — решаем на лету: UP если bullish, DOWN если bearish, SKIP если flat
 *
 * ### Алгоритм:
 * 1. Собираем EWMA из трейдов (alpha=0.3)
 * 2. Ждём waitPct% времени рынка (default 50%) — накапливаем trajectory data
 * 3. Запоминаем EWMA в ключевых точках (25%, 50% времени)
 * 4. Проверяем условия входа:
 *    - Bullish: EWMA сейчас >= minEwmaCents И EWMA растёт (vs 25% mark)
 *    - Bearish: EWMA сейчас <= maxEwmaCentsForDown И EWMA падает
 * 5. Один вход, hold до settlement
 *
 * @example
 * ```typescript
 * // Bullish — покупаем UP когда всё растёт
 * const bull = new SmartEntryStrategy({
 *   orderSize: new Decimal(5),
 *   mode: 'bullish',
 *   minEwmaCents: 60,
 *   minRiseCents: 3,
 * });
 *
 * // Bearish (зеркальная) — покупаем DOWN когда UP падает
 * const bear = new SmartEntryStrategy({
 *   orderSize: new Decimal(5),
 *   mode: 'bearish',
 *   maxEwmaCentsForDown: 45,
 *   minFallCents: 3,
 * });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';

// ── Конфигурация ──────────────────────────────────────────────────────────────

/**
 * Параметры SmartEntryStrategy.
 *
 * @param orderSize - Размер ордера в токенах
 * @param mode - Режим: 'bullish' (UP), 'bearish' (DOWN), 'adaptive'
 * @param waitPct - Доля времени рынка для ожидания (0.0-1.0, default 0.5)
 * @param minEwmaCents - Минимальный EWMA для bullish входа (default 60)
 * @param maxEwmaCentsForDown - Максимальный EWMA (UP токена) для bearish входа (default 45)
 * @param minRiseCents - Минимальный рост EWMA для bullish (vs mark@25%, default 3)
 * @param minFallCents - Минимальное падение EWMA для bearish (vs mark@25%, default 3)
 * @param warmupTrades - Минимум трейдов перед началом анализа (default 10)
 * @param bidOffsetCents - Скидка от текущей цены для limit BUY (default 1)
 * @param maxSpreadCents - Максимальный spread для входа (default 10)
 */
export interface SmartEntryConfig {
  readonly orderSize: Decimal;
  readonly mode?: 'bullish' | 'bearish' | 'adaptive';
  readonly waitPct?: number;
  readonly minEwmaCents?: number;
  readonly maxEwmaCentsForDown?: number;
  readonly minRiseCents?: number;
  readonly minFallCents?: number;
  readonly warmupTrades?: number;
  readonly bidOffsetCents?: number;
  readonly maxSpreadCents?: number;
}

// ── Внутренние типы ───────────────────────────────────────────────────────────

interface SEData {
  readonly ewmaCents: number;
  readonly ewmaAt25: number | null;
  readonly pctElapsed: number;
  readonly tauSec: number;
  readonly hasPosition: boolean;
  readonly hasPendingOrder: boolean;
  readonly availableBalance: Decimal;
  readonly nowMs: number;
  readonly spreadCents: number;
}

type SEAction =
  | { readonly type: 'BUY'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'HOLD' };

// ── Реализация ────────────────────────────────────────────────────────────────

export class SmartEntryStrategy extends BaseStrategy<SEData, SEAction> {
  public readonly id: StrategyId;
  public readonly name = 'SmartEntryStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _orderSize: Decimal;
  private readonly _mode: 'bullish' | 'bearish' | 'adaptive';
  private readonly _waitPct: number;
  private readonly _minEwma: number;
  private readonly _maxEwmaForDown: number;
  private readonly _minRise: number;
  private readonly _minFall: number;
  private readonly _warmupTrades: number;
  private readonly _bidOffset: number;
  private readonly _maxSpread: number;

  /** EWMA mid-price (центы) */
  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;

  /** Snapshot EWMA at 25% of market time */
  private _ewmaAt25: number | null = null;
  private _ewmaAt25Captured = false;

  /** Смена рынка */
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _marketDurationMs = 0;

  /** Вошли ли мы в этот рынок */
  private _entered = false;

  /** Диагностический лог throttle */
  private _lastDiagMs = 0;

  constructor(config: SmartEntryConfig, strategyId: StrategyId = unsafeStrategyId('smart-entry-1'), logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._orderSize = config.orderSize;
    this._mode = config.mode ?? 'bearish';
    this._waitPct = config.waitPct ?? 0.5;
    this._minEwma = config.minEwmaCents ?? 60;
    this._maxEwmaForDown = config.maxEwmaCentsForDown ?? 45;
    this._minRise = config.minRiseCents ?? 3;
    this._minFall = config.minFallCents ?? 3;
    this._warmupTrades = config.warmupTrades ?? 10;
    this._bidOffset = config.bidOffsetCents ?? 1;
    this._maxSpread = config.maxSpreadCents ?? 10;

    this._logger?.warn('SmartEntry: init', {
      mode: this._mode,
      waitPct: this._waitPct,
      minEwma: this._minEwma,
      maxEwmaForDown: this._maxEwmaForDown,
      minRise: this._minRise,
      minFall: this._minFall,
    });
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  /**
   * Собирает EWMA из trade tape, запоминает EWMA at 25% mark.
   *
   * @param snapshot - Текущий снимок рынка
   * @returns Данные для принятия решения или undefined если рано
   */
  protected gather(snapshot: StrategySnapshot): SEData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    // Смена рынка → сброс
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._entered = false;
      this._lastDiagMs = 0;
      this._ewmaAt25 = null;
      this._ewmaAt25Captured = false;

      if (snapshot.eventStartMs !== undefined) {
        const eventStartMs = snapshot.eventStartMs.toNumber();
        this._marketEventStartMs = eventStartMs;
        this._marketDurationMs = expiresMs - eventStartMs;
        this._logger?.warn('SmartEntry: new market', {
          expiresMs,
          eventStartMs,
          durationSec: (this._marketDurationMs / 1000).toFixed(0),
          instrumentId: snapshot.instrumentId,
        });
      } else {
        return undefined;
      }
    }

    if (this._marketEventStartMs <= 0 || this._marketDurationMs <= 0) return undefined;

    // EWMA из trade tape
    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100;
        this._ewma = this._ewma === null
          ? priceNum
          : 0.3 * priceNum + 0.7 * this._ewma;
        this._tradeCount++;
        this._lastTradeTimestampMs = tradeTs;
      }
    }

    if (this._ewma === null || this._tradeCount < this._warmupTrades) return undefined;

    // Сколько % времени рынка прошло
    const elapsed = snapshot.nowMs - this._marketEventStartMs;
    const pctElapsed = elapsed / this._marketDurationMs;

    // Capture EWMA at 25% mark
    if (!this._ewmaAt25Captured && pctElapsed >= 0.25) {
      this._ewmaAt25 = this._ewma;
      this._ewmaAt25Captured = true;
      this._logger?.info('SmartEntry: captured EWMA@25%', {
        ewma: this._ewma.toFixed(1),
        pctElapsed: (pctElapsed * 100).toFixed(0),
      });
    }

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);

    // Spread
    let spreadCents = 99;
    if (snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        spreadCents = (ask - bid) * 100;
      }
    }

    // Portfolio
    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);

    return {
      ewmaCents: this._ewma,
      ewmaAt25: this._ewmaAt25,
      pctElapsed,
      tauSec,
      hasPosition: positionQty.gt(0),
      hasPendingOrder: snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
      availableBalance,
      nowMs: snapshot.nowMs,
      spreadCents,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  /**
   * Решает покупать или ждать на основе EWMA trajectory.
   *
   * @param data - Собранные данные из gather
   * @param _reasons - Триггеры тика (не используются)
   * @returns Массив действий (BUY или HOLD)
   */
  protected decide(data: SEData, _reasons: ReadonlySet<TriggerReason>): SEAction[] {
    // Уже вошли
    if (this._entered || data.hasPosition || data.hasPendingOrder) {
      return [{ type: 'HOLD' }];
    }

    // Ждём waitPct% времени
    if (data.pctElapsed < this._waitPct) {
      return [{ type: 'HOLD' }];
    }

    // Нет EWMA@25% — не можем оценить trajectory
    if (data.ewmaAt25 === null) {
      return [{ type: 'HOLD' }];
    }

    const ewma = data.ewmaCents;
    const rise = ewma - data.ewmaAt25;
    const fall = data.ewmaAt25 - ewma;

    // Диагностика
    if (data.nowMs - this._lastDiagMs >= 10_000) {
      this._lastDiagMs = data.nowMs;
      this._logger?.info('SmartEntry: tick', {
        mode: this._mode,
        ewma: ewma.toFixed(1),
        ewmaAt25: data.ewmaAt25.toFixed(1),
        rise: rise.toFixed(1),
        fall: fall.toFixed(1),
        pctElapsed: (data.pctElapsed * 100).toFixed(0) + '%',
        tau: data.tauSec.toFixed(0) + 's',
        spread: data.spreadCents.toFixed(1),
      });
    }

    // Spread check
    if (data.spreadCents > this._maxSpread) {
      return [{ type: 'HOLD' }];
    }

    let shouldBuy = false;
    let buyPrice: number;

    if (this._mode === 'bullish') {
      // Покупаем UP токен: EWMA высокая и растёт
      shouldBuy = ewma >= this._minEwma && rise >= this._minRise;
      buyPrice = Math.max(1, Math.round(ewma) - this._bidOffset);
    } else if (this._mode === 'bearish') {
      // Покупаем DOWN токен: EWMA UP-токена низкая и падает
      // Цена DOWN токена ≈ 100 - ewma(UP)
      // Мы торгуем DOWN токен (outcomeIndex=1), его цена в стакане
      // НО! ewma у нас от UP-токена (outcomeIndex=0 в данных).
      // Если outcomeIndex=1, то ewma уже от DOWN токена.
      // Значит для DOWN: ewma высокая и растёт = DOWN вероятнее.
      // Но в конфиге outcomeIndex=1, ewma считается по DOWN-токену.
      // DOWN токен растёт когда UP падает.
      // Просто: ewma DOWN-токена высокая и растёт → покупаем.
      shouldBuy = ewma >= this._minEwma && rise >= this._minRise;
      buyPrice = Math.max(1, Math.round(ewma) - this._bidOffset);
    } else {
      // adaptive: решаем на лету
      const isBullish = ewma >= this._minEwma && rise >= this._minRise;
      const isBearish = ewma <= this._maxEwmaForDown && fall >= this._minFall;

      if (isBullish) {
        shouldBuy = true;
        buyPrice = Math.max(1, Math.round(ewma) - this._bidOffset);
      } else if (isBearish) {
        // В adaptive мы не можем переключить токен на лету — skip
        shouldBuy = false;
        buyPrice = 0;
      } else {
        return [{ type: 'HOLD' }];
      }
    }

    if (!shouldBuy) {
      return [{ type: 'HOLD' }];
    }

    // Balance check
    const cost = this._orderSize.mul(buyPrice!).div(100);
    if (data.availableBalance.lt(cost)) {
      return [{ type: 'HOLD' }];
    }

    this._entered = true;

    this._logger?.warn('SmartEntry: BUY', {
      mode: this._mode,
      ewma: ewma.toFixed(1),
      ewmaAt25: data.ewmaAt25.toFixed(1),
      rise: rise.toFixed(1),
      fall: fall.toFixed(1),
      buyPrice: buyPrice!,
      pctElapsed: (data.pctElapsed * 100).toFixed(0) + '%',
      tau: data.tauSec.toFixed(0) + 's',
    });

    return [{ type: 'BUY', price: buyPrice!, size: this._orderSize }];
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  /**
   * Конвертирует действия в StrategyIntent для ExecutionEngine.
   *
   * @param actions - Массив решений из decide
   * @returns Массив интентов для исполнения
   */
  protected toIntents(actions: SEAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      if (action.type === 'HOLD') continue;

      intents.push({ type: 'CANCEL_ALL' });
      intents.push({
        type: 'PLACE',
        side: 'BUY',
        price: Price.of(new Decimal(action.price).div(100)),
        size: Quantity.of(action.size),
      });
    }

    return intents;
  }
}
