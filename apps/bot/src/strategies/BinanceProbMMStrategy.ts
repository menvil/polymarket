import { BaseStrategy } from '@polymarket/strategy';
import type { StrategyIntent, StrategySnapshot, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
import Decimal from 'decimal.js';

/**
 * Одна OHLCV-свеча с Binance API.
 *
 * @remarks
 * Структура совпадает с ответом `/api/v3/klines`.
 */
interface Kline {
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * Параметры лог-нормального распределения доходностей для одного горизонта.
 *
 * @remarks
 * Вычисляются из исторических log-returns по свечам Binance за `lookbackDays` перед событием.
 */
interface HorizonStats {
  /** Среднее лог-доходности (дрейф) за горизонт. */
  readonly mu: number;
  /** Стандартное отклонение лог-доходности за горизонт. */
  readonly sigma: number;
}

/**
 * Конфигурация стратегии BinanceProbMM.
 *
 * @remarks
 * Все параметры кроме `orderSize` и `qMax` имеют разумные значения по умолчанию.
 */
export interface BinanceProbMMConfig {
  /** Размер одного ордера в токенах. */
  readonly orderSize: Decimal;
  /** Максимальное количество единиц в позиции (в orderSize). */
  readonly qMax: number;
  /** Количество дней истории Binance для построения модели. Default: 5. */
  readonly lookbackDays?: number;
  /** Максимальный горизонт прогноза в минутах. Default: 15. */
  readonly maxHorizonMinutes?: number;
  /** Учитывать дрейф (mu) при вычислении вероятности. Default: false. */
  readonly useDrift?: boolean;
  /** Минимальное превышение fair value над mid для открытия позиции (¢). Default: 2. */
  readonly minEdgeCents?: number;
  /** Базовый спред маркет-мейкинга (¢). Default: 1. */
  readonly baseSpreadCents?: number;
  /** Максимальный спред маркет-мейкинга (¢). Default: 8. */
  readonly maxSpreadCents?: number;
  /** Коэффициент скоса котировок по инвентарю. Default: 1. */
  readonly inventorySkew?: number;
  /** Секунды до экспирации для принудительного закрытия позиции. Default: 30. */
  readonly unwindSec?: number;
  /** Секунды прогрева после начала торговли. Default: 10. */
  readonly warmupSec?: number;
  /** Alpha EWMA для расчёта mid по тредам. Default: 0.3. */
  readonly ewmaAlpha?: number;
  /** Минимальное кол-во трейдов перед выставлением котировок. Default: 5. */
  readonly minTradesForMid?: number;
  /** Минимальное кол-во samples для признания модели готовой. Default: 200. */
  readonly minModelSamples?: number;
  /** Явный символ Binance (напр. "BTCUSD"). Default: выводится из asset. */
  readonly binanceSymbol?: string;
  /** Base URL Binance REST API. Default: "https://api.binance.com". */
  readonly binanceBaseUrl?: string;
}

/**
 * Данные одного тика, собранные методом `gather()`.
 */
interface BPMMData {
  /** Fair value в центах из лог-нормальной модели, или null если модель не готова. */
  readonly fairValueCents: number | null;
  /** Вероятность исхода для нашего токена [0, 1], или null если модель не готова. */
  readonly probToken: number | null;
  /** EWMA цена последних трейдов (¢). */
  readonly midCents: number;
  /** Секунды до экспирации рынка. */
  readonly tauSec: number;
  /** Текущий инвентарь в единицах orderSize. */
  readonly inventoryUnits: number;
  /** Текущая позиция в токенах (Decimal). */
  readonly positionQty: Decimal;
  /** Доступные для продажи токены. */
  readonly availableTokenQty: Decimal;
  /** Доступный баланс USDC. */
  readonly availableBalance: Decimal;
  /** Есть ли незавершённые fills. */
  readonly hasInFlightFills: boolean;
  /** Минимальный размер ордера из торговых ограничений. */
  readonly minOrderSize: Decimal | undefined;
  /** Минимальная стоимость ордера из торговых ограничений. */
  readonly minOrderValue: Decimal | undefined;
  /** Текущая цена базового актива. */
  readonly currentPrice: number;
  /** Страйк бинарного события. */
  readonly targetPrice: number;
  /** Флаг: модель построена и готова к использованию. */
  readonly modelReady: boolean;
}

/**
 * Торговые действия стратегии.
 *
 * - `QUOTE` — выставить двусторонние котировки (bid + ask).
 * - `UNWIND` — только sell для ликвидации позиции перед экспирацией.
 * - `STOP` — снять все ордера, не торговать.
 */
type BPMMAction =
  | { readonly type: 'QUOTE'; readonly bid: number; readonly ask: number; readonly bidSize: Decimal; readonly askSize: Decimal }
  | { readonly type: 'UNWIND'; readonly ask: number; readonly askSize: Decimal }
  | { readonly type: 'STOP' };

const DEFAULT_TIMEOUT_MS = 15_000;
const BINANCE_LIMIT = 1000;

/**
 * Аппроксимация функции нормального распределения (CDF) по Абрамовицу-Стегуну.
 *
 * @remarks
 * Полиномиальное приближение с ошибкой < 7.5×10⁻⁸.
 * Насыщается при |x| > 8 (возвращает 0 или 1).
 *
 * @param x - Стандартизированный z-score
 * @returns Вероятность P(Z ≤ x) ∈ [0, 1]
 *
 * @example
 * ```typescript
 * normalCdf(0)    // ≈ 0.5
 * normalCdf(1.96) // ≈ 0.975
 * ```
 */
function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

/**
 * Вычисляет логарифмические доходности по массиву цен с шагом `step`.
 *
 * @remarks
 * Пропускает записи с нулевыми/отрицательными ценами.
 * Возвращает `log(prices[i] / prices[i - step])` для каждого допустимого `i`.
 *
 * @param prices - Массив цен закрытия
 * @param step - Шаг (горизонт) в элементах массива
 * @returns Массив лог-доходностей
 *
 * @example
 * ```typescript
 * calcLogReturns([100, 102, 101], 1)
 * // ≈ [0.0198, -0.0099]
 * ```
 */
function calcLogReturns(prices: readonly number[], step: number): number[] {
  const returns: number[] = [];
  for (let i = step; i < prices.length; i++) {
    const prev = prices[i - step]!;
    const curr = prices[i]!;
    if (prev <= 0 || curr <= 0) continue;
    returns.push(Math.log(curr / prev));
  }
  return returns;
}

/**
 * Вычисляет среднее арифметическое массива.
 *
 * @param values - Непустой числовой массив
 * @returns Среднее значение
 * @throws {Error} Если массив пустой
 */
function calcMean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('cannot calculate mean of empty array');
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Вычисляет стандартное отклонение (популяционное) массива.
 *
 * @param values - Массив из минимум 2 элементов
 * @returns Положительное стандартное отклонение
 * @throws {Error} Если элементов < 2 или sigma не конечна/равна нулю
 */
function calcSigma(values: readonly number[]): number {
  if (values.length < 2) {
    throw new Error('not enough data to calculate sigma');
  }
  const mean = calcMean(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const sigma = Math.sqrt(variance);
  if (!Number.isFinite(sigma) || sigma <= 0) {
    throw new Error('sigma is invalid or zero');
  }
  return sigma;
}

/**
 * Загружает OHLCV-свечи с Binance REST API с поддержкой пагинации.
 *
 * @remarks
 * Запрашивает батчи по `BINANCE_LIMIT` (1000) свечей, пока не покроет весь диапазон.
 * Использует AbortSignal.timeout для ограничения времени каждого запроса.
 *
 * @param baseUrl - Base URL Binance API (напр. "https://api.binance.com")
 * @param symbol - Символ (напр. "BTCUSD")
 * @param interval - Таймфрейм (напр. "1m")
 * @param fromMs - Начало диапазона (Unix ms, включительно)
 * @param toMs - Конец диапазона (Unix ms, включительно)
 * @returns Массив Kline объектов, упорядоченных по времени
 * @throws {Error} При HTTP-ошибке Binance API
 *
 * @example
 * ```typescript
 * const klines = await fetchKlines('https://api.binance.com', 'BTCUSD', '1m', fromMs, toMs);
 * ```
 */
async function fetchKlines(
  baseUrl: string,
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
): Promise<Kline[]> {
  const klines: Kline[] = [];
  let startTime = fromMs;

  while (startTime < toMs) {
    const url = new URL('/api/v3/klines', baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(startTime));
    url.searchParams.set('endTime', String(toMs));
    url.searchParams.set('limit', String(BINANCE_LIMIT));

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Binance klines API error: ${response.status} ${text}`);
    }

    const raw = await response.json() as unknown[];
    const batch = Array.isArray(raw)
      ? raw.map((item): Kline => {
        const row = item as unknown[];
        return {
          openTime: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
          closeTime: Number(row[6]),
        };
      })
      : [];

    if (batch.length === 0) break;

    klines.push(...batch);
    startTime = batch[batch.length - 1]!.closeTime + 1;

    if (batch.length < BINANCE_LIMIT) break;
  }

  return klines;
}

/**
 * Пытается вывести Binance-символ из названия базового актива.
 *
 * @remarks
 * Строит символ по шаблону `{ASSET}USD` (напр. `BTC` → `BTCUSD`).
 * Возвращает `undefined`, если `asset` не задан или пустой.
 *
 * @param asset - Название актива из `snapshot.cryptoPrice.asset`
 * @returns Binance-символ или `undefined`
 */
function inferBinanceSymbol(asset: string | undefined): string | undefined {
  if (!asset) return undefined;
  const normalized = asset.trim().toUpperCase();
  if (!normalized) return undefined;
  return `${normalized}USD`;
}

/**
 * Проверяет, является ли исход «UP-like» (up или yes).
 *
 * @param name - Название исхода (регистронезависимо)
 * @returns `true` если исход UP-like
 */
function isUpLikeOutcome(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'up' || normalized === 'yes';
}

/**
 * Проверяет, является ли исход «DOWN-like» (down или no).
 *
 * @param name - Название исхода (регистронезависимо)
 * @returns `true` если исход DOWN-like
 */
function isDownLikeOutcome(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'down' || normalized === 'no';
}

/**
 * Вероятностный маркет-мейкер на основе лог-нормальной модели цены BTC (Binance).
 *
 * @remarks
 * ### Алгоритм
 *
 * **Построение модели (один раз на рынок):**
 * 1. При обнаружении нового рынка запускает асинхронную загрузку 1-минутных свечей
 *    с Binance за последние `lookbackDays` дней до начала события.
 * 2. Для каждого горизонта `h ∈ [1..maxHorizonMinutes]` вычисляет `mu` и `sigma`
 *    лог-доходностей с шагом `h` свечей.
 *
 * **Котирование (каждый тик):**
 * 1. Вычисляет текущий горизонт `h = ceil(tauSec / 60)`.
 * 2. Берёт `{mu, sigma}` для горизонта `h` и считает вероятность
 *    `P(close ≥ strike)` или `P(close < strike)` в зависимости от типа токена.
 * 3. Fair value = вероятность × 100¢.
 * 4. Применяет Avellaneda-Stoikov инвентарный скос:
 *    `reservation = fair - inventorySkew × inventoryUnits`
 *    `bid = floor(reservation - halfSpread)`
 *    `ask = ceil(reservation + halfSpread)`
 * 5. За `unwindSec` секунд до экспирации переключается в режим UNWIND
 *    (только sell по текущему mid).
 *
 * @example
 * ```typescript
 * const strategy = new BinanceProbMMStrategy(
 *   { orderSize: new Decimal(5), qMax: 3 },
 *   'btc-prob-mm',
 *   logger,
 * );
 * ```
 */
export class BinanceProbMMStrategy extends BaseStrategy<BPMMData, BPMMAction> {
  public readonly id: StrategyId;
  public readonly name = 'BinanceProbMMStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _orderSize: Decimal;
  private readonly _qMax: number;
  private readonly _lookbackDays: number;
  private readonly _maxHorizonMinutes: number;
  private readonly _useDrift: boolean;
  private readonly _minEdgeCents: number;
  private readonly _baseSpreadCents: number;
  private readonly _maxSpreadCents: number;
  private readonly _inventorySkew: number;
  private readonly _unwindSec: number;
  private readonly _warmupSec: number;
  private readonly _ewmaAlpha: number;
  private readonly _minTradesForMid: number;
  private readonly _minModelSamples: number;
  private readonly _binanceSymbolOverride: string | undefined;
  private readonly _binanceBaseUrl: string;

  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;
  private _marketEventStartMs = 0;
  private _currentMarketKey: string | null = null;
  private _isUpToken = true;

  private _statsByHorizon = new Map<number, HorizonStats>();
  private _modelReady = false;
  private _modelLoading = false;
  private _modelError: string | null = null;
  private _modelLogSuppressed = false;
  private _currentQuestion = '';

  /**
   * @param config - Конфигурация стратегии
   * @param strategyId - Уникальный идентификатор экземпляра. Default: "binance-prob-mm-1"
   * @param logger - Опциональный логгер
   */
  constructor(config: BinanceProbMMConfig, strategyId: StrategyId = unsafeStrategyId('binance-prob-mm-1'), logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._orderSize = config.orderSize;
    this._qMax = config.qMax;
    this._lookbackDays = config.lookbackDays ?? 5;
    this._maxHorizonMinutes = config.maxHorizonMinutes ?? 15;
    this._useDrift = config.useDrift ?? false;
    this._minEdgeCents = config.minEdgeCents ?? 2;
    this._baseSpreadCents = config.baseSpreadCents ?? 1;
    this._maxSpreadCents = config.maxSpreadCents ?? 8;
    this._inventorySkew = config.inventorySkew ?? 1;
    this._unwindSec = config.unwindSec ?? 30;
    this._warmupSec = config.warmupSec ?? 10;
    this._ewmaAlpha = config.ewmaAlpha ?? 0.3;
    this._minTradesForMid = config.minTradesForMid ?? 5;
    this._minModelSamples = config.minModelSamples ?? 200;
    this._binanceSymbolOverride = config.binanceSymbol?.trim().toUpperCase() || undefined;
    this._binanceBaseUrl = config.binanceBaseUrl ?? 'https://api.binance.com';

    this._logger?.warn('BinanceProbMM: init', {
      strategyId: this.id,
      qMax: this._qMax,
      lookbackDays: this._lookbackDays,
      maxHorizonMinutes: this._maxHorizonMinutes,
      useDrift: this._useDrift,
      minEdgeCents: this._minEdgeCents,
      baseSpreadCents: this._baseSpreadCents,
      maxSpreadCents: this._maxSpreadCents,
      inventorySkew: this._inventorySkew,
      unwindSec: this._unwindSec,
      binanceSymbol: this._binanceSymbolOverride ?? 'auto',
    });
  }

  /**
   * Собирает данные тика из снапшота рынка.
   *
   * @remarks
   * - При обнаружении нового рынка вызывает `_resetForNewMarket` и `_startModelBuild`.
   * - Обновляет EWMA mid по новым трейдам из TradeTape.
   * - Возвращает `undefined` (пропускает тик), если модель ещё не готова
   *   или не прошёл прогрев.
   *
   * @param snapshot - Снапшот состояния рынка
   * @returns Данные тика или `undefined`
   */
  protected gather(snapshot: StrategySnapshot): BPMMData | undefined {
    if (!snapshot.cryptoPrice) return undefined;
    if (snapshot.eventStartMs === undefined) return undefined;

    const currentPrice = snapshot.cryptoPrice.currentPrice;
    const targetPrice = snapshot.cryptoPrice.targetPrice;
    if (currentPrice <= 0 || !targetPrice || targetPrice <= 0) {
      return undefined;
    }

    const marketId = String(snapshot.market.id ?? '');
    const marketKey = `${marketId}:${snapshot.market.expirationMs}:${snapshot.eventStartMs.toNumber()}`;
    if (this._currentMarketKey !== marketKey) {
      this._resetForNewMarket(snapshot, marketKey);
      this._startModelBuild(snapshot, marketKey);
    }

    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100;
        this._ewma = this._ewma === null
          ? priceNum
          : this._ewmaAlpha * priceNum + (1 - this._ewmaAlpha) * this._ewma;
        this._tradeCount++;
        this._lastTradeTimestampMs = tradeTs;
      }
    }

    if (this._ewma === null && snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        this._ewma = ((bid + ask) / 2) * 100;
        this._tradeCount = Math.max(this._tradeCount, 1);
      }
    }

    if (this._ewma === null || this._tradeCount < this._minTradesForMid) {
      return undefined;
    }

    if ((snapshot.nowMs - this._marketEventStartMs) < this._warmupSec * 1000) {
      return undefined;
    }

    const tauSec = Math.max(0, (snapshot.market.expirationMs - snapshot.nowMs) / 1000);
    const horizonMinutes = Math.max(1, Math.min(this._maxHorizonMinutes, Math.ceil(tauSec / 60)));

    let fairValueCents: number | null = null;
    let probToken: number | null = null;
    if (this._modelReady) {
      const stats = this._statsByHorizon.get(horizonMinutes);
      if (stats) {
        const mu = this._useDrift ? stats.mu : 0;
        const pBelowOrEqual = this._probabilityCloseAtOrBelowTarget(currentPrice, targetPrice, mu, stats.sigma);
        const pUp = 1 - pBelowOrEqual;
        probToken = this._isUpToken ? pUp : 1 - pUp;
        fairValueCents = Math.max(1, Math.min(99, probToken * 100));
      }
    } else if (this._modelError && !this._modelLogSuppressed) {
      this._modelLogSuppressed = true;
      this._logger?.error('BinanceProbMM: model unavailable', { error: this._modelError });
    }

    const portfolio = snapshot.portfolio;
    const positionQty = portfolio?.getPosition(snapshot.instrumentId)?.quantity.value() ?? new Decimal(0);
    const availableTokenQty = portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const availableBalance = portfolio?.balance.available().value() ?? new Decimal(0);
    const inventoryUnits = this._orderSize.gt(0) ? positionQty.div(this._orderSize).toNumber() : 0;

    return {
      fairValueCents,
      probToken,
      midCents: this._ewma,
      tauSec,
      inventoryUnits,
      positionQty,
      availableTokenQty,
      availableBalance,
      hasInFlightFills: snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
      minOrderSize: snapshot.constraints?.minOrderSize.value(),
      minOrderValue: snapshot.constraints?.minOrderValue.value(),
      currentPrice,
      targetPrice,
      modelReady: this._modelReady,
    };
  }

  /**
   * Принимает торговые решения на основе данных тика.
   *
   * @remarks
   * Логика:
   * - Есть in-flight fills → ничего не делаем.
   * - Модель не готова → STOP.
   * - `tauSec ≤ unwindSec` → UNWIND (только sell по mid).
   * - `|edge| < minEdgeCents` и нет токенов → STOP.
   * - Иначе → QUOTE с инвентарным скосом.
   *
   * @param data - Данные тика из `gather()`
   * @param _reasons - Причины триггера (не используются)
   * @returns Список действий
   */
  protected decide(data: BPMMData, _reasons: ReadonlySet<TriggerReason>): BPMMAction[] {
    if (data.hasInFlightFills) return [];

    if (!data.modelReady || data.fairValueCents === null || data.probToken === null) {
      return [{ type: 'STOP' }];
    }

    const mid = Math.round(Math.max(1, Math.min(99, data.midCents)));

    if (data.tauSec <= this._unwindSec) {
      if (!data.availableTokenQty.gt(0)) {
        return [{ type: 'STOP' }];
      }

      let askSize = Decimal.min(this._orderSize, data.availableTokenQty);
      if (data.minOrderSize) {
        askSize = this.adjustSellSize(askSize, data.availableTokenQty, data.minOrderSize);
      }

      const ask = Math.max(1, Math.min(99, mid));
      if (!this._passesMinOrderValue(ask, askSize, data.minOrderValue)) {
        return [{ type: 'STOP' }];
      }

      return [{ type: 'UNWIND', ask, askSize }];
    }

    const edge = data.fairValueCents - mid;
    if (Math.abs(edge) < this._minEdgeCents && !data.availableTokenQty.gt(0)) {
      return [{ type: 'STOP' }];
    }

    const spreadBoost = Math.min(
      this._maxSpreadCents - this._baseSpreadCents,
      Math.max(0, Math.round(Math.abs(edge) / 2)),
    );
    const halfSpread = Math.max(
      this._baseSpreadCents,
      Math.min(this._maxSpreadCents, this._baseSpreadCents + spreadBoost),
    );

    const reservation = data.fairValueCents - this._inventorySkew * data.inventoryUnits;
    let bid = Math.floor(reservation - halfSpread);
    let ask = Math.ceil(reservation + halfSpread);
    bid = Math.max(1, Math.min(98, bid));
    ask = Math.max(bid + 1, Math.min(99, ask));

    let bidSize = new Decimal(0);
    let askSize = new Decimal(0);

    if (data.inventoryUnits < this._qMax) {
      const cost = this._orderSize.mul(bid).div(100);
      if (data.availableBalance.gte(cost)) {
        bidSize = data.minOrderSize ? Decimal.max(this._orderSize, data.minOrderSize) : this._orderSize;
        if (!this._passesMinOrderValue(bid, bidSize, data.minOrderValue)) {
          bidSize = new Decimal(0);
        }
      }
    }

    if (data.availableTokenQty.gt(0)) {
      askSize = Decimal.min(this._orderSize, data.availableTokenQty);
      if (data.minOrderSize) {
        askSize = this.adjustSellSize(askSize, data.availableTokenQty, data.minOrderSize);
      }
      if (!this._passesMinOrderValue(ask, askSize, data.minOrderValue)) {
        askSize = new Decimal(0);
      }
    }

    if (Math.abs(edge) < this._minEdgeCents) {
      bidSize = new Decimal(0);
    }

    if (edge <= -this._minEdgeCents) {
      bidSize = new Decimal(0);
    }

    if (edge >= this._minEdgeCents && askSize.gt(0) && data.availableTokenQty.lte(this._orderSize)) {
      askSize = new Decimal(0);
    }

    if (bidSize.lte(0) && askSize.lte(0)) {
      return [{ type: 'STOP' }];
    }

    return [{
      type: 'QUOTE',
      bid,
      ask,
      bidSize,
      askSize,
    }];
  }

  /**
   * Преобразует действия в торговые интенты.
   *
   * @remarks
   * Каждое действие предваряется `CANCEL_ALL`.
   * - `STOP` → только отмена.
   * - `UNWIND` → отмена + SELL ask.
   * - `QUOTE` → отмена + BUY bid + SELL ask (если размеры > 0).
   *
   * @param actions - Список действий из `decide()`
   * @returns Список интентов для исполнения
   */
  protected toIntents(actions: BPMMAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      intents.push({ type: 'CANCEL_ALL' });

      if (action.type === 'STOP') {
        continue;
      }

      if (action.type === 'UNWIND') {
        if (action.askSize.gt(0)) {
          intents.push({
            type: 'PLACE',
            side: 'SELL',
            price: Price.of(new Decimal(action.ask).div(100)),
            size: Quantity.of(action.askSize),
          });
        }
        continue;
      }

      if (action.bidSize.gt(0)) {
        intents.push({
          type: 'PLACE',
          side: 'BUY',
          price: Price.of(new Decimal(action.bid).div(100)),
          size: Quantity.of(action.bidSize),
        });
      }

      if (action.askSize.gt(0)) {
        intents.push({
          type: 'PLACE',
          side: 'SELL',
          price: Price.of(new Decimal(action.ask).div(100)),
          size: Quantity.of(action.askSize),
        });
      }
    }

    return intents;
  }

  /**
   * Возвращает метрики состояния модели для мониторинга.
   *
   * @returns Объект с флагами модели и статистикой
   */
  public getMetrics(): Record<string, unknown> {
    return {
      modelReady: this._modelReady,
      modelLoading: this._modelLoading,
      modelError: this._modelError,
      statsLoaded: this._statsByHorizon.size,
      marketKey: this._currentMarketKey,
    };
  }

  /**
   * Сбрасывает состояние при переходе к новому рынку.
   *
   * @remarks
   * Определяет тип токена (UP/DOWN) по названию исхода из market.outcomes.
   * Если совпадение не найдено, считает токен UP-like по умолчанию.
   *
   * @param snapshot - Снапшот нового рынка
   * @param marketKey - Ключ нового рынка для логирования
   */
  private _resetForNewMarket(snapshot: StrategySnapshot, marketKey: string): void {
    this._currentMarketKey = marketKey;
    this._currentQuestion = snapshot.market.question;
    this._marketEventStartMs = snapshot.eventStartMs?.toNumber() ?? 0;
    this._ewma = null;
    this._tradeCount = 0;
    this._lastTradeTimestampMs = 0;
    this._statsByHorizon = new Map();
    this._modelReady = false;
    this._modelLoading = false;
    this._modelError = null;
    this._modelLogSuppressed = false;
    const outcomes = Array.isArray(snapshot.market.outcomes)
      ? snapshot.market.outcomes
      : [];
    const matchedOutcome = outcomes.find(
      (outcome: { token: unknown; name: string; index: number }) =>
        String(outcome.token) === String(snapshot.instrumentId),
    );

    if (matchedOutcome) {
      if (isUpLikeOutcome(matchedOutcome.name)) {
        this._isUpToken = true;
      } else if (isDownLikeOutcome(matchedOutcome.name)) {
        this._isUpToken = false;
      } else {
        this._isUpToken = matchedOutcome.index === 0;
      }
    } else {
      this._isUpToken = true;
    }

    this._logger?.warn('BinanceProbMM: new market', {
      strategyId: this.id,
      question: this._currentQuestion,
      instrumentId: String(snapshot.instrumentId),
      outcomeSide: this._isUpToken ? 'UP' : 'DOWN',
      eventStart: this._marketEventStartMs > 0 ? new Date(this._marketEventStartMs).toISOString() : 'unknown',
      expiry: new Date(snapshot.market.expirationMs).toISOString(),
      marketKey,
    });
  }

  /**
   * Запускает асинхронное построение лог-нормальной модели по Binance-данным.
   *
   * @remarks
   * Запускается один раз на рынок через `void (async () => {...})()`.
   * После завершения устанавливает `_modelReady = true` и заполняет `_statsByHorizon`.
   * При ошибке — сохраняет текст в `_modelError`.
   * Если рынок сменился пока строилась модель — результат игнорируется.
   *
   * @param snapshot - Снапшот для получения символа и периода
   * @param marketKey - Ключ текущего рынка (для проверки актуальности)
   */
  private _startModelBuild(snapshot: StrategySnapshot, marketKey: string): void {
    if (this._modelLoading || this._modelReady) return;

    const eventStartMs = snapshot.eventStartMs?.toNumber();
    const asset = snapshot.cryptoPrice?.asset;
    const symbol = this._binanceSymbolOverride ?? inferBinanceSymbol(asset);

    if (!eventStartMs || !symbol) {
      this._modelError = 'missing eventStartMs or Binance symbol';
      return;
    }

    this._modelLoading = true;
    const lookbackMs = this._lookbackDays * 24 * 60 * 60 * 1000;
    const fromMs = eventStartMs - lookbackMs;
    const toMs = eventStartMs - 1;

    this._logger?.warn('BinanceProbMM: building model', {
      strategyId: this.id,
      question: this._currentQuestion,
      outcomeSide: this._isUpToken ? 'UP' : 'DOWN',
      symbol,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      eventStart: new Date(eventStartMs).toISOString(),
    });

    void (async () => {
      try {
        const klines = await fetchKlines(this._binanceBaseUrl, symbol, '1m', fromMs, toMs);
        const prices = klines.map(kline => kline.close).filter(price => price > 0);

        if (prices.length < this._minModelSamples) {
          throw new Error(`not enough klines: ${prices.length} < ${this._minModelSamples}`);
        }

        const stats = new Map<number, HorizonStats>();
        for (let step = 1; step <= this._maxHorizonMinutes; step++) {
          const returns = calcLogReturns(prices, step);
          if (returns.length < this._minModelSamples) {
            throw new Error(`not enough returns for horizon ${step}: ${returns.length}`);
          }
          const mu = calcMean(returns);
          const sigma = calcSigma(returns);
          stats.set(step, { mu, sigma });
        }

        if (this._currentMarketKey !== marketKey) {
          return;
        }

        this._statsByHorizon = stats;
        this._modelReady = true;
        this._modelError = null;
        this._logger?.warn('BinanceProbMM: model built', {
          strategyId: this.id,
          question: this._currentQuestion,
          outcomeSide: this._isUpToken ? 'UP' : 'DOWN',
          symbol,
          eventStart: new Date(eventStartMs).toISOString(),
          lookbackDays: this._lookbackDays,
          klines: prices.length,
          horizons: stats.size,
          useDrift: this._useDrift,
        });
      } catch (error) {
        if (this._currentMarketKey !== marketKey) {
          return;
        }
        this._modelError = error instanceof Error ? error.message : String(error);
        this._logger?.error('BinanceProbMM: model build failed', {
          strategyId: this.id,
          question: this._currentQuestion,
          outcomeSide: this._isUpToken ? 'UP' : 'DOWN',
          symbol,
          eventStart: new Date(eventStartMs).toISOString(),
          error: this._modelError,
        });
      } finally {
        if (this._currentMarketKey === marketKey) {
          this._modelLoading = false;
        }
      }
    })();
  }

  /**
   * Вычисляет вероятность закрытия цены на уровне или ниже страйка.
   *
   * @remarks
   * Использует лог-нормальное распределение:
   * `z = (log(strike / current) - mu) / sigma`
   * `P(close ≤ strike) = Φ(z)`
   *
   * @param currentPrice - Текущая цена базового актива
   * @param targetPrice - Страйк бинарного события
   * @param mu - Дрейф лог-доходности (0 если `useDrift = false`)
   * @param sigma - Стандартное отклонение лог-доходности
   * @returns Вероятность P(close ≤ strike) ∈ [0, 1]
   */
  private _probabilityCloseAtOrBelowTarget(
    currentPrice: number,
    targetPrice: number,
    mu: number,
    sigma: number,
  ): number {
    const logReturnTarget = Math.log(targetPrice / currentPrice);
    const z = (logReturnTarget - mu) / sigma;
    return normalCdf(z);
  }

  /**
   * Проверяет, что ордер проходит минимальную стоимость.
   *
   * @param priceCents - Цена ордера в центах
   * @param size - Размер ордера
   * @param minOrderValue - Минимальная стоимость ордера (USDC) или undefined
   * @returns `true` если ордер проходит порог или ограничение не задано
   */
  private _passesMinOrderValue(priceCents: number, size: Decimal, minOrderValue: Decimal | undefined): boolean {
    if (!minOrderValue || size.lte(0)) return size.gt(0);
    return size.mul(priceCents).div(100).gte(minOrderValue);
  }
}
