/**
 * CrossMarketArbStrategy — кросс-маркетный арбитраж между парой рынков.
 *
 * @remarks
 * Стратегия регистрируется на один рынок (slot market). Второй рынок (peer market)
 * читается через MarketDataStore по peerInstrumentId.
 *
 * ### Ключевой принцип:
 * easy = рынок с **нижним** strike (≥ вероятность Up).
 * hard = рынок с **верхним** strike (≤ вероятность Up).
 * Какой из двух рынков станет easy/hard определяется **после** получения
 * обоих strike-цен из Chainlink RTDS — НЕ из длительности рынка.
 *
 * ### Единственная safe-сделка:
 * Условие расхождения: `hardUpBid > easyUpAsk`
 * Стратегия: BUY easy_Up + BUY hard_Down
 * Гарантия: ≥$1 с пары (strike-safe by construction)
 *
 * ### Детекция расхождений:
 * Используется DivergenceDetector из `@polymarket/cross-market` —
 * тот же код что в бектестах. Это гарантирует идентичное поведение
 * live/paper и backtest режимов.
 *
 * ### Алгоритм:
 * 1. На каждом tick получаем snapshot slot-рынка (из StrategyScheduler)
 * 2. Читаем TopOfBook peer-рынка из MarketDataStore
 * 3. Назначаем easyBook / hardBook по strike'ам (swap если нужно)
 * 4. Конвертируем TopOfBook → SimpleBook (depth=1)
 * 5. DivergenceDetector.detect() проверяет расхождение
 * 6. Если сигнал есть → размещаем обе ноги через callback
 *
 * @example
 * ```typescript
 * const strategy = new CrossMarketArbStrategy({
 *   peerInstrumentId: asInstrumentId('1080...'),
 *   minSpreadAfterFees: 0.005,
 *   maxPositionUnits: 50,
 * }, marketDataStore, 'arb-pair-1', logger);
 * ```
 */

import Decimal from 'decimal.js';
import { Ok } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import type { IStrategy } from '@polymarket/strategy';
import type { StrategySnapshot } from '@polymarket/strategy';
import type { StrategyIntent } from '@polymarket/strategy';
import type { TriggerReason } from '@polymarket/strategy';
import type { TopOfBook } from '@polymarket/event-bus';
import {
  DivergenceDetector,
  FEE_MODEL_CURRENT,
} from '@polymarket/cross-market';
import type {
  SimpleBook,
  FeeModel,
  DetectorConfig,
  ArbitrageSignal,
} from '@polymarket/cross-market';

// ── Конфигурация ────────────────────────────────────────────────────────────

/**
 * Конфигурация CrossMarketArbStrategy.
 *
 * @remarks
 * `peerInstrumentId` — InstrumentId второго рынка пары (Up-токен).
 * Стратегия регистрируется на slot-рынок (snapshot), peer читается из MarketDataStore.
 * `slotStrike` / `peerStrike` — strike-цены обоих рынков, приходят из Chainlink.
 * После получения обоих: easy = нижний strike, hard = верхний strike.
 */
export interface CrossMarketArbConfig {
  /** InstrumentId peer-рынка (Up-токен) — для чтения из MarketDataStore */
  readonly peerInstrumentId: InstrumentId;
  /** Минимальный spread после fees для входа (default: 0.005 = 0.5%) */
  readonly minSpreadAfterFees: number;
  /** Максимальное количество пар (units) в позиции (default: 50) */
  readonly maxPositionUnits: number;
  /** Strike-цена slot-рынка (priceToBeat), null если неизвестна */
  readonly slotStrike: number | null;
  /** Strike-цена peer-рынка (priceToBeat), null если неизвестна */
  readonly peerStrike: number | null;
  /** Модель комиссий Polymarket (default: FEE_MODEL_CURRENT) */
  readonly feeModel?: FeeModel;
  /**
   * Максимальная глубина ордербука для анализа (default: 1).
   *
   * @remarks
   * Сейчас TopOfBook даёт только depth=1. При расширении до full orderbook
   * увеличить для +25% PnL через VWAP-глубину (исследование: 98% расхождений
   * выживают до depth 5).
   */
  readonly maxDepth?: number;
}

// ── Интерфейс для чтения TopOfBook другого рынка ─────────────────────────────

/**
 * Минимальный интерфейс для чтения TopOfBook — позволяет inject MarketDataStore.
 */
export interface ITopOfBookReader {
  getTopOfBook(instrumentId: InstrumentId): TopOfBook | undefined;
}

// ── Назначение easy/hard ──────────────────────────────────────────────────

/**
 * Какой рынок стал easy (lower strike).
 *
 * @remarks
 * - `'SLOT_IS_EASY'`: slot-рынок имеет нижний strike → snapshot = easyBook
 * - `'PEER_IS_EASY'`: peer-рынок имеет нижний strike → snapshot = hardBook (стандартный случай)
 * - `null`: strikes ещё неизвестны
 */
export type StrikeAssignment = 'SLOT_IS_EASY' | 'PEER_IS_EASY' | null;

/** Обратная совместимость: callback direction для main.ts */
export type ArbDirection = 'UP' | 'DOWN';

// ── Стратегия ───────────────────────────────────────────────────────────────

/**
 * Кросс-маркетная арбитражная стратегия.
 *
 * @remarks
 * easy = нижний strike, hard = верхний strike.
 * Единственное условие: hardUpBid > easyUpAsk → BUY easy_Up + BUY hard_Down.
 * Детекция через DivergenceDetector (тот же код что в бектестах).
 */
export class CrossMarketArbStrategy implements IStrategy {
  readonly id: string;
  readonly name = 'CrossMarketArb';

  private _config: CrossMarketArbConfig;
  private readonly _reader: ITopOfBookReader;
  private readonly _logger: ILogger | undefined;

  /** DivergenceDetector — тот же что в бектестах */
  private _detector: DivergenceDetector;

  /**
   * Назначение easy/hard по strike'ам.
   *
   * @remarks
   * null — strikes ещё не получены, не торгуем.
   * SLOT_IS_EASY — slot strike < peer strike → snapshot = easyBook, reader = hardBook.
   * PEER_IS_EASY — peer strike ≤ slot strike → snapshot = hardBook, reader = easyBook.
   */
  private _assignment: StrikeAssignment = null;

  /** Флаг: уже вошли в текущем окне расхождения */

  /** Текущий размер позиции (юнитов купленных пар) */
  private _currentPositionUnits = 0;
  /** Timestamp последнего отклонения ордера (для cooldown) */
  private _lastRejectMs = 0;
  /** Cooldown после отклонения: 5с без повторных попыток */
  private readonly _rejectCooldownMs = 5000;

  /**
   * Callback для размещения обеих ног арбитража.
   *
   * @remarks
   * Параметры: (easyLegPrice, hardLegPrice, size, direction).
   * direction сообщает callback'у какие токены покупать:
   * - 'UP': BUY peer_Up (easy) + BUY slot_Down (hard) — peer=easy, slot=hard
   * - 'DOWN': BUY peer_Down (hard_Down) + BUY slot_Up (easy_Up) — slot=easy, peer=hard
   */
  private _onArbTradeNeeded:
    | ((easyPrice: Price, hardPrice: Price, size: Quantity, direction: ArbDirection) => Promise<boolean>)
    | undefined;

  // Метрики
  private _tickCount = 0;
  private _divergenceCount = 0;
  private _tradeCount = 0;
  private _totalPnlEstimate = 0;

  constructor(
    config: CrossMarketArbConfig,
    reader: ITopOfBookReader,
    id?: string,
    logger?: ILogger,
  ) {
    this._config = config;
    this._reader = reader;
    this._logger = logger?.child({ component: 'CrossMarketArbStrategy' });
    this.id = id ?? `cross-market-arb-${Date.now()}`;

    // DivergenceDetector с теми же параметрами что в бектестах
    const detectorConfig: Partial<DetectorConfig> = {
      maxDepth: config.maxDepth ?? 1,
      minSpreadAfterFees: config.minSpreadAfterFees,
      feeModel: config.feeModel ?? FEE_MODEL_CURRENT,
      easyIsTaker: true,
      hardIsMaker: true,
    };
    this._detector = new DivergenceDetector(detectorConfig);
  }

  /** Текущее назначение easy/hard */
  get assignment(): StrikeAssignment { return this._assignment; }

  /** Обратная совместимость: direction для callback */
  get direction(): ArbDirection {
    if (this._assignment === 'SLOT_IS_EASY') return 'DOWN';
    return 'UP';
  }

  /**
   * Возвращает strike-цены easy/hard рынков для settlement.
   *
   * @returns `{ easyStrike, hardStrike }` или undefined если assignment ещё не определён
   *
   * @remarks
   * CryptoPriceStore хранит один targetPrice per asset — не подходит для арбитража
   * (два рынка с разными strikes на один актив). Этот метод даёт per-market strikes.
   */
  getStrikes(): { easyStrike: number; hardStrike: number } | undefined {
    if (this._assignment === null) return undefined;
    const easyStrike = this._assignment === 'SLOT_IS_EASY' ? this._config.slotStrike : this._config.peerStrike;
    const hardStrike = this._assignment === 'SLOT_IS_EASY' ? this._config.peerStrike : this._config.slotStrike;
    if (easyStrike === null || hardStrike === null) return undefined;
    return { easyStrike, hardStrike };
  }

  /**
   * Устанавливает callback для атомарного размещения обеих ног арбитража.
   *
   * @param cb - Async callback: (easyLegPrice, hardLegPrice, size, direction) → boolean
   */
  setTradeCallback(cb: (easyPrice: Price, hardPrice: Price, size: Quantity, direction: ArbDirection) => Promise<boolean>): void {
    this._onArbTradeNeeded = cb;
  }

  /**
   * Обновляет strike цены и назначает easy/hard по strike'ам.
   *
   * @remarks
   * easy = нижний strike (P(Up) выше), hard = верхний strike (P(Up) ниже).
   * Если slotStrike < peerStrike → slot=easy (SLOT_IS_EASY).
   * Если peerStrike ≤ slotStrike → peer=easy (PEER_IS_EASY).
   *
   * @param slotStrike - Strike slot-рынка (null = ещё неизвестен)
   * @param peerStrike - Strike peer-рынка (null = ещё неизвестен)
   */
  updateStrikes(slotStrike: number | null, peerStrike: number | null): void {
    if (slotStrike !== null || peerStrike !== null) {
      this._config = {
        ...this._config,
        slotStrike: slotStrike ?? this._config.slotStrike,
        peerStrike: peerStrike ?? this._config.peerStrike,
      };
    }

    const s = this._config.slotStrike;
    const p = this._config.peerStrike;
    if (s !== null && p !== null) {
      const newAssignment: StrikeAssignment = s < p ? 'SLOT_IS_EASY' : 'PEER_IS_EASY';
      if (newAssignment !== this._assignment) {
        this._assignment = newAssignment;
      }
    }

    this._logger?.info('Strikes updated', {
      slotStrike: this._config.slotStrike,
      peerStrike: this._config.peerStrike,
      assignment: this._assignment,
      easyStrike: this._assignment === 'SLOT_IS_EASY' ? this._config.slotStrike : this._config.peerStrike,
      hardStrike: this._assignment === 'SLOT_IS_EASY' ? this._config.peerStrike : this._config.slotStrike,
    });
  }

  async initialize(): Promise<Result<void, Error>> {
    this._logger?.info('CrossMarketArbStrategy initialized', {
      peerInstrumentId: String(this._config.peerInstrumentId),
      minSpreadAfterFees: this._config.minSpreadAfterFees,
      slotStrike: this._config.slotStrike,
      peerStrike: this._config.peerStrike,
      assignment: this._assignment,
      detectorConfig: this._detector.config,
    });
    return Ok(undefined);
  }

  /**
   * Основной tick: назначаем easy/hard по strike'ам, детектим расхождение.
   *
   * @remarks
   * 1. Конвертируем TopOfBook → SimpleBook (depth=1)
   * 2. DivergenceDetector.detect(easyBook, hardBook) — тот же код что в бектестах
   * 3. Если сигнал есть → размещаем через callback
   */
  tick(snapshot: StrategySnapshot, _reasons: ReadonlySet<TriggerReason>): StrategyIntent[] {
    this._tickCount++;
    const nowMs = snapshot.nowMs;

    if (this._assignment === null) return [];

    const slotBook = snapshot.topOfBook;
    const peerBook = this._reader.getTopOfBook(this._config.peerInstrumentId);

    // Назначаем easyBook / hardBook по strike'ам
    const easyTopOfBook = this._assignment === 'SLOT_IS_EASY' ? slotBook : peerBook;
    const hardTopOfBook = this._assignment === 'SLOT_IS_EASY' ? peerBook : slotBook;

    // Конвертируем TopOfBook → SimpleBook для DivergenceDetector
    const easySimple = topOfBookToSimpleBook(easyTopOfBook, nowMs);
    const hardSimple = topOfBookToSimpleBook(hardTopOfBook, nowMs);
    if (!easySimple || !hardSimple) {
      // Периодический лог: нет данных в одном из стаканов
      if (this._tickCount % 100 === 1) {
        this._logger?.debug('Tick skipped: missing book data', {
          tickCount: this._tickCount,
          assignment: this._assignment,
          slotBookPresent: !!slotBook,
          peerBookPresent: !!peerBook,
          easySimpleOk: !!easySimple,
          hardSimpleOk: !!hardSimple,
          slotBestBid: slotBook?.bestBid?.value().toFixed(4) ?? '-',
          slotBestAsk: slotBook?.bestAsk?.value().toFixed(4) ?? '-',
          peerBestBid: peerBook?.bestBid?.value().toFixed(4) ?? '-',
          peerBestAsk: peerBook?.bestAsk?.value().toFixed(4) ?? '-',
        });
      }
      return [];
    }

    // Периодический diagnostic лог: цены в стаканах (каждые 50 тиков)
    if (this._tickCount % 50 === 1) {
      const hardBid = hardSimple.bids[0]?.price ?? 0;
      const easyAsk = easySimple.asks[0]?.price ?? 0;
      const rawGap = hardBid - easyAsk;
      this._logger?.debug('Arb tick diagnostic', {
        tickCount: this._tickCount,
        assignment: this._assignment,
        easyBestBid: easySimple.bids[0]?.price.toFixed(4) ?? '-',
        easyBestAsk: easyAsk.toFixed(4),
        hardBestBid: hardBid.toFixed(4),
        hardBestAsk: hardSimple.asks[0]?.price.toFixed(4) ?? '-',
        rawGap: rawGap.toFixed(4),
        diverges: rawGap > 0 ? 'YES' : 'no',
        minSpreadAfterFees: this._detector.config.minSpreadAfterFees,
      });
    }

    // Детекция через DivergenceDetector (только UP направление).
    // UP: hardBid > easyAsk → BUY easy_Up + BUY hard_Down
    // DOWN не используем: easyStrike < hardStrike → «Easy Up, Hard Down» исход возможен → потеря.
    // DOWN безопасен только когда easyStrike > hardStrike (а у нас всегда наоборот).
    const signal = this._detector.detect(easySimple, hardSimple, STUB_PAIR, nowMs);

    if (signal) {
      this._onSignal(signal, easyTopOfBook, nowMs, snapshot);
    }

    return [];
  }

  /**
   * Обрабатывает ArbitrageSignal от DivergenceDetector.
   *
   * @param signal - Сигнал расхождения (с оптимальной глубиной и PnL)
   * @param easyTopOfBook - TopOfBook easy рынка (для получения Price VO)
   * @param nowMs - Текущее время
   * @param snapshot - Для portfolio/balance
   */
  private _onSignal(signal: ArbitrageSignal, _easyTopOfBook: TopOfBook | undefined, nowMs: number, snapshot?: StrategySnapshot): void {
    this._divergenceCount++;

    // Арбитраж гарантирует прибыль — покупаем на КАЖДОМ тике пока есть capacity.
    // Единственные ограничения: reject cooldown (биржа отклонила) и position capacity.
    if (this._lastRejectMs > 0 && nowMs - this._lastRejectMs < this._rejectCooldownMs) return;

    const optimal = signal.optimalDepth;
    const remainingCapacity = this._config.maxPositionUnits - this._currentPositionUnits;
    if (remainingCapacity < 1) return;

    let size = Math.min(optimal.execSize, remainingCapacity);

    const portfolio = snapshot?.portfolio;
    if (portfolio) {
      const available = portfolio.balance.available().value().toNumber();
      const totalCostPerUnit = optimal.costPerUnit + optimal.feePerUnit;
      if (totalCostPerUnit > 0) {
        const maxAffordable = Math.floor(available / totalCostPerUnit);
        size = Math.min(size, maxAffordable);
      }
    }

    if (size < 1) return;

    // Оптимистичное обновление позиции СИНХРОННО до async callback.
    // Предотвращает race condition: следующий тик видит актуальный capacity.
    // При reject — откатываем в callback.
    this._currentPositionUnits += size;

    // Цены для callback: ВСЕГДА (easyUpAsk, hardDownAsk).
    // Callback всегда BUY easy_Up + BUY hard_Down — единственная safe-комбинация.
    // Маппинг токенов в main.ts НЕ зависит от direction.
    const cbDirection = this.direction;

    // easyUpAsk = цена покупки easy_Up
    // hardDownAsk = 1 - hardUpBid = цена покупки hard_Down
    const easyUpAsk = optimal.easyUpVwap;
    const hardDownAsk = 1 - optimal.hardUpVwap;

    const cbEasyPrice = Price.of(new Decimal(easyUpAsk.toFixed(4)));
    const cbHardPrice = Price.of(new Decimal(hardDownAsk.toFixed(4)));

    this._logger?.info('Arbitrage opportunity', {
      hardUpBid: optimal.hardUpVwap.toFixed(4),
      easyUpAsk: optimal.easyUpVwap.toFixed(4),
      spread: optimal.spread.toFixed(4),
      costPerUnit: optimal.costPerUnit.toFixed(4),
      feePerUnit: optimal.feePerUnit.toFixed(4),
      pnlPerUnit: optimal.pnlPerUnit.toFixed(4),
      depth: optimal.depth,
      size,
      assignment: this._assignment,
      callbackDirection: cbDirection,
    });

    this._placeTrade(cbEasyPrice, cbHardPrice, Quantity.of(new Decimal(size)), size, optimal.pnlPerUnit, cbDirection);
  }

  /**
   * Размещает обе ноги через callback.
   */
  private _placeTrade(easyPrice: Price, hardPrice: Price, qty: Quantity, size: number, pnlPerUnit: number, direction: ArbDirection): void {
    if (!this._onArbTradeNeeded) return;

    void this._onArbTradeNeeded(easyPrice, hardPrice, qty, direction).then(ok => {
      if (ok) {
        this._tradeCount++;
        this._totalPnlEstimate += size * pnlPerUnit;
        this._logger?.info('Arbitrage trade confirmed (both legs placed)', {
          size, pnlPerUnit: pnlPerUnit.toFixed(4), direction,
          currentPositionUnits: this._currentPositionUnits,
        });
      } else {
        // Откатываем оптимистичное обновление позиции
        this._currentPositionUnits -= size;
        this._lastRejectMs = Date.now();
        this._logger?.warn('Arbitrage trade rejected, cooldown 5s before retry', {
          currentPositionUnits: this._currentPositionUnits,
          maxPositionUnits: this._config.maxPositionUnits,
        });
      }
    });
  }

  stop(): StrategyIntent[] {
    this._logger?.info('CrossMarketArbStrategy stopping', {
      trades: this._tradeCount,
      divergences: this._divergenceCount,
      estimatedPnl: this._totalPnlEstimate.toFixed(2),
      assignment: this._assignment,
    });
    return [{ type: 'CANCEL_ALL' }];
  }

  getMetrics(): Record<string, unknown> {
    return {
      tickCount: this._tickCount,
      divergenceCount: this._divergenceCount,
      tradeCount: this._tradeCount,
      totalPnlEstimate: this._totalPnlEstimate,
      rejectCooldownActive: this._lastRejectMs > 0 && Date.now() - this._lastRejectMs < this._rejectCooldownMs,
      assignment: this._assignment,
      currentPositionUnits: this._currentPositionUnits,
    };
  }
}

// ── Утилиты ────────────────────────────────────────────────────────────────

/**
 * Конвертирует TopOfBook → SimpleBook (depth=1) для DivergenceDetector.
 *
 * @param tob - TopOfBook из MarketDataStore / snapshot
 * @param nowMs - Текущее время (для timestampMs)
 * @returns SimpleBook с одним уровнем или null если данных нет
 */
function topOfBookToSimpleBook(tob: TopOfBook | undefined, nowMs: number): SimpleBook | null {
  if (!tob) return null;

  const bids = tob.bestBid && tob.bestBidSize
    ? [{ price: tob.bestBid.value().toNumber(), size: tob.bestBidSize.value().toNumber() }]
    : [];
  const asks = tob.bestAsk && tob.bestAskSize
    ? [{ price: tob.bestAsk.value().toNumber(), size: tob.bestAskSize.value().toNumber() }]
    : [];

  return { bids, asks, timestampMs: nowMs };
}

/**
 * Stub MarketPair для DivergenceDetector.detect().
 *
 * @remarks
 * Детектор не использует pair внутренне — только прокидывает в ArbitrageSignal.
 * Стратегия использует signal.optimalDepth, а не signal.pair.
 */
const STUB_PAIR = {
  easy: { asset: '', recurrence: '5m' as const, endDate: '', endEpochMs: 0, instrumentId: '' as any, filePath: '' },
  hard: { asset: '', recurrence: '5m' as const, endDate: '', endEpochMs: 0, instrumentId: '' as any, filePath: '' },
  pairType: 'live',
  overlapMs: 0,
};
