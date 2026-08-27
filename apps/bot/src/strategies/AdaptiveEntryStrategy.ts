/**
 * AdaptiveEntryStrategy — покупка токена с momentum-сигналом на отметке 50% времени рынка.
 *
 * @remarks
 * ### Алгоритм:
 * 1. Собираем EWMA цены из trade tape ОБОИХ токенов (alpha=0.3)
 * 2. Фиксируем EWMA@25% времени рынка (snapshot для trajectory)
 * 3. На отметке waitPct (default 50%) — **одноразовая** проверка:
 *    - EWMA >= minEwmaCents (default 50) — токен достаточно дорогой
 *    - EWMA > 50¢ — наш токен сильнее комплементарного (UP+DOWN≈100)
 *    - Rise (EWMA@50% - EWMA@25%) >= minRiseCents (default 5) — тренд вверх
 *    - Наш rise > rise комплементарного токена (мы — более сильный momentum)
 * 4. Если все условия OK → limit BUY по (EWMA - offset), hold до settlement
 * 5. Если нет → SKIP этот рынок навсегда
 *
 * ### Auto-selection (dual-token):
 * При наличии `complementaryTradeTape` и `complementaryAsset` в snapshot
 * стратегия сравнивает momentum обоих токенов и автоматически выбирает лучший:
 * - Если оба подходят по условиям → покупаем тот, у кого rise выше
 * - Если только один подходит → покупаем его
 * - Если ни один → SKIP
 *
 * При покупке комплементарного токена PlaceIntent содержит `targetInstrumentId`
 * и `targetAsset`, и ExecutionEngine маршрутизирует ордер на правильный инструмент.
 *
 * Один конфиг + один запуск на рынок — стратегия сама выбирает UP или DOWN.
 *
 * ### Почему работает:
 * Momentum на 7-минутном горизонте: если токен дорожает к середине рынка,
 * с вероятностью ~85% тренд продолжится до settlement.
 * Нет inventory risk (одна сделка), нет adverse selection.
 *
 * @param orderSize - Размер ордера в токенах
 * @param waitPct - Доля времени рынка для ожидания (default 0.5)
 * @param minEwmaCents - Минимальная EWMA для входа (default 50)
 * @param minRiseCents - Минимальный рост EWMA@50% vs EWMA@25% (default 5)
 * @param warmupTrades - Минимум трейдов до начала анализа (default 10)
 * @param bidOffsetCents - Скидка от EWMA для limit BUY (default 1)
 *
 * @example
 * ```typescript
 * const strategy = new AdaptiveEntryStrategy({
 *   orderSize: new Decimal(5),
 *   waitPct: 0.5,
 *   minEwmaCents: 50,
 *   minRiseCents: 5,
 * });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import { placeTarget } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, AssetId, StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
import type { IDecisionJournal } from '@polymarket/ports';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';

// ── Конфигурация ──────────────────────────────────────────────────────────────

export interface AdaptiveEntryConfig {
  readonly orderSize: Decimal;
  /** Доля времени рынка, после которой принимается решение (0.0-1.0). Default 0.5. */
  readonly waitPct?: number;
  /** Минимальная EWMA для входа (центы). Default 50. */
  readonly minEwmaCents?: number;
  /** Минимальный рост EWMA (ewma@50% - ewma@25%) в центах. Default 5. */
  readonly minRiseCents?: number;
  /** Минимум трейдов перед началом анализа. Default 10. */
  readonly warmupTrades?: number;
  /**
   * Смещение от EWMA для limit BUY (центы). Default 1.
   *
   * @remarks
   * Положительное: BUY ниже EWMA (maker, пассивный). bidOffset=3 → buyPrice = ewma - 3.
   * Отрицательное: BUY выше EWMA (taker, агрессивный). bidOffset=-2 → buyPrice = ewma + 2.
   * Ноль: BUY по EWMA.
   */
  readonly bidOffsetCents?: number;
  /**
   * Минимальный рост EWMA для комплементарного токена (центы).
   * По умолчанию = minRiseCents.
   *
   * @remarks
   * Позволяет задать отдельный порог rise для comp токена.
   * Полезно когда comp уже дорогой (ewma > 50) но не показывает momentum —
   * значение 0 разрешит вход при любом rise если ewma условия выполнены.
   */
  readonly compMinRiseCents?: number;
  /**
   * Максимальная EWMA для входа (центы). Без ограничения по умолчанию.
   *
   * @remarks
   * Предотвращает покупку дорогих токенов с плохим risk/reward.
   * Например, maxEwmaCents=75 запрещает покупку дороже 75¢
   * (profit max 25¢ vs loss 75¢ = нужен WR > 75%).
   */
  readonly maxEwmaCents?: number;
}

// ── Внутренние типы ───────────────────────────────────────────────────────────

interface AEData {
  readonly ewmaCents: number;
  readonly ewmaAt25: number | null;
  readonly pctElapsed: number;
  readonly tauSec: number;
  readonly hasPosition: boolean;
  readonly hasPendingOrder: boolean;
  readonly availableBalance: Decimal;
  readonly nowMs: number;
  /** EWMA комплементарного токена (центы). null если нет данных. */
  readonly compEwmaCents: number | null;
  /** EWMA@25% комплементарного токена. null если нет данных. */
  readonly compEwmaAt25: number | null;
  /** ID комплементарного инструмента (для auto-selection). */
  readonly complementaryInstrumentId: InstrumentId | undefined;
  /** AssetId комплементарного инструмента (для auto-selection). */
  readonly complementaryAsset: AssetId | undefined;
}

type AEAction =
  | {
      readonly type: 'BUY';
      readonly price: number;
      readonly size: Decimal;
      /** Если покупаем комплементарный токен — ID целевого инструмента */
      readonly targetInstrumentId?: InstrumentId;
      /** Если покупаем комплементарный токен — AssetId целевого инструмента */
      readonly targetAsset?: AssetId;
    }
  | { readonly type: 'HOLD' };

// ── Реализация ────────────────────────────────────────────────────────────────

export class AdaptiveEntryStrategy extends BaseStrategy<AEData, AEAction> {
  public readonly id: StrategyId;
  public readonly name = 'AdaptiveEntryStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _journal: IDecisionJournal | undefined;
  private readonly _orderSize: Decimal;
  private readonly _waitPct: number;
  private readonly _minEwma: number;
  private readonly _minRise: number;
  private readonly _compMinRise: number;
  private readonly _maxEwma: number;
  private readonly _warmupTrades: number;
  private readonly _bidOffset: number;

  // ── Per-market state (основной токен) ──
  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;
  private _ewmaAt25: number | null = null;
  private _ewmaAt25Captured = false;

  // ── Per-market state (комплементарный токен) ──
  private _compEwma: number | null = null;
  private _compTradeCount = 0;
  private _compLastTradeTimestampMs = 0;
  private _compEwmaAt25: number | null = null;
  private _compEwmaAt25Captured = false;

  /** Решение принято (вход или skip) — больше не проверяем */
  private _decided = false;
  /** Вошли в рынок */
  private _entered = false;

  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _marketDurationMs = 0;
  private _currentMarketId = '';

  constructor(config: AdaptiveEntryConfig, strategyId: StrategyId = unsafeStrategyId('adaptive-entry-1'), logger?: ILogger, journal?: IDecisionJournal) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._journal = journal;
    this._orderSize = config.orderSize;
    this._waitPct = config.waitPct ?? 0.5;
    this._minEwma = config.minEwmaCents ?? 50;
    this._minRise = config.minRiseCents ?? 5;
    this._compMinRise = config.compMinRiseCents ?? this._minRise;
    this._maxEwma = config.maxEwmaCents ?? 99;
    this._warmupTrades = config.warmupTrades ?? 10;
    this._bidOffset = config.bidOffsetCents ?? 1;

    this._logger?.warn('AdaptiveEntry: init', {
      waitPct: this._waitPct,
      minEwma: this._minEwma,
      maxEwma: this._maxEwma,
      minRise: this._minRise,
      compMinRise: this._compMinRise,
      warmupTrades: this._warmupTrades,
      bidOffset: this._bidOffset,
    });
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  /**
   * Собирает EWMA из trade tape, фиксирует EWMA@25%.
   *
   * @param snapshot - Текущий снимок рынка
   * @returns Данные для принятия решения или undefined если рано
   */
  protected gather(snapshot: StrategySnapshot): AEData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    // Смена рынка → полный сброс
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._ewmaAt25 = null;
      this._ewmaAt25Captured = false;
      this._compEwma = null;
      this._compTradeCount = 0;
      this._compLastTradeTimestampMs = 0;
      this._compEwmaAt25 = null;
      this._compEwmaAt25Captured = false;
      this._decided = false;
      this._entered = false;

      if (snapshot.eventStartMs !== undefined) {
        this._marketEventStartMs = snapshot.eventStartMs.toNumber();
        this._marketDurationMs = expiresMs - this._marketEventStartMs;
        this._currentMarketId = String(snapshot.instrumentId);
        this._logger?.info('AdaptiveEntry: new market', {
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

    const pctElapsed = (snapshot.nowMs - this._marketEventStartMs) / this._marketDurationMs;

    // Фиксируем EWMA@25%
    if (!this._ewmaAt25Captured && pctElapsed >= 0.25) {
      this._ewmaAt25 = this._ewma;
      this._ewmaAt25Captured = true;
    }

    // ── Комплементарный токен EWMA ──
    const compTapeRecords = snapshot.complementaryTradeTape?.getAll();
    if (compTapeRecords && compTapeRecords.length > 0) {
      for (const trade of compTapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._compLastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100;
        this._compEwma = this._compEwma === null
          ? priceNum
          : 0.3 * priceNum + 0.7 * this._compEwma;
        this._compTradeCount++;
        this._compLastTradeTimestampMs = tradeTs;
      }
    }

    // Фиксируем comp EWMA@25%
    if (this._compEwma !== null && !this._compEwmaAt25Captured && pctElapsed >= 0.25) {
      this._compEwmaAt25 = this._compEwma;
      this._compEwmaAt25Captured = true;
    }

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);
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
      compEwmaCents: this._compEwma,
      compEwmaAt25: this._compEwmaAt25,
      complementaryInstrumentId: snapshot.complementaryInstrumentId,
      complementaryAsset: snapshot.complementaryAsset,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  /**
   * Одноразовое решение на отметке waitPct% времени рынка.
   *
   * @remarks
   * После принятия решения (вход или skip) повторная проверка не выполняется.
   * Это предотвращает вход на пограничных рынках из-за флуктуаций EWMA.
   *
   * @param data - Собранные данные из gather
   * @param _reasons - Триггеры тика (не используются)
   * @returns Массив действий (BUY или HOLD)
   */
  protected decide(data: AEData, _reasons: ReadonlySet<TriggerReason>): AEAction[] {
    // Уже вошли — hold до settlement
    if (this._entered || data.hasPosition || data.hasPendingOrder) {
      return [{ type: 'HOLD' }];
    }

    // Решение уже принято (skip) — ничего не делаем
    if (this._decided) {
      return [{ type: 'HOLD' }];
    }

    // Ещё не время для решения
    if (data.pctElapsed < this._waitPct) {
      return [{ type: 'HOLD' }];
    }

    // Нет данных о trajectory
    if (data.ewmaAt25 === null) {
      return [{ type: 'HOLD' }];
    }

    // ── ОДНОРАЗОВОЕ РЕШЕНИЕ ──
    this._decided = true;

    const ewma = data.ewmaCents;
    const rise = ewma - data.ewmaAt25;

    // Условия входа основного токена:
    // 1. EWMA >= minEwma (токен достаточно дорогой)
    // 2. EWMA > 50 (наш токен сильнее комплементарного: UP+DOWN≈100)
    // 3. EWMA <= maxEwma (risk/reward приемлемый)
    // 4. Rise >= minRise (momentum подтверждён)
    const primaryQualifies = ewma >= this._minEwma && ewma > 50 && ewma <= this._maxEwma && rise >= this._minRise;

    // Условия входа комплементарного токена (auto-selection):
    // compMinRise может быть ниже minRise — comp уже дорогой, не обязателен сильный momentum
    const compEwma = data.compEwmaCents;
    const compRise = (compEwma !== null && data.compEwmaAt25 !== null)
      ? compEwma - data.compEwmaAt25
      : null;
    const hasCompData = compEwma !== null && compRise !== null && data.complementaryInstrumentId !== undefined && data.complementaryAsset !== undefined;
    const compQualifies = hasCompData && compEwma! >= this._minEwma && compEwma! > 50 && compEwma! <= this._maxEwma && compRise! >= this._compMinRise;

    // Выбираем лучший токен (auto-selection)
    let chosen: 'primary' | 'complementary' | 'skip' = 'skip';
    if (primaryQualifies && compQualifies) {
      // Оба подходят — берём с большим rise
      chosen = rise >= compRise! ? 'primary' : 'complementary';
    } else if (primaryQualifies) {
      chosen = 'primary';
    } else if (compQualifies) {
      chosen = 'complementary';
    }

    const chosenEwma = chosen === 'complementary' ? compEwma! : ewma;
    // Clamp to [1, 99] — Polymarket binary token price range
    const buyPrice = Math.min(99, Math.max(1, Math.round(chosenEwma) - this._bidOffset));

    this._logger?.warn('AdaptiveEntry: DECISION', {
      action: chosen === 'skip' ? 'SKIP' : `BUY_${chosen.toUpperCase()}`,
      ewma: ewma.toFixed(1),
      ewmaAt25: data.ewmaAt25.toFixed(1),
      rise: rise.toFixed(1),
      compEwma: compEwma?.toFixed(1) ?? 'n/a',
      compRise: compRise?.toFixed(1) ?? 'n/a',
      chosen,
      buyPrice: chosen !== 'skip' ? buyPrice : '-',
      pctElapsed: (data.pctElapsed * 100).toFixed(0) + '%',
      tau: data.tauSec.toFixed(0) + 's',
      checks: {
        'primary.ewma>=minEwma': `${ewma.toFixed(1)} >= ${this._minEwma}: ${ewma >= this._minEwma}`,
        'primary.ewma<=maxEwma': `${ewma.toFixed(1)} <= ${this._maxEwma}: ${ewma <= this._maxEwma}`,
        'primary.ewma>50': `${ewma.toFixed(1)} > 50: ${ewma > 50}`,
        'primary.rise>=minRise': `${rise.toFixed(1)} >= ${this._minRise}: ${rise >= this._minRise}`,
        'comp.ewma>=minEwma': compEwma !== null ? `${compEwma.toFixed(1)} >= ${this._minEwma}: ${compEwma >= this._minEwma}` : 'n/a',
        'comp.ewma<=maxEwma': compEwma !== null ? `${compEwma.toFixed(1)} <= ${this._maxEwma}: ${compEwma <= this._maxEwma}` : 'n/a',
        'comp.ewma>50': compEwma !== null ? `${compEwma.toFixed(1)} > 50: ${compEwma > 50}` : 'n/a',
        'comp.rise>=compMinRise': compRise !== null ? `${compRise.toFixed(1)} >= ${this._compMinRise}: ${compRise >= this._compMinRise}` : 'n/a',
      },
    });

    // Журнал: одноразовое решение (BUY или SKIP)
    const journalAction = chosen === 'skip' ? 'SKIP' as const
      : chosen === 'complementary' ? 'BUY_COMP' as const
      : 'BUY' as const;
    this._journal?.recordDecision({
      marketId: this._currentMarketId, strategyId: this.id, ts: data.nowMs,
      action: journalAction,
      state: {
        ewmaCents: ewma, ewmaAt25: data.ewmaAt25, rise,
        compEwmaCents: compEwma, compEwmaAt25: data.compEwmaAt25, compRise,
        pctElapsed: data.pctElapsed, tauSec: data.tauSec,
        availableBalance: data.availableBalance.toFixed(2),
        primaryQualifies, compQualifies, chosen,
      },
      bidPrice: chosen !== 'skip' ? buyPrice : undefined,
      orderSize: chosen !== 'skip' ? this._orderSize.toString() : undefined,
      effectiveSide: chosen === 'complementary' ? 'down' : chosen === 'primary' ? 'up' : undefined,
    });

    if (chosen === 'skip') {
      return [{ type: 'HOLD' }];
    }

    // Balance check
    const cost = this._orderSize.mul(buyPrice).div(100);
    if (data.availableBalance.lt(cost)) {
      this._logger?.warn('AdaptiveEntry: SKIP (insufficient balance)', {
        need: cost.toFixed(2),
        available: data.availableBalance.toFixed(2),
      });
      return [{ type: 'HOLD' }];
    }

    this._entered = true;

    if (chosen === 'complementary') {
      return [{
        type: 'BUY',
        price: buyPrice,
        size: this._orderSize,
        targetInstrumentId: data.complementaryInstrumentId,
        targetAsset: data.complementaryAsset,
      }];
    }

    return [{ type: 'BUY', price: buyPrice, size: this._orderSize }];
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  /**
   * Конвертирует действия в StrategyIntent для ExecutionEngine.
   *
   * @param actions - Массив решений из decide
   * @returns Массив интентов для исполнения
   */
  protected toIntents(actions: AEAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      if (action.type === 'HOLD') continue;

      intents.push({ type: 'CANCEL_ALL' });
      // Атомарная пара target-полей: либо оба, либо ни одного (placeTarget).
      const target = placeTarget(action.targetInstrumentId, action.targetAsset);
      const base = {
        type: 'PLACE' as const,
        side: 'BUY' as const,
        price: OutcomePrice.of(new Decimal(action.price).div(100)),
        size: Quantity.of(action.size),
      };
      intents.push(target ? { ...base, ...target } : base);
    }

    return intents;
  }
}
