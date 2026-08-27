/**
 * ProbTableStrategy — торговля схождением цены к fairValue (edge convergence).
 *
 * @remarks
 * Загружает таблицу P(UP | price_bucket, tau_bucket) из JSON файла.
 * Вместо ожидания resolution торгует движение цены к fairValue:
 * - **ENTRY (BUY)**: edge >= entryEdge → рынок underpriced, покупаем
 * - **EXIT (SELL)**: edge упал ниже exitEdge ИЛИ edge стал отрицательным (stopEdge)
 *   ИЛИ τ < exitTauSec → фиксируем прибыль/убыток до resolution
 *
 * Зарабатываем на Δprice (3-7¢), а не на бинарном исходе (+40/-60¢).
 * Риск кратно ниже, breakeven WR ниже.
 *
 * @example
 * ```typescript
 * const strategy = new ProbTableStrategy({
 *   probTablePath: '/tmp/prob-table-btc.json',
 *   orderSize: new Decimal(10),
 *   qMax: 5,
 *   entryEdge: 5,
 *   exitEdge: 2,
 *   stopEdge: 3,
 *   exitTauSec: 30,
 * });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent } from '@polymarket/strategy';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';
import { readFileSync } from 'fs';

// ── Конфигурация ──────────────────────────────────────────────────────────────

/**
 * Параметры ProbTableStrategy.
 *
 * @param probTablePath - Путь к JSON файлу с таблицей вероятностей
 * @param orderSize - Размер одного ордера
 * @param qMax - Максимальная позиция в единицах orderSize
 * @param entryEdge - Минимальный edge в центах для входа (default 5)
 * @param exitEdge - Edge ниже которого фиксируем прибыль (default 2)
 * @param stopEdge - Отрицательный edge для стоп-лосса (default 3, т.е. exit при edge < -3)
 * @param exitTauSec - Принудительный выход если τ < этого значения (default 30)
 * @param minN - Минимальное число наблюдений в бакете (default 50)
 * @param warmupSec - Секунды ожидания перед торговлей (default 10)
 * @param ewmaAlpha - Alpha для EWMA mid-price (default 0.3)
 * @param minTradesForMid - Минимум трейдов для EWMA (default 3)
 */
export interface ProbTableConfig {
  readonly probTablePath: string;
  readonly orderSize: Decimal;
  readonly qMax: number;
  readonly entryEdge?: number;
  readonly exitEdge?: number;
  readonly stopEdge?: number;
  readonly exitTauSec?: number;
  readonly minN?: number;
  readonly warmupSec?: number;
  readonly ewmaAlpha?: number;
  readonly minTradesForMid?: number;
}

// ── Внутренние типы ───────────────────────────────────────────────────────────

interface PTData {
  readonly midCents: number;
  readonly tauSec: number;
  readonly fairValueCents: number | null;
  readonly edge: number;
  readonly bucketN: number;
  readonly inventoryUnits: number;
  readonly positionQty: Decimal;
  readonly availableTokenQty: Decimal;
  readonly availableBalance: Decimal;
  readonly hasInFlightFills: boolean;
  readonly nowMs: number;
  readonly minOrderSize: Decimal | undefined;
  readonly minOrderValue: Decimal | undefined;
}

type PTAction =
  | { readonly type: 'QUOTE'; readonly bid: number; readonly ask: number; readonly bidSize: Decimal; readonly askSize: Decimal }
  | { readonly type: 'STOP' };

// ── Реализация ────────────────────────────────────────────────────────────────

export class ProbTableStrategy extends BaseStrategy<PTData, PTAction> {
  public readonly id: StrategyId;
  public readonly name = 'ProbTableStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _orderSize: Decimal;
  private readonly _qMax: number;
  private readonly _entryEdge: number;
  private readonly _exitEdge: number;
  private readonly _stopEdge: number;
  private readonly _exitTauSec: number;
  private readonly _minN: number;
  private readonly _warmupSec: number;
  private readonly _ewmaAlpha: number;
  private readonly _minTradesForMid: number;

  /** Таблица: key = "priceBucket:tauBucket" → { fairValueCents, total } */
  private readonly _table: Map<string, { fairValueCents: number; total: number }>;
  private readonly _bucketPrice: number;
  private readonly _bucketTau: number;

  /** EWMA mid-price (центы) */
  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;

  /** Отслеживание смены рынка */
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;

  /** Флаг: мы в позиции (купили и ждём выхода) */
  private _inPosition = false;
  /** Edge при входе (для логирования) */
  private _entryEdgeCents = 0;

  constructor(config: ProbTableConfig, strategyId: StrategyId = unsafeStrategyId('prob-table-1'), logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._orderSize = config.orderSize;
    this._qMax = config.qMax;
    this._entryEdge = config.entryEdge ?? 5;
    this._exitEdge = config.exitEdge ?? 2;
    this._stopEdge = config.stopEdge ?? 3;
    this._exitTauSec = config.exitTauSec ?? 30;
    this._minN = config.minN ?? 50;
    this._warmupSec = config.warmupSec ?? 10;
    this._ewmaAlpha = config.ewmaAlpha ?? 0.3;
    this._minTradesForMid = config.minTradesForMid ?? 3;

    // Загрузка таблицы
    const raw = JSON.parse(readFileSync(config.probTablePath, 'utf8'));
    this._bucketPrice = raw.config?.bucketPriceCents ?? 10;
    this._bucketTau = raw.config?.bucketTauSec ?? 60;
    this._table = new Map();
    for (const row of raw.table) {
      this._table.set(`${row.priceBucket}:${row.tauBucket}`, {
        fairValueCents: row.fairValueCents,
        total: row.total,
      });
    }
    this._logger?.warn('ProbTable: loaded', {
      path: config.probTablePath,
      buckets: this._table.size,
      bucketPrice: this._bucketPrice,
      bucketTau: this._bucketTau,
      entryEdge: this._entryEdge,
      exitEdge: this._exitEdge,
      stopEdge: this._stopEdge,
      exitTauSec: this._exitTauSec,
      minN: this._minN,
    });
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  protected gather(snapshot: StrategySnapshot): PTData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    // Смена рынка → сброс EWMA и позиции
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._inPosition = false;
      this._entryEdgeCents = 0;

      if (snapshot.eventStartMs !== undefined) {
        this._marketEventStartMs = snapshot.eventStartMs.toNumber();
      } else {
        return undefined;
      }
    }

    if (this._marketEventStartMs <= 0) return undefined;

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);

    // EWMA из trade tape
    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100;
        if (this._ewma === null) {
          this._ewma = priceNum;
        } else {
          this._ewma = this._ewmaAlpha * priceNum + (1 - this._ewmaAlpha) * this._ewma;
        }
        this._tradeCount++;
        this._lastTradeTimestampMs = tradeTs;
      }
    }

    // Fallback на topOfBook
    if (this._ewma === null && snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        this._ewma = ((bid + ask) / 2) * 100;
        this._tradeCount++;
      }
    }

    if (this._ewma === null || this._tradeCount < this._minTradesForMid) {
      return undefined;
    }

    // Warmup
    if ((snapshot.nowMs - this._marketEventStartMs) < this._warmupSec * 1000) {
      return undefined;
    }

    // Lookup в таблице
    const midCents = this._ewma;
    const pb = Math.floor(midCents / this._bucketPrice) * this._bucketPrice;
    const tb = Math.floor(tauSec / this._bucketTau) * this._bucketTau;
    const bucket = this._table.get(`${pb}:${tb}`);

    let fairValueCents: number | null = null;
    let edge = 0;
    let bucketN = 0;
    if (bucket && bucket.total >= this._minN) {
      fairValueCents = bucket.fairValueCents;
      edge = fairValueCents - midCents; // положительный = BUY edge
      bucketN = bucket.total;
    }

    // Portfolio
    const portfolio = snapshot.portfolio;
    const positionQty = portfolio?.getPosition(snapshot.instrumentId)?.quantity?.value() ?? new Decimal(0);
    const availableTokenQty = portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const availableBalance = portfolio?.balance.available().value() ?? new Decimal(0);

    // Обновляем _inPosition на основе реальной позиции
    if (positionQty.isZero()) {
      this._inPosition = false;
    }

    return {
      midCents,
      tauSec,
      fairValueCents,
      edge,
      bucketN,
      inventoryUnits: this._orderSize.gt(0) ? positionQty.div(this._orderSize).floor().toNumber() : 0,
      positionQty,
      availableTokenQty,
      availableBalance,
      hasInFlightFills: snapshot.hasInFlightFills,
      nowMs: snapshot.nowMs,
      minOrderSize: snapshot.constraints?.minOrderSize.value(),
      minOrderValue: snapshot.constraints?.minOrderValue.value(),
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  protected decide(data: PTData): PTAction[] {
    // In-flight fills → не торгуем
    if (data.hasInFlightFills) return [];

    const mid = Math.round(data.midCents);

    // ── Режим EXIT: мы в позиции, ищем момент для продажи ──
    if (this._inPosition && data.availableTokenQty.gt(0)) {
      let shouldExit = false;
      let exitReason = '';

      if (data.fairValueCents === null) {
        // Нет данных в таблице → выходим
        shouldExit = true;
        exitReason = 'no-data';
      } else if (data.edge < this._exitEdge) {
        // Edge сжался ниже exitEdge → take profit (цена подтянулась к fairValue)
        shouldExit = true;
        exitReason = data.edge >= 0 ? 'take-profit' : 'edge-gone';
      }

      if (!shouldExit && data.edge < -this._stopEdge) {
        // Edge стал сильно отрицательным → stop loss
        shouldExit = true;
        exitReason = 'stop-loss';
      }

      if (!shouldExit && data.tauSec < this._exitTauSec) {
        // Мало времени до конца → принудительный выход
        shouldExit = true;
        exitReason = 'time-exit';
      }

      if (shouldExit) {
        const ask = Math.max(1, Math.min(99, mid));
        let askSize = Decimal.min(this._orderSize, data.availableTokenQty);

        // minOrderValue check
        const minOV = data.minOrderValue ?? new Decimal(1);
        if (askSize.mul(new Decimal(ask).div(100)).lt(minOV)) {
          const minSize = minOV.div(new Decimal(ask).div(100)).ceil();
          if (minSize.lte(data.availableTokenQty)) {
            askSize = minSize;
          } else {
            return []; // Не можем продать — слишком мало
          }
        }

        this._logger?.warn('ProbTable: EXIT', {
          reason: exitReason,
          mid,
          edge: data.edge.toFixed(1),
          entryEdge: this._entryEdgeCents.toFixed(1),
          fv: data.fairValueCents?.toFixed(1) ?? 'null',
          tau: data.tauSec.toFixed(0),
          askSize: askSize.toFixed(0),
        });

        return [{
          type: 'QUOTE',
          bid: 0,
          ask,
          bidSize: new Decimal(0),
          askSize,
        }];
      }

      // Всё ещё хороший edge → можем докупить если есть место
      if (data.fairValueCents !== null && data.edge >= this._entryEdge && data.inventoryUnits < this._qMax) {
        const bid = Math.max(1, Math.min(99, mid));
        const cost = this._orderSize.mul(bid).div(100);
        if (data.availableBalance.gte(cost)) {
          let bidSize = this._orderSize;
          const minOV = data.minOrderValue ?? new Decimal(1);
          if (bidSize.mul(new Decimal(bid).div(100)).lt(minOV)) {
            const minSize = minOV.div(new Decimal(bid).div(100)).ceil();
            bidSize = minSize.lte(this._orderSize.mul(2)) ? minSize : new Decimal(0);
          }
          if (bidSize.gt(0)) {
            return [{
              type: 'QUOTE',
              bid,
              ask: 0,
              bidSize,
              askSize: new Decimal(0),
            }];
          }
        }
      }

      // Держим позицию, ничего не делаем
      return [{ type: 'STOP' }];
    }

    // ── Режим ENTRY: нет позиции, ищем вход ──

    // Нет данных в таблице → ничего не делаем
    if (data.fairValueCents === null) {
      return [{ type: 'STOP' }];
    }

    // Мало времени → не входим
    if (data.tauSec < this._exitTauSec + 30) {
      return [{ type: 'STOP' }];
    }

    // Достаточный edge для входа
    if (data.edge >= this._entryEdge && data.inventoryUnits < this._qMax) {
      const bid = Math.max(1, Math.min(99, mid));
      const cost = this._orderSize.mul(bid).div(100);
      if (data.availableBalance.gte(cost)) {
        let bidSize = this._orderSize;

        // minOrderValue check
        const minOV = data.minOrderValue ?? new Decimal(1);
        if (bidSize.mul(new Decimal(bid).div(100)).lt(minOV)) {
          const minSize = minOV.div(new Decimal(bid).div(100)).ceil();
          bidSize = minSize.lte(this._orderSize.mul(2)) ? minSize : new Decimal(0);
        }

        if (bidSize.gt(0)) {
          this._inPosition = true;
          this._entryEdgeCents = data.edge;

          this._logger?.warn('ProbTable: ENTRY', {
            mid,
            fv: data.fairValueCents.toFixed(1),
            edge: data.edge.toFixed(1),
            tau: data.tauSec.toFixed(0),
            bidSize: bidSize.toFixed(0),
            inv: data.inventoryUnits,
            n: data.bucketN,
          });

          return [{
            type: 'QUOTE',
            bid,
            ask: 0,
            bidSize,
            askSize: new Decimal(0),
          }];
        }
      }
    }

    // Нет edge → ничего
    return [];
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  protected toIntents(actions: PTAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      if (action.type === 'STOP') {
        intents.push({ type: 'CANCEL_ALL' });
        continue;
      }

      intents.push({ type: 'CANCEL_ALL' });

      if (action.bidSize.gt(0) && action.bid > 0) {
        intents.push({
          type: 'PLACE',
          side: 'BUY',
          price: OutcomePrice.of(new Decimal(action.bid).div(100)),
          size: Quantity.of(action.bidSize),
        });
      }

      if (action.askSize.gt(0) && action.ask > 0) {
        intents.push({
          type: 'PLACE',
          side: 'SELL',
          price: OutcomePrice.of(new Decimal(action.ask).div(100)),
          size: Quantity.of(action.askSize),
        });
      }
    }

    return intents;
  }
}
