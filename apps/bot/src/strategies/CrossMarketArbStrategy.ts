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

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';
import { Ok } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import type { IStrategy } from '@polymarket/strategy';
import type { StrategySnapshot } from '@polymarket/strategy';
import type { StrategyIntent, StrategyStopIntent } from '@polymarket/strategy';
import type { TriggerReason } from '@polymarket/strategy';
import type { TopOfBook } from '@polymarket/application-events';
import type { RollingWindow } from '@polymarket/rolling-window';
import type { Orderbook } from '@polymarket/orderbook';
import {
  FeeCalculator,
  FEE_MODEL_CURRENT,
} from '@polymarket/cross-market';
import type {
  SimpleBook,
  FeeModel,
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
  /** InstrumentId slot-рынка (Down-токен) */
  readonly slotDownInstrumentId?: InstrumentId;
  /** InstrumentId peer-рынка (Down-токен) */
  readonly peerDownInstrumentId?: InstrumentId;
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
  /** Максимальный возраст любой книги относительно nowMs (default: 1500). */
  readonly bookStalenessMs?: number;
  /** Подробный decision/audit log для paper-debug (default: false). */
  readonly auditMode?: boolean;
  /** Rate limit для шумных audit skip-событий в ms (default: 5000). */
  readonly auditThrottleMs?: number;
  /** Тип ордера для execution. Для Polymarket CLOB IOC-аналог = FAK. */
  readonly executionOrderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  /** Сколько ждать fills перед reconciliation/repair (default: 750ms). */
  readonly executionReconcileDelayMs?: number;
  /** Сколько ждать fills после repair-ордера (default: 750ms). */
  readonly executionRepairDelayMs?: number;
  /**
   * Максимальная глубина ордербука для audit-анализа (default: 1).
   *
   * @remarks
   * Execution пока всегда использует только первый уровень. Если `maxDepth > 1`,
   * стратегия читает full orderbook из `bookHistory` и логирует, что было бы
   * на уровнях 2..N, но размер и цены ордеров не расширяет глубже top level.
   */
  readonly maxDepth?: number;
}

// ── Интерфейс для чтения TopOfBook другого рынка ─────────────────────────────

/**
 * Минимальный интерфейс для чтения TopOfBook — позволяет inject MarketDataStore.
 */
export interface ITopOfBookReader {
  getTopOfBook(instrumentId: InstrumentId): TopOfBook | undefined;
  getTopOfBookTimestampMs?(instrumentId: InstrumentId): number | undefined;
  getBookHistory?(instrumentId: InstrumentId): RollingWindow<Orderbook> | undefined;
}

export interface ArbTradePlan {
  readonly easyInstrumentId: InstrumentId;
  readonly hardInstrumentId: InstrumentId;
  readonly easyPrice: OutcomePrice;
  readonly hardPrice: OutcomePrice;
  readonly size: Quantity;
  readonly direction: ArbDirection;
  readonly estimatedCostPerUnit: number;
  readonly estimatedFeePerUnit: number;
  readonly estimatedPnlPerUnit: number;
  readonly easyBookAgeMs: number | null;
  readonly hardBookAgeMs: number | null;
  readonly auditDepthLevels?: readonly ArbDepthAuditLevel[];
}

export type ArbExecutionRepairState =
  | 'BALANCED'
  | 'NEEDS_REBALANCE'
  | 'REBALANCED'
  | 'NEEDS_UNWIND'
  | 'UNWOUND'
  | 'FAILED_REPAIR'
  | 'NO_FILL'
  | 'REJECTED';

export interface ArbTradeExecutionReport {
  readonly accepted: boolean;
  readonly repairState: ArbExecutionRepairState;
  readonly plannedSize: number;
  readonly easyFilledSize: number;
  readonly hardFilledSize: number;
  readonly balancedSize: number;
  readonly unhedgedSize: number;
  readonly actualNotional?: number;
  readonly actualFees?: number;
  readonly conservativeSettlementValue?: number;
  readonly conservativePnl?: number;
}

export interface ArbDepthAuditLevel {
  readonly depth: number;
  readonly easyUpVwap: number;
  readonly hardDownVwap: number;
  readonly costPerUnit: number;
  readonly feePerUnit: number;
  readonly pnlPerUnit: number;
  readonly execSize: number;
  readonly totalPnl: number;
}

interface ArbCandidateObservation {
  readonly observedAtMs: number;
  readonly depth: number;
  readonly easyUpVwap: number;
  readonly hardDownVwap: number;
  readonly costPerUnit: number;
  readonly feePerUnit: number;
  readonly pnlPerUnit: number;
  readonly execSize: number;
  readonly totalPnl: number;
  readonly easyBookAgeMs: number | null;
  readonly hardBookAgeMs: number | null;
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
  readonly id: StrategyId;
  readonly name = 'CrossMarketArb';

  private _config: CrossMarketArbConfig;
  private readonly _reader: ITopOfBookReader;
  private readonly _logger: ILogger | undefined;

  private readonly _feeCalc: FeeCalculator;

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
    | ((plan: ArbTradePlan) => Promise<ArbTradeExecutionReport>)
    | undefined;

  // Метрики
  private _tickCount = 0;
  private _divergenceCount = 0;
  private _tradeCount = 0;
  private _totalPnlEstimate = 0;
  private _acceptedPlannedCost = 0;
  private _acceptedPlannedFees = 0;
  private _acceptedSettlementFaceValue = 0;
  private _actualNotional = 0;
  private _actualFees = 0;
  private _actualConservativePnl = 0;
  private _unhedgedExecutionCount = 0;
  private _failedRepairCount = 0;
  private readonly _repairStateCounts = new Map<string, number>();
  private readonly _lastAuditLogMs = new Map<string, number>();
  private readonly _suppressedAuditCount = new Map<string, number>();
  private readonly _auditEventCounts = new Map<string, number>();
  private _freshEvaluationCount = 0;
  private _grossCrossSampleCount = 0;
  private _netSignalSampleCount = 0;
  private _bestObserved: ArbCandidateObservation | null = null;

  constructor(
    config: CrossMarketArbConfig,
    reader: ITopOfBookReader,
    id?: StrategyId,
    logger?: ILogger,
  ) {
    this._config = config;
    this._reader = reader;
    this._logger = logger?.child({ component: 'CrossMarketArbStrategy' });
    this.id = id ?? unsafeStrategyId(`cross-market-arb-${Date.now()}`);

    this._feeCalc = new FeeCalculator(config.feeModel ?? FEE_MODEL_CURRENT);
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
  setTradeCallback(cb: (plan: ArbTradePlan) => Promise<ArbTradeExecutionReport>): void {
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
      maxDepth: this._config.maxDepth ?? 1,
      bookStalenessMs: this._config.bookStalenessMs ?? 1500,
      auditMode: this._config.auditMode ?? false,
    });
    return Ok(undefined);
  }

  async dispose(): Promise<Result<void, Error>> {
    // Нечего освобождать — initialize() не открывает внешних ресурсов
    // (подписки на market data управляются вызывающим кодом, не стратегией).
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
    const slotDownId = this._config.slotDownInstrumentId;
    const peerDownId = this._config.peerDownInstrumentId;
    const slotDownBook = slotDownId ? this._reader.getTopOfBook(slotDownId) : undefined;
    const peerDownBook = peerDownId ? this._reader.getTopOfBook(peerDownId) : undefined;

    const easyUpTopOfBook = this._assignment === 'SLOT_IS_EASY' ? slotBook : peerBook;
    const hardDownTopOfBook = this._assignment === 'SLOT_IS_EASY' ? peerDownBook : slotDownBook;
    const easyInstrumentId = this._assignment === 'SLOT_IS_EASY' ? snapshot.instrumentId : this._config.peerInstrumentId;
    const hardInstrumentId = this._assignment === 'SLOT_IS_EASY' ? peerDownId : slotDownId;

    const easyBookTs = this._getBookTimestampMs(easyInstrumentId, nowMs);
    const hardBookTs = hardInstrumentId ? this._getBookTimestampMs(hardInstrumentId, nowMs) : undefined;
    const easyBookAgeMs = easyBookTs !== undefined ? nowMs - easyBookTs : null;
    const hardBookAgeMs = hardBookTs !== undefined ? nowMs - hardBookTs : null;

    const easySimple = topOfBookToSimpleBook(easyUpTopOfBook, easyBookTs ?? nowMs);
    const hardDownSimple = topOfBookToSimpleBook(hardDownTopOfBook, hardBookTs ?? nowMs);
    if (!easySimple || !hardDownSimple || !hardInstrumentId) {
      // Периодический лог: нет данных в одном из стаканов
      if (this._tickCount % 100 === 1) {
        this._logger?.debug('Tick skipped: missing book data', {
          tickCount: this._tickCount,
          assignment: this._assignment,
          slotBookPresent: !!slotBook,
          peerBookPresent: !!peerBook,
          easySimpleOk: !!easySimple,
          hardDownSimpleOk: !!hardDownSimple,
          hardInstrumentIdPresent: !!hardInstrumentId,
          slotBestBid: slotBook?.bestBid?.value().toFixed(4) ?? '-',
          slotBestAsk: slotBook?.bestAsk?.value().toFixed(4) ?? '-',
          peerBestBid: peerBook?.bestBid?.value().toFixed(4) ?? '-',
          peerBestAsk: peerBook?.bestAsk?.value().toFixed(4) ?? '-',
          slotDownBestAsk: slotDownBook?.bestAsk?.value().toFixed(4) ?? '-',
          peerDownBestAsk: peerDownBook?.bestAsk?.value().toFixed(4) ?? '-',
        });
      }
      this._audit('SKIP_MISSING_BOOK', nowMs, {
        assignment: this._assignment,
        easyInstrumentId: String(easyInstrumentId),
        hardInstrumentId: hardInstrumentId ? String(hardInstrumentId) : null,
        easyBookPresent: !!easyUpTopOfBook,
        hardDownBookPresent: !!hardDownTopOfBook,
      });
      return [];
    }

    const bookStalenessMs = this._config.bookStalenessMs ?? 1500;
    if ((easyBookAgeMs !== null && easyBookAgeMs > bookStalenessMs) ||
        (hardBookAgeMs !== null && hardBookAgeMs > bookStalenessMs)) {
      this._audit('SKIP_STALE_BOOK', nowMs, {
        assignment: this._assignment,
        easyBookAgeMs,
        hardBookAgeMs,
        bookStalenessMs,
      });
      // Периодический INFO-лог: виден даже без auditMode
      if (this._tickCount % 50 === 1) {
        this._logger?.info('Arb tick skipped: stale book', {
          strategyId: this.id,
          easyBookAgeMs,
          hardBookAgeMs,
          bookStalenessMs,
        });
      }
      return [];
    }

    // Периодический diagnostic лог: цены в стаканах (каждые 50 тиков)
    if (this._tickCount % 50 === 1) {
      const easyAsk = easySimple.asks[0]?.price ?? 0;
      const hardDownAsk = hardDownSimple.asks[0]?.price ?? 0;
      const rawGap = 1 - easyAsk - hardDownAsk;
      this._logger?.info('Arb tick diagnostic', {
        strategyId: this.id,
        tickCount: this._tickCount,
        easyBestBid: (easySimple.bids[0]?.price ?? 0).toFixed(4),
        easyBestAsk: easyAsk.toFixed(4),
        hardDownBestAsk: hardDownAsk.toFixed(4),
        rawGap: rawGap.toFixed(4),
        diverges: rawGap > 0 ? 'YES' : 'no',
        minSpreadAfterFees: this._config.minSpreadAfterFees,
        easyBookAgeMs,
        hardBookAgeMs,
      });
    }

    const signal = this._detectTakerBuySignal(
      easySimple,
      hardDownSimple,
      nowMs,
      easyBookAgeMs,
      hardBookAgeMs,
      1,
    );

    if (signal) {
      const easyHistory = String(easyInstrumentId) === String(snapshot.instrumentId)
        ? snapshot.bookHistory
        : this._reader.getBookHistory?.(easyInstrumentId);
      const hardHistory = this._reader.getBookHistory?.(hardInstrumentId);
      const auditDepthLevels = this._buildDepthAuditLevels(
        this._latestBookSnapshot(easyHistory),
        this._latestBookSnapshot(hardHistory),
      );
      this._onSignal(signal, nowMs, snapshot, {
        easyInstrumentId,
        hardInstrumentId,
        easyBookAgeMs,
        hardBookAgeMs,
        auditDepthLevels,
      });
    }

    return [];
  }

  private _detectTakerBuySignal(
    easyBook: SimpleBook,
    hardDownBook: SimpleBook,
    nowMs: number,
    easyBookAgeMs: number | null,
    hardBookAgeMs: number | null,
    executionDepth: number,
  ): ArbitrageSignal | null {
    const easyLevels = easyBook.asks;
    const hardLevels = hardDownBook.asks;
    const maxDepth = Math.min(executionDepth, easyLevels.length, hardLevels.length);
    if (maxDepth === 0) return null;

    const depthLevels = [];
    let cumEasySize = 0;
    let cumEasyNotional = 0;
    let cumHardSize = 0;
    let cumHardNotional = 0;

    for (let i = 0; i < maxDepth; i++) {
      const easy = easyLevels[i];
      const hard = hardLevels[i];
      cumEasySize += easy.size;
      cumEasyNotional += easy.price * easy.size;
      cumHardSize += hard.size;
      cumHardNotional += hard.price * hard.size;

      const execSize = Math.min(cumEasySize, cumHardSize);
      if (execSize <= 0) continue;

      const easyVwap = cumEasyNotional / cumEasySize;
      const hardDownVwap = cumHardNotional / cumHardSize;
      const costPerUnit = easyVwap + hardDownVwap;
      const feePerUnit = this._feeCalc.pairFee(easyVwap, true, hardDownVwap, true, execSize) / execSize;
      const pnlPerUnit = 1 - costPerUnit - feePerUnit;
      const spread = 1 - costPerUnit;

      this._observeCandidate({
        observedAtMs: nowMs,
        depth: i + 1,
        easyUpVwap: easyVwap,
        hardDownVwap,
        costPerUnit,
        feePerUnit,
        pnlPerUnit,
        execSize,
        totalPnl: pnlPerUnit * execSize,
        easyBookAgeMs,
        hardBookAgeMs,
      });

      if (spread <= 0) break;

      depthLevels.push({
        depth: i + 1,
        hardUpVwap: 1 - hardDownVwap,
        easyUpVwap: easyVwap,
        spread,
        execSize,
        costPerUnit,
        feePerUnit,
        pnlPerUnit,
        totalPnl: pnlPerUnit * execSize,
      });
    }

    const optimal = depthLevels.reduce<typeof depthLevels[number] | undefined>(
      (best, level) => !best || level.totalPnl > best.totalPnl ? level : best,
      undefined,
    );
    if (!optimal || optimal.pnlPerUnit < this._config.minSpreadAfterFees) {
      this._audit('NO_SIGNAL', nowMs, {
        assignment: this._assignment,
        easyAsk: easyLevels[0]?.price ?? null,
        hardDownAsk: hardLevels[0]?.price ?? null,
        bestPnlPerUnit: optimal?.pnlPerUnit ?? null,
        minSpreadAfterFees: this._config.minSpreadAfterFees,
        easyBookAgeMs,
        hardBookAgeMs,
      });
      // Периодический INFO-лог: виден даже без auditMode
      if (this._tickCount % 50 === 1) {
        this._logger?.info('Arb no signal', {
          strategyId: this.id,
          easyAsk: easyLevels[0]?.price ?? null,
          hardDownAsk: hardLevels[0]?.price ?? null,
          bestPnlPerUnit: optimal?.pnlPerUnit?.toFixed(4) ?? null,
          minSpreadAfterFees: this._config.minSpreadAfterFees,
        });
      }
      return null;
    }

    return {
      pair: STUB_PAIR,
      detectedAtMs: Timestamp.of(new Decimal(nowMs)),
      depthLevels,
      optimalDepth: optimal,
      hardUpBestBid: 1 - (hardLevels[0]?.price ?? 1),
      easyUpBestAsk: easyLevels[0]?.price ?? 0,
      direction: 'UP',
    };
  }

  /**
   * Обрабатывает ArbitrageSignal от DivergenceDetector.
   *
   * @param signal - Сигнал расхождения (с оптимальной глубиной и PnL)
   * @param easyTopOfBook - TopOfBook easy рынка (для получения OutcomePrice VO)
   * @param nowMs - Текущее время
   * @param snapshot - Для portfolio/balance
   */
  private _onSignal(
    signal: ArbitrageSignal,
    nowMs: number,
    snapshot: StrategySnapshot | undefined,
    context: {
      readonly easyInstrumentId: InstrumentId;
      readonly hardInstrumentId: InstrumentId;
      readonly easyBookAgeMs: number | null;
      readonly hardBookAgeMs: number | null;
      readonly auditDepthLevels?: readonly ArbDepthAuditLevel[];
    },
  ): void {
    this._divergenceCount++;

    // Арбитраж гарантирует прибыль — покупаем на КАЖДОМ тике пока есть capacity.
    // Единственные ограничения: reject cooldown (биржа отклонила) и position capacity.
    if (this._lastRejectMs > 0 && nowMs - this._lastRejectMs < this._rejectCooldownMs) return;

    const optimal = signal.optimalDepth;
    const remainingCapacity = this._config.maxPositionUnits - this._currentPositionUnits;
    if (remainingCapacity < 1) {
      this._audit('SKIP_CAPACITY', nowMs, {
        currentPositionUnits: this._currentPositionUnits,
        maxPositionUnits: this._config.maxPositionUnits,
      });
      return;
    }

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

    if (size < 1) {
      this._audit('SKIP_BALANCE', nowMs, {
        costPerUnit: optimal.costPerUnit,
        feePerUnit: optimal.feePerUnit,
        pnlPerUnit: optimal.pnlPerUnit,
        available: snapshot?.portfolio?.balance.available().value().toNumber() ?? null,
      });
      return;
    }

    // Оптимистичное обновление позиции СИНХРОННО до async callback.
    // Предотвращает race condition: следующий тик видит актуальный capacity.
    // При reject — откатываем в callback.
    this._currentPositionUnits += size;

    // Цены для callback: ВСЕГДА (easyUpAsk, hardDownAsk).
    // Callback всегда BUY easy_Up + BUY hard_Down — единственная safe-комбинация.
    // Маппинг токенов в main.ts НЕ зависит от direction.
    const cbDirection = this.direction;

    // easyUpAsk = taker price покупки easy_Up.
    // hardDownAsk = taker price покупки hard_Down.
    const easyUpAsk = optimal.easyUpVwap;
    const hardDownAsk = 1 - optimal.hardUpVwap;

    const cbEasyPrice = OutcomePrice.of(new Decimal(easyUpAsk.toFixed(4)));
    const cbHardPrice = OutcomePrice.of(new Decimal(hardDownAsk.toFixed(4)));

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
      easyInstrumentId: String(context.easyInstrumentId),
      hardInstrumentId: String(context.hardInstrumentId),
      easyBookAgeMs: context.easyBookAgeMs,
      hardBookAgeMs: context.hardBookAgeMs,
      auditDepthLevels: context.auditDepthLevels,
    });

    this._audit('SIGNAL_ACCEPTED', nowMs, {
      assignment: this._assignment,
      easyInstrumentId: String(context.easyInstrumentId),
      hardInstrumentId: String(context.hardInstrumentId),
      easyPrice: easyUpAsk,
      hardPrice: hardDownAsk,
      costPerUnit: optimal.costPerUnit,
      feePerUnit: optimal.feePerUnit,
      pnlPerUnit: optimal.pnlPerUnit,
      depth: optimal.depth,
      size,
      easyBookAgeMs: context.easyBookAgeMs,
      hardBookAgeMs: context.hardBookAgeMs,
    });

    this._placeTrade({
      easyInstrumentId: context.easyInstrumentId,
      hardInstrumentId: context.hardInstrumentId,
      easyPrice: cbEasyPrice,
      hardPrice: cbHardPrice,
      size: Quantity.of(new Decimal(size)),
      direction: cbDirection,
      estimatedCostPerUnit: optimal.costPerUnit,
      estimatedFeePerUnit: optimal.feePerUnit,
      estimatedPnlPerUnit: optimal.pnlPerUnit,
      easyBookAgeMs: context.easyBookAgeMs,
      hardBookAgeMs: context.hardBookAgeMs,
      auditDepthLevels: context.auditDepthLevels,
    }, size, optimal.pnlPerUnit);
  }

  /**
   * Размещает обе ноги через callback.
   */
  private _placeTrade(plan: ArbTradePlan, size: number, pnlPerUnit: number): void {
    if (!this._onArbTradeNeeded) return;

    void this._onArbTradeNeeded(plan).then(report => {
      this._recordRepairState(report.repairState);
      if (report.unhedgedSize > 0) this._unhedgedExecutionCount++;
      if (report.repairState === 'FAILED_REPAIR') this._failedRepairCount++;

      if (report.accepted && report.balancedSize > 0) {
        const balancedSize = report.balancedSize;
        this._currentPositionUnits += balancedSize - size;
        this._tradeCount++;
        this._totalPnlEstimate += balancedSize * pnlPerUnit;
        this._acceptedPlannedCost += balancedSize * plan.estimatedCostPerUnit;
        this._acceptedPlannedFees += balancedSize * plan.estimatedFeePerUnit;
        this._acceptedSettlementFaceValue += balancedSize;
        this._actualNotional += report.actualNotional ?? 0;
        this._actualFees += report.actualFees ?? 0;
        this._actualConservativePnl += report.conservativePnl ?? 0;
        this._logger?.info('Arbitrage trade confirmed (both legs placed)', {
          plannedSize: size,
          balancedSize,
          easyFilledSize: report.easyFilledSize,
          hardFilledSize: report.hardFilledSize,
          repairState: report.repairState,
          pnlPerUnit: pnlPerUnit.toFixed(4),
          direction: plan.direction,
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

  private _getBookTimestampMs(instrumentId: InstrumentId, fallbackNowMs: number): number | undefined {
    return this._reader.getTopOfBookTimestampMs?.(instrumentId) ?? fallbackNowMs;
  }

  private _observeCandidate(observation: ArbCandidateObservation): void {
    this._freshEvaluationCount++;
    if (observation.costPerUnit < 1) this._grossCrossSampleCount++;
    if (observation.pnlPerUnit >= this._config.minSpreadAfterFees) this._netSignalSampleCount++;

    if (!this._bestObserved || observation.pnlPerUnit > this._bestObserved.pnlPerUnit) {
      this._bestObserved = observation;
    }
  }

  private _recordRepairState(state: ArbExecutionRepairState): void {
    this._repairStateCounts.set(state, (this._repairStateCounts.get(state) ?? 0) + 1);
  }

  private _audit(event: string, nowMs: number, data: Record<string, unknown>): void {
    this._auditEventCounts.set(event, (this._auditEventCounts.get(event) ?? 0) + 1);
    if (!this._config.auditMode) return;
    const throttleMs = this._config.auditThrottleMs ?? 5000;
    const throttleKey = this._auditThrottleKey(event, data);
    if (throttleMs > 0 && throttleKey) {
      const last = this._lastAuditLogMs.get(throttleKey);
      if (last !== undefined && nowMs - last < throttleMs) {
        this._suppressedAuditCount.set(
          throttleKey,
          (this._suppressedAuditCount.get(throttleKey) ?? 0) + 1,
        );
        return;
      }
      this._lastAuditLogMs.set(throttleKey, nowMs);
    }
    const suppressed = throttleKey ? (this._suppressedAuditCount.get(throttleKey) ?? 0) : 0;
    if (throttleKey && suppressed > 0) {
      this._suppressedAuditCount.set(throttleKey, 0);
    }
    this._logger?.info('Arb audit decision', {
      event,
      now: new Date(nowMs).toISOString(),
      strategyId: this.id,
      ...(suppressed > 0 ? { suppressedSinceLastLog: suppressed } : {}),
      ...data,
    });
  }

  private _auditThrottleKey(event: string, data: Record<string, unknown>): string | null {
    switch (event) {
      case 'SKIP_STALE_BOOK':
      case 'SKIP_MISSING_BOOK':
      case 'NO_SIGNAL':
      case 'SKIP_CAPACITY':
      case 'SKIP_BALANCE':
        return `${this.id}:${event}:${String(data['assignment'] ?? '')}`;
      default:
        return null;
    }
  }

  private _latestBookSnapshot(history: RollingWindow<Orderbook> | undefined): Orderbook | undefined {
    return history?.getLatest();
  }

  private _buildDepthAuditLevels(
    easySnapshot: Orderbook | undefined,
    hardDownSnapshot: Orderbook | undefined,
  ): readonly ArbDepthAuditLevel[] | undefined {
    const maxDepth = this._config.maxDepth ?? 1;
    if (maxDepth <= 1 || !easySnapshot || !hardDownSnapshot) return undefined;

    const easyLevels = snapshotAsksToNumeric(easySnapshot).slice(0, maxDepth);
    const hardLevels = snapshotAsksToNumeric(hardDownSnapshot).slice(0, maxDepth);
    const depth = Math.min(maxDepth, easyLevels.length, hardLevels.length);
    if (depth === 0) return undefined;

    const levels: ArbDepthAuditLevel[] = [];
    let cumEasySize = 0;
    let cumEasyNotional = 0;
    let cumHardSize = 0;
    let cumHardNotional = 0;

    for (let i = 0; i < depth; i++) {
      const easy = easyLevels[i];
      const hard = hardLevels[i];
      cumEasySize += easy.size;
      cumEasyNotional += easy.price * easy.size;
      cumHardSize += hard.size;
      cumHardNotional += hard.price * hard.size;

      const execSize = Math.min(cumEasySize, cumHardSize);
      if (execSize <= 0) continue;

      const easyUpVwap = cumEasyNotional / cumEasySize;
      const hardDownVwap = cumHardNotional / cumHardSize;
      const costPerUnit = easyUpVwap + hardDownVwap;
      const feePerUnit = this._feeCalc.pairFee(easyUpVwap, true, hardDownVwap, true, execSize) / execSize;
      const pnlPerUnit = 1 - costPerUnit - feePerUnit;

      levels.push({
        depth: i + 1,
        easyUpVwap,
        hardDownVwap,
        costPerUnit,
        feePerUnit,
        pnlPerUnit,
        execSize,
        totalPnl: pnlPerUnit * execSize,
      });
    }

    return levels;
  }

  stop(): StrategyStopIntent[] {
    this._logger?.info('CrossMarketArbStrategy stopping', {
      trades: this._tradeCount,
      divergences: this._divergenceCount,
      estimatedPnl: this._totalPnlEstimate.toFixed(2),
      assignment: this._assignment,
      freshEvaluations: this._freshEvaluationCount,
      grossCrossSamples: this._grossCrossSampleCount,
      netSignalSamples: this._netSignalSampleCount,
      bestObservedPnlPerUnit: this._bestObserved?.pnlPerUnit ?? null,
    });
    return [{ type: 'CANCEL_ALL' }];
  }

  getMetrics(): Record<string, unknown> {
    const best = this._bestObserved;
    return {
      tickCount: this._tickCount,
      divergenceCount: this._divergenceCount,
      tradeCount: this._tradeCount,
      totalPnlEstimate: this._totalPnlEstimate,
      acceptedPlannedCost: this._acceptedPlannedCost,
      acceptedPlannedFees: this._acceptedPlannedFees,
      acceptedPlannedAllInCost: this._acceptedPlannedCost + this._acceptedPlannedFees,
      acceptedSettlementFaceValue: this._acceptedSettlementFaceValue,
      actualNotional: this._actualNotional,
      actualFees: this._actualFees,
      actualConservativePnl: this._actualConservativePnl,
      unhedgedExecutionCount: this._unhedgedExecutionCount,
      failedRepairCount: this._failedRepairCount,
      repairStateCounts: Object.fromEntries(this._repairStateCounts.entries()),
      rejectCooldownActive: this._lastRejectMs > 0 && Date.now() - this._lastRejectMs < this._rejectCooldownMs,
      assignment: this._assignment,
      // Raw strikes доступны до установки assignment (показываем сразу после получения от Chainlink)
      slotStrike: this._config.slotStrike,
      peerStrike: this._config.peerStrike,
      currentPositionUnits: this._currentPositionUnits,
      bookStalenessMs: this._config.bookStalenessMs ?? 1500,
      auditMode: this._config.auditMode ?? false,
      freshEvaluations: this._freshEvaluationCount,
      grossCrossSamples: this._grossCrossSampleCount,
      netSignalSamples: this._netSignalSampleCount,
      auditEventCounts: Object.fromEntries(this._auditEventCounts.entries()),
      bestObserved: best
        ? {
            observedAt: new Date(best.observedAtMs).toISOString(),
            depth: best.depth,
            easyUpVwap: best.easyUpVwap,
            hardDownVwap: best.hardDownVwap,
            costPerUnit: best.costPerUnit,
            feePerUnit: best.feePerUnit,
            pnlPerUnit: best.pnlPerUnit,
            execSize: best.execSize,
            totalPnl: best.totalPnl,
            easyBookAgeMs: best.easyBookAgeMs,
            hardBookAgeMs: best.hardBookAgeMs,
          }
        : null,
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

function snapshotAsksToNumeric(snapshot: Orderbook): Array<{ price: number; size: number }> {
  return snapshot.asks
    .map(level => ({
      price: level.price.value().toNumber(),
      size: level.quantity.value().toNumber(),
    }))
    .filter(level => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
}

/**
 * Stub MarketPair для DivergenceDetector.detect().
 *
 * @remarks
 * Детектор не использует pair внутренне — только прокидывает в ArbitrageSignal.
 * Стратегия использует signal.optimalDepth, а не signal.pair.
 */
const STUB_ZERO_TIMESTAMP = Timestamp.of(new Decimal(0));
const STUB_PAIR = {
  easy: { asset: '', recurrence: '5m' as const, endDate: '', endEpochMs: STUB_ZERO_TIMESTAMP, instrumentId: '' as any, filePath: '' },
  hard: { asset: '', recurrence: '5m' as const, endDate: '', endEpochMs: STUB_ZERO_TIMESTAMP, instrumentId: '' as any, filePath: '' },
  pairType: 'live',
  overlapMs: 0,
};
