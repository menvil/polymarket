/**
 * CrossMarketBacktestEngine — бектест кросс-маркетного арбитража
 *
 * @remarks
 * Реплеит пары снапшот-файлов (easy + hard) синхронно по timestamp.
 * На каждом шаге обновляет соответствующий стакан и проверяет
 * наличие арбитражного расхождения через DivergenceDetector.
 *
 * ### Отличие от BacktestEngine:
 * - BacktestEngine работает с **одним** файлом и одной стратегией
 * - CrossMarketBacktestEngine работает с **парой** файлов одновременно
 * - Не использует EventBus, BookUpdateHandler, StrategyScheduler
 * - Вместо этого напрямую парсит ордербуки и прогоняет DivergenceDetector
 *
 * ### Поток данных:
 * ```
 * BacktestPairFinder.findPairs(snapshotDir)
 *   → MarketPair[] с filePath для easy и hard
 *     → для каждой пары:
 *       TimelineMerger.merge(easyFile, hardFile)
 *         → поток TaggedEvent (отсортирован по timestamp)
 *           → обновляем easyBook или hardBook
 *           → DivergenceDetector.detect(easyBook, hardBook)
 *           → если сигнал → записываем ArbitrageOpportunity
 * ```
 *
 * ### Формат результата:
 * Для каждой пары: количество расхождений, суммарный PnL, avg PnL,
 * длительность расхождений (сколько снапшотов подряд).
 *
 * @example
 * ```typescript
 * const engine = new CrossMarketBacktestEngine({
 *   snapshotDir: '/snapshots/2026-03-23',
 *   maxDepth: 5,
 *   feeModel: FEE_MODEL_CURRENT,
 * }, { logger });
 *
 * const result = await engine.run();
 * console.log(`Found ${result.totalSignals} arbitrage opportunities`);
 * console.log(`Total PnL: $${result.totalPnl.toFixed(2)}`);
 * ```
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILogger } from '@polymarket/logger';
import type { Timestamp } from '@polymarket/value-objects';
import {
  SnapshotReaderFactory,
} from '@polymarket/snapshot-readers';

import type {
  SimpleBook,
  NumericLevel,
  MarketPair,
  MarketInfo,
  ArbitrageSignal,
  DetectorConfig,
  FeeModel,
} from '@polymarket/cross-market';

import {
  MarketPairMatcher,
  DivergenceDetector,
  FEE_MODEL_CURRENT,
  DEFAULT_DETECTOR_CONFIG,
  RECURRENCE_RANK,
  OVERLAP_DURATION_MS,
} from '@polymarket/cross-market';
import type { RawSnapshotMeta } from '@polymarket/cross-market';

// ── Конфигурация ────────────────────────────────────────────────────────────

/**
 * Конфигурация кросс-маркетного бектеста.
 */
export interface CrossMarketBacktestConfig {
  /** Путь к директории снапшотов (структура: `dir/YYYY-MM-DD/*.jsonl(.gz)`) */
  readonly snapshotDir: string;
  /** Начальная дата включительно (YYYY-MM-DD) */
  readonly fromDate?: string;
  /** Конечная дата включительно (YYYY-MM-DD) */
  readonly toDate?: string;
  /** Максимальная глубина ордербука для анализа (default: 5) */
  readonly maxDepth?: number;
  /** Модель комиссий (default: current) */
  readonly feeModel?: FeeModel;
  /** Минимальный PnL per unit для генерации сигнала (default: 0.005) */
  readonly minSpreadAfterFees?: number;
  /** Фильтр по типам пар: ['5m-15m', '5m-hourly', '15m-hourly'] */
  readonly pairTypes?: string[];
  /** Фильтр по активам: ['BTC', 'ETH', 'SOL', 'XRP'] */
  readonly assets?: string[];
  /**
   * Gap tolerance в мс (default: 500).
   * Если расхождение пропадает менее чем на gapToleranceMs и возвращается —
   * считаем это одним окном (шум ордербука, а не реальное закрытие).
   */
  readonly gapToleranceMs?: number;
  /**
   * Минимальная latency исполнения в мс (default: 150).
   * Сделка совершается только если расхождение длится ≥ latencyMs.
   * Моделирует реальную задержку: обнаружение → отправка ордера → fill.
   */
  readonly latencyMs?: number;
  /**
   * Slippage per leg в ценовых единицах (default: 0).
   * Моделирует проскальзывание: easy_Up покупаем дороже, hard_Down покупаем дороже.
   * Реалистичные значения: 0.005 (100 units), 0.01 (200 units), 0.02 (500 units).
   */
  readonly slippagePerLeg?: number;
  /**
   * Максимальная разница между timestamp текущего события и последнего
   * snapshot второй книги (default: 1500).
   *
   * Если одна книга старее этого значения, сигнал не считается исполнимым:
   * это защита от ложного арбитража из-за рассинхрона snapshot streams.
   */
  readonly bookStalenessMs?: number;
  /** Включить fallback settlement по Chainlink в окне перед endDate (default: true). */
  readonly approxResolution?: boolean;
  /** Окно soft-resolution перед endDate в мс (default: 2000). */
  readonly approxResolutionWindowMs?: number;
}

/**
 * Зависимости CrossMarketBacktestEngine.
 */
export interface CrossMarketBacktestDeps {
  readonly logger: ILogger;
}

// ── Результаты ──────────────────────────────────────────────────────────────

/**
 * Одна зафиксированная арбитражная возможность.
 */
export interface ArbitrageOpportunity {
  /** Пара рынков */
  readonly pair: MarketPair;
  /** Первый сигнал (момент обнаружения) */
  readonly firstSignal: ArbitrageSignal;
  /** Количество последовательных снапшотов с расхождением */
  readonly consecutiveSnapshots: number;
  /** PnL при исполнении на первом снапшоте (оптимальная глубина) */
  readonly pnlAtEntry: number;
  /** Размер позиции при исполнении */
  readonly execSize: number;
}

/**
 * Результат по одной паре рынков.
 */
export interface PairResult {
  readonly pair: MarketPair;
  /** Всего снапшотов обработано */
  readonly totalSnapshots: number;
  /** Количество снапшотов с расхождением */
  readonly divergentSnapshots: number;
  /** Лучший сигнал (max pnlPerUnit) */
  readonly bestSignal: ArbitrageSignal | null;
  /** PnL при исполнении лучшего сигнала */
  readonly bestPnl: number;
  /** Средний PnL по всем расхождениям */
  readonly avgPnlPerUnit: number;
}

/**
 * Общий результат бектеста.
 */
export interface CrossMarketBacktestResult {
  /** Количество обработанных пар */
  readonly totalPairs: number;
  /** Количество пар с хотя бы одним расхождением */
  readonly pairsWithDivergence: number;
  /** Общее количество сигналов */
  readonly totalSignals: number;
  /** Суммарный PnL (если бы исполнили каждый лучший сигнал) */
  readonly totalPnl: number;
  /** Результаты по каждой паре */
  readonly pairResults: readonly PairResult[];
  /** Длительность выполнения в мс */
  readonly durationMs: number;
}

// ── Симуляция торговли ───────────────────────────────────────────────────────

/**
 * Окно возможности — непрерывная серия снапшотов с расхождением.
 *
 * @remarks
 * Когда `hard_Up_bid > easy_Up_ask` держится несколько снапшотов подряд,
 * это одно окно. Вход происходит на первом снапшоте окна.
 */
export interface OpportunityWindow {
  /** Timestamp первого расхождения в окне (epoch ms) */
  readonly startMs: number;
  /** Timestamp последнего расхождения в окне (epoch ms) */
  readonly endMs: number;
  /** Количество снапшотов с расхождением в окне */
  readonly snapshots: number;
  /** Длительность окна в мс (endMs - startMs) */
  readonly durationMs: number;
  /** Сигнал на первом снапшоте (момент входа) */
  readonly entrySignal: ArbitrageSignal;
  /** Лучший сигнал внутри окна (max pnlPerUnit) */
  readonly bestSignal: ArbitrageSignal;
}

/**
 * Результат settlement с учётом разницы strike-цен.
 *
 * @remarks
 * После strike-based assignment: easy = lower strike, hard = higher strike.
 * Payoff зависит от того, где финишировала цена актива:
 * - Ниже обоих strike'ов: lower_Up=LOSE, higher_Down=WIN → $1
 * - Между strike'ами: lower_Up=WIN, higher_Down=WIN → $2 (windfall!)
 * - Выше обоих strike'ов: lower_Up=WIN, higher_Down=LOSE → $1
 * Death zone ($0) невозможна после strike-based swap.
 */
export interface SettlementInfo {
  /** Strike-цена easy market (lower strike после swap) */
  readonly easyStrike: number | null;
  /** Strike-цена hard market (higher strike после swap) */
  readonly hardStrike: number | null;
  /** Цена актива в момент экспирации (из crypto_price событий) */
  readonly settlementPrice: number | null;
  /** Lower-strike Up-токен выиграл (цена >= easyStrike) */
  readonly easyUpWon: boolean | null;
  /** Higher-strike Up-токен выиграл (цена >= hardStrike) */
  readonly hardUpWon: boolean | null;
  /**
   * Payoff за одну пару:
   * - $2 = windfall (lower_Up WIN + higher_Down WIN, цена между strike'ами)
   * - $1 = safe (одна нога выиграла)
   * - null = не удалось определить (нет данных)
   * После strike-based swap $0 невозможен.
   */
  readonly payoffPerUnit: number | null;
  /**
   * Безопасны ли strike'ы: easy_strike ≤ hard_strike.
   * После strike-based swap всегда true.
   */
  readonly strikesSafe: boolean;
}

/**
 * Симулированная сделка (вход в арбитражную позицию).
 *
 * @remarks
 * Одна сделка = покупка easy_Up + покупка hard_Down.
 * Payoff при settlement зависит от strike-цен обоих рынков: $0, $1 или $2.
 * PnL = payoffPerUnit − costPerUnit × size.
 */
export interface SimulatedTrade {
  /** Номер сделки (1-based) */
  readonly tradeNumber: number;
  /** Timestamp входа (epoch ms) */
  readonly entryTimestampMs: number;
  /** Цена покупки easy_Up (taker) */
  readonly easyUpAskPrice: number;
  /** Цена покупки hard_Down = 1 − hard_Up_bid (maker) */
  readonly hardDownAskPrice: number;
  /** Суммарная стоимость одной пары: easyUpAsk + hardDownAsk */
  readonly costPerUnit: number;
  /** Комиссия на одну пару */
  readonly feePerUnit: number;
  /** P&L на одну пару: $1 − cost − fee */
  readonly pnlPerUnit: number;
  /** Размер позиции (ограничен балансом и ликвидностью) */
  readonly size: number;
  /** Общая стоимость входа: costPerUnit × size + fee × size */
  readonly totalCost: number;
  /** Гарантированный P&L: pnlPerUnit × size */
  readonly totalPnl: number;
  /** Глубина исполнения (depth level) */
  readonly depth: number;
  /** Окно, в котором произошла сделка */
  readonly windowIndex: number;
}

/**
 * Результат симуляции торговли по одной паре.
 *
 * @remarks
 * Включает детальный трейд-лог, окна возможностей и итоговый P&L.
 * Сделки совершаются на первом снапшоте каждого окна расхождения.
 * Все позиции держатся до settlement (endDate рынка).
 */
export interface PairSimulationResult {
  /** Пара рынков */
  readonly pair: MarketPair;
  /** Начальный баланс */
  readonly initialBalance: number;
  /** Конечный баланс (после settlement) */
  readonly finalBalance: number;
  /** Общий P&L: finalBalance − initialBalance */
  readonly totalPnl: number;
  /** ROI: totalPnl / initialBalance × 100 (%) */
  readonly roi: number;
  /** Всего снапшотов обработано */
  readonly totalSnapshots: number;
  /** Количество снапшотов с расхождением */
  readonly divergentSnapshots: number;
  /** Окна возможностей */
  readonly windows: readonly OpportunityWindow[];
  /** Список сделок */
  readonly trades: readonly SimulatedTrade[];
  /** Общее количество купленных пар */
  readonly totalUnits: number;
  /** Общая стоимость всех входов */
  readonly totalCost: number;
  /** Payoff при settlement: totalUnits × payoffPerUnit */
  readonly settlementPayoff: number;
  /** Информация о settlement: strike-цены, цена экспирации, payoff */
  readonly settlement: SettlementInfo;
  /** Длительность выполнения в мс */
  readonly durationMs: number;
}

/**
 * Результат симуляции с общим балансом (shared balance).
 *
 * @remarks
 * В отличие от `simulateAll`, где каждая пара получает свой баланс,
 * здесь один капитал recycled между парами по мере их settlement.
 * Капитал блокируется на момент входа и возвращается при settlement (endDate).
 */
export interface SharedBalanceSimulationResult {
  /** Начальный баланс */
  readonly initialBalance: number;
  /** Конечный баланс после всех settlement */
  readonly finalBalance: number;
  /** Общий P&L */
  readonly totalPnl: number;
  /** ROI: totalPnl / initialBalance × 100 (%) */
  readonly roi: number;
  /** Максимальный одновременно задействованный капитал */
  readonly peakCapitalUsed: number;
  /** Результаты по каждой паре */
  readonly pairResults: readonly PairSimulationResult[];
  /** Длительность выполнения в мс */
  readonly durationMs: number;
}

// ── Тегированное событие для merge ──────────────────────────────────────────

/**
 * Событие из одного файла, тегированное принадлежностью к ноге и токену.
 *
 * @remarks
 * Каждый рынок имеет два токена (Up и Down). Книги обоих токенов присутствуют
 * в файле снапшота. Поле `token` позволяет отличить книгу Up-токена от Down-токена,
 * чтобы детектор не сравнивал бид одного токена с аском другого.
 *
 * @internal
 */
interface TaggedBookEvent {
  readonly leg: 'easy' | 'hard';
  /** Какой токен представляет эта книга: Up-outcome или Down-outcome */
  readonly token: 'up' | 'down';
  readonly timestampMs: number;
  readonly bids: NumericLevel[];
  readonly asks: NumericLevel[];
}

// ── Реализация ──────────────────────────────────────────────────────────────

/**
 * Движок кросс-маркетного бектеста.
 */
export class CrossMarketBacktestEngine {
  private readonly _logger: ILogger;
  private readonly _detectorConfig: Partial<DetectorConfig>;

  constructor(
    private readonly _config: CrossMarketBacktestConfig,
    deps: CrossMarketBacktestDeps,
  ) {
    this._logger = deps.logger.child({ component: 'CrossMarketBacktestEngine' });
    this._detectorConfig = {
      maxDepth: _config.maxDepth ?? DEFAULT_DETECTOR_CONFIG.maxDepth,
      feeModel: _config.feeModel ?? FEE_MODEL_CURRENT,
      minSpreadAfterFees: _config.minSpreadAfterFees ?? DEFAULT_DETECTOR_CONFIG.minSpreadAfterFees,
    };
  }

  /**
   * Запускает бектест для двух конкретных файлов (easy + hard).
   *
   * @remarks
   * Читает meta-строку каждого файла для определения MarketInfo,
   * формирует MarketPair, и прогоняет анализ расхождений.
   * Удобно для быстрой проверки одной пары без сканирования директории.
   *
   * @param easyFilePath - Путь к файлу снапшотов easy-ноги (длинная duration)
   * @param hardFilePath - Путь к файлу снапшотов hard-ноги (короткая duration)
   * @returns Результат бектеста с одной парой
   * @throws {Error} Если файл не содержит meta-строки или пара не совместима
   *
   * @example
   * ```typescript
   * const result = await engine.runPair(
   *   '/snapshots/2026-03-23/Bitcoin_Up_or_Down_15m.jsonl.gz',
   *   '/snapshots/2026-03-23/Bitcoin_Up_or_Down_5m.jsonl.gz',
   * );
   * console.log(result.pairResults[0].divergentSnapshots);
   * ```
   */
  async runPair(easyFilePath: string, hardFilePath: string): Promise<CrossMarketBacktestResult> {
    const startTime = Date.now();

    const pair = await this._buildPairFromFiles(easyFilePath, hardFilePath);
    const detector = new DivergenceDetector(this._detectorConfig);
    const pairResult = await this._analyzePair(pair, detector);

    const durationMs = Date.now() - startTime;

    this._logger.info('CrossMarketBacktestEngine runPair finished', {
      divergentSnapshots: pairResult.divergentSnapshots,
      totalSnapshots: pairResult.totalSnapshots,
      bestPnl: pairResult.bestPnl.toFixed(2),
      durationMs,
    });

    return {
      totalPairs: 1,
      pairsWithDivergence: pairResult.divergentSnapshots > 0 ? 1 : 0,
      totalSignals: pairResult.divergentSnapshots,
      totalPnl: pairResult.bestPnl,
      pairResults: [pairResult],
      durationMs,
    };
  }

  /**
   * Симулирует торговлю по паре файлов с учётом баланса.
   *
   * @remarks
   * Алгоритм:
   * 1. Читаем и мёрджим два файла (как в runPair)
   * 2. Группируем расхождения в «окна возможностей» (consecutive divergent snapshots)
   * 3. На первом снапшоте каждого окна — входим в позицию:
   *    - BUY easy_Up (taker) + BUY hard_Down (maker)
   *    - Размер ограничен: min(ликвидность, доступный баланс / costPerUnit)
   * 4. Все позиции держим до settlement (endDate)
   * 5. На settlement: каждая пара гарантированно платит $1
   *
   * @param easyFilePath - Путь к файлу easy-ноги
   * @param hardFilePath - Путь к файлу hard-ноги
   * @param initialBalance - Начальный баланс в $ (default: 1000)
   * @returns Детальный результат симуляции с трейд-логом
   *
   * @example
   * ```typescript
   * const sim = await engine.simulatePair(
   *   '/snapshots/Bitcoin_15m.jsonl.gz',
   *   '/snapshots/Bitcoin_5m.jsonl.gz',
   *   1000,
   * );
   * for (const t of sim.trades) {
   *   console.log(`#${t.tradeNumber} @ ${new Date(t.entryTimestampMs).toISOString()}`);
   *   console.log(`  size=${t.size}, cost=$${t.totalCost.toFixed(2)}, pnl=$${t.totalPnl.toFixed(2)}`);
   * }
   * ```
   */
  async simulatePair(
    easyFilePath: string,
    hardFilePath: string,
    initialBalance: number = 1000,
  ): Promise<PairSimulationResult> {
    const gapTolerance = this._config.gapToleranceMs ?? 500;
    const latency = this._config.latencyMs ?? 150;
    const slippage = this._config.slippagePerLeg ?? 0;
    const pair = await this._buildPairFromFiles(easyFilePath, hardFilePath);
    const detector = new DivergenceDetector(this._detectorConfig);
    return this._simulatePairInternal(pair, detector, initialBalance, gapTolerance, latency, slippage);
  }

  /**
   * Внутренняя симуляция одной пары.
   *
   * @remarks
   * Алгоритм:
   * 1. Читаем оба файла, мёрджим по timestamp
   * 2. Strike-based swap: easy = lower strike, hard = higher strike (не по duration)
   * 3. Группируем дивергентные снапшоты в «окна» (gap tolerance)
   * 4. Входим после latency мс подтверждения расхождения
   * 5. Размер ограничен балансом и ликвидностью
   * 6. Все позиции → settlement → ≥$1 за пару (death zone невозможна после swap)
   */
  private async _simulatePairInternal(
    pair: MarketPair,
    detector: DivergenceDetector,
    initialBalance: number,
    gapTolerance: number,
    latency: number,
    slippagePerLeg: number = 0,
  ): Promise<PairSimulationResult> {
    const startTime = Date.now();
    const pairWithStrikes = await this._resolveMissingStrikes(pair);
    const strikePair = this._assignPairByStrike(pairWithStrikes);
    const bookStalenessMs = this._config.bookStalenessMs ?? 1500;

    // Читаем и мёрджим оба файла
    const easyEvents = await this._readBookEvents(strikePair.easy.filePath, 'easy');
    const hardEvents = await this._readBookEvents(strikePair.hard.filePath, 'hard');
    const merged = this._mergeTimelines(easyEvents, hardEvents);

    // Храним книги раздельно по токену: Up и Down для каждой ноги.
    // Детектор получает Up-книги: hardUpBook.bids[0] vs easyUpBook.asks[0].
    const emptyBook: SimpleBook = { bids: [], asks: [], timestampMs: 0 };
    let easyUpBook: SimpleBook = { ...emptyBook };
    let hardUpBook: SimpleBook = { ...emptyBook };

    let totalSnapshots = 0;
    let divergentSnapshots = 0;
    let balance = initialBalance;
    let totalUnits = 0;
    let totalCost = 0;

    const windows: OpportunityWindow[] = [];
    const trades: SimulatedTrade[] = [];

    // Состояние текущего окна
    let windowOpen = false;
    let windowStart = 0;
    let windowLastDivergentMs = 0;
    let windowSnaps = 0;
    let windowEntrySignal: ArbitrageSignal | null = null;
    let windowBestSignal: ArbitrageSignal | null = null;
    let windowTradeExecuted = false;

    const closeWindow = (): void => {
      if (windowOpen && windowEntrySignal && windowBestSignal) {
        windows.push({
          startMs: windowStart,
          endMs: windowLastDivergentMs,
          snapshots: windowSnaps,
          durationMs: windowLastDivergentMs - windowStart,
          entrySignal: windowEntrySignal,
          bestSignal: windowBestSignal,
        });
      }
      windowOpen = false;
      windowSnaps = 0;
      windowEntrySignal = null;
      windowBestSignal = null;
      windowTradeExecuted = false;
    };

    for (const event of merged) {
      // Обрабатываем только Up-токен — детектор сравнивает Up-книги обоих рынков.
      // Down-токен зеркален (hardDownAsk = 1 − hardUpBid), поэтому отдельная книга не нужна.
      if (event.token !== 'up') continue;

      const book: SimpleBook = {
        bids: event.bids,
        asks: event.asks,
        timestampMs: event.timestampMs,
      };

      if (event.leg === 'easy') {
        easyUpBook = book;
      } else {
        hardUpBook = book;
      }

      if (easyUpBook.timestampMs === 0 || hardUpBook.timestampMs === 0) continue;
      if (!this._isInLiveWindow(strikePair, event.timestampMs)) {
        closeWindow();
        continue;
      }
      if (!this._booksAreFresh(easyUpBook, hardUpBook, event.timestampMs, bookStalenessMs)) {
        closeWindow();
        continue;
      }

      totalSnapshots++;

      // После strike-based assignment только UP-направление нужно:
      // единственная safe сделка = BUY lowerStrike_Up + BUY higherStrike_Down
      const signal = detector.detect(easyUpBook, hardUpBook, strikePair, event.timestampMs);

      if (signal) {
        divergentSnapshots++;

        if (!windowOpen) {
          windowOpen = true;
          windowStart = event.timestampMs;
          windowEntrySignal = signal;
          windowBestSignal = signal;
          windowSnaps = 0;
          windowTradeExecuted = false;
        }

        windowLastDivergentMs = event.timestampMs;
        windowSnaps++;

        if (signal.optimalDepth.pnlPerUnit >
            (windowBestSignal?.optimalDepth.pnlPerUnit ?? 0)) {
          windowBestSignal = signal;
        }

        // Вход: окно длится ≥ latency, ещё не входили, есть баланс.
        // strikesSafe не нужен — после strike-based swap всегда безопасно.
        const windowAge = event.timestampMs - windowStart;
        if (windowAge >= latency && !windowTradeExecuted && balance > 0) {
          const opt = signal.optimalDepth;

          // Slippage: обе ноги покупаем дороже чем видели
          // easy_Up ask растёт, hard_Down ask (= 1 − hard_Up_bid) растёт
          const slippedEasyAsk = signal.easyUpBestAsk + slippagePerLeg;
          const slippedHardDownAsk = (1 - signal.hardUpBestBid) + slippagePerLeg;
          const slippedCostPerUnit = slippedEasyAsk + slippedHardDownAsk;
          // Fee пересчитываем по slipped цене
          const slippedFeePerUnit = opt.feePerUnit; // fee уже в opt, не зависит от slippage
          const slippedPnlPerUnit = 1 - slippedCostPerUnit - slippedFeePerUnit;

          // Если после slippage edge отрицательный — пропускаем
          if (slippedPnlPerUnit <= 0) continue;

          const costPerPair = slippedCostPerUnit + slippedFeePerUnit;
          if (costPerPair > 0) {
            const maxAffordable = Math.floor(balance / costPerPair);
            const size = Math.min(opt.execSize, maxAffordable);

            if (size > 0) {
              const tradeCost = size * costPerPair;
              const tradePnl = size * slippedPnlPerUnit;

              balance -= tradeCost;
              totalUnits += size;
              totalCost += tradeCost;

              trades.push({
                tradeNumber: trades.length + 1,
                entryTimestampMs: event.timestampMs,
                easyUpAskPrice: slippedEasyAsk,
                hardDownAskPrice: slippedHardDownAsk,
                costPerUnit: slippedCostPerUnit,
                feePerUnit: slippedFeePerUnit,
                pnlPerUnit: slippedPnlPerUnit,
                size,
                totalCost: tradeCost,
                totalPnl: tradePnl,
                depth: opt.depth,
                windowIndex: windows.length,
              });
              windowTradeExecuted = true;
            }
          }
        }
      } else {
        if (windowOpen) {
          const gapMs = event.timestampMs - windowLastDivergentMs;
          if (gapMs > gapTolerance) {
            closeWindow();
          }
        }
      }
    }

    closeWindow();

    const settlement = await this._computeSettlement(strikePair);

    const payoffPerUnit = settlement.payoffPerUnit ?? 1; // fallback $1 если нет данных
    const settlementPayoff = totalUnits * payoffPerUnit;
    const finalBalance = balance + settlementPayoff;
    const totalPnl = finalBalance - initialBalance;
    const roi = initialBalance > 0 ? (totalPnl / initialBalance) * 100 : 0;

    const durationMs = Date.now() - startTime;

    return {
      pair: strikePair,
      initialBalance,
      finalBalance,
      totalPnl,
      roi,
      totalSnapshots,
      divergentSnapshots,
      windows,
      trades,
      totalUnits,
      totalCost,
      settlementPayoff,
      settlement,
      durationMs,
    };
  }

  /**
   * Симулирует торговлю по всем парам в директории.
   *
   * @remarks
   * Для каждой найденной пары запускает simulatePair-логику:
   * gap tolerance, latency, ограничение по балансу.
   * Баланс выделяется каждой паре **независимо** (не shared).
   *
   * @param initialBalancePerPair - Баланс на каждую пару (default: 1000)
   * @returns Массив результатов симуляции по всем парам
   */
  async simulateAll(initialBalancePerPair: number = 1000): Promise<PairSimulationResult[]> {
    const startTime = Date.now();
    const gapTolerance = this._config.gapToleranceMs ?? 500;
    const latency = this._config.latencyMs ?? 150;
    const slippage = this._config.slippagePerLeg ?? 0;

    this._logger.info('simulateAll starting', {
      snapshotDir: this._config.snapshotDir,
      gapToleranceMs: gapTolerance,
      latencyMs: latency,
      slippagePerLeg: slippage,
      bookStalenessMs: this._config.bookStalenessMs ?? 1500,
      balancePerPair: initialBalancePerPair,
    });

    // Индексируем и находим пары
    const markets = await this._indexMarkets();
    const matcher = new MarketPairMatcher();
    let pairs = matcher.findPairs(markets);

    if (this._config.pairTypes) {
      const allowed = new Set(this._config.pairTypes);
      pairs = pairs.filter(p => allowed.has(p.pairType));
    }
    if (this._config.assets) {
      const allowed = new Set(this._config.assets);
      pairs = pairs.filter(p => allowed.has(p.easy.asset));
    }

    this._logger.info('Pairs found for simulation', { count: pairs.length });

    const detector = new DivergenceDetector(this._detectorConfig);
    const results: PairSimulationResult[] = [];

    for (const pair of pairs) {
      const sim = await this._simulatePairInternal(pair, detector, initialBalancePerPair, gapTolerance, latency, slippage);
      results.push(sim);
    }

    const elapsed = Date.now() - startTime;
    const withTrades = results.filter(r => r.trades.length > 0);
    const totalPnl = results.reduce((s, r) => s + r.totalPnl, 0);

    this._logger.info('simulateAll finished', {
      totalPairs: pairs.length,
      pairsWithTrades: withTrades.length,
      totalPnl: totalPnl.toFixed(2),
      durationMs: elapsed,
    });

    return results;
  }

  /**
   * Симулирует торговлю с общим балансом, recycled между парами.
   *
   * @remarks
   * Алгоритм:
   * 1. Пары отсортированы по endEpochMs (момент settlement)
   * 2. Для каждой пары перед симуляцией:
   *    a. Освобождаем капитал от пар, которые уже settled (endEpochMs прошёл)
   *    b. Выделяем доступный баланс этой паре
   * 3. После симуляции: блокируем потраченный капитал до settlement
   * 4. При settlement: капитал + payoff возвращается в общий пул
   *
   * Это моделирует реальное поведение: один аккаунт, капитал крутится.
   *
   * @param initialBalance - Начальный баланс аккаунта
   * @returns Результат с общим P&L и ROI от начального баланса
   *
   * @example
   * ```typescript
   * const result = await engine.simulateAllSharedBalance(10_000);
   * console.log(`ROI: ${result.roi.toFixed(2)}%`);
   * ```
   */
  async simulateAllSharedBalance(initialBalance: number): Promise<SharedBalanceSimulationResult> {
    const startTime = Date.now();
    const gapTolerance = this._config.gapToleranceMs ?? 500;
    const latency = this._config.latencyMs ?? 150;
    const slippage = this._config.slippagePerLeg ?? 0;

    this._logger.info('simulateAllSharedBalance starting', {
      snapshotDir: this._config.snapshotDir,
      initialBalance,
      gapToleranceMs: gapTolerance,
      latencyMs: latency,
      slippagePerLeg: slippage,
      bookStalenessMs: this._config.bookStalenessMs ?? 1500,
    });

    // Индексируем и находим пары
    const markets = await this._indexMarkets();
    const matcher = new MarketPairMatcher();
    let pairs = matcher.findPairs(markets);

    if (this._config.pairTypes) {
      const allowed = new Set(this._config.pairTypes);
      pairs = pairs.filter(p => allowed.has(p.pairType));
    }
    if (this._config.assets) {
      const allowed = new Set(this._config.assets);
      pairs = pairs.filter(p => allowed.has(p.easy.asset));
    }

    this._logger.info('Pairs found for shared simulation', { count: pairs.length });

    const detector = new DivergenceDetector(this._detectorConfig);
    const results: PairSimulationResult[] = [];

    // Общий баланс и блокировки
    let availableBalance = initialBalance;
    let peakCapitalUsed = 0;

    // Блокировки: капитал заблокирован до endEpochMs, с payoff при settlement
    const locks: Array<{
      readonly endEpochMs: number;
      readonly costLocked: number;
      readonly payoff: number;
    }> = [];

    // Пары уже отсортированы по endEpochMs (из findPairs)
    for (const pair of pairs) {
      // Overlap начинается за overlapMs до endDate.
      // Освобождаем капитал от пар, settled до начала overlap текущей пары.
      const overlapStartMs = pair.easy.endEpochMs.toNumber() - pair.overlapMs;

      let released = 0;
      const remaining: typeof locks = [];
      for (const lock of locks) {
        if (lock.endEpochMs <= overlapStartMs) {
          // Settled: возвращаем payoff
          availableBalance += lock.payoff;
          released++;
        } else {
          remaining.push(lock);
        }
      }
      locks.length = 0;
      locks.push(...remaining);

      if (released > 0) {
        this._logger.debug('Released settled capital', {
          released,
          availableBalance: availableBalance.toFixed(2),
        });
      }

      // Отслеживаем пиковое использование капитала
      const currentlyLocked = locks.reduce((s, l) => s + l.costLocked, 0);
      peakCapitalUsed = Math.max(peakCapitalUsed, currentlyLocked);

      // Симулируем с доступным балансом
      const sim = await this._simulatePairInternal(
        pair, detector, availableBalance, gapTolerance, latency, slippage,
      );
      results.push(sim);

      // Блокируем потраченный капитал
      if (sim.totalCost > 0) {
        availableBalance -= sim.totalCost;
        locks.push({
          endEpochMs: pair.easy.endEpochMs.toNumber(),
          costLocked: sim.totalCost,
          payoff: sim.settlementPayoff,
        });
        peakCapitalUsed = Math.max(
          peakCapitalUsed,
          locks.reduce((s, l) => s + l.costLocked, 0),
        );
      }
    }

    // Освобождаем все оставшиеся блокировки
    for (const lock of locks) {
      availableBalance += lock.payoff;
    }

    const finalBalance = availableBalance;
    const totalPnl = finalBalance - initialBalance;
    const roi = initialBalance > 0 ? (totalPnl / initialBalance) * 100 : 0;
    const elapsed = Date.now() - startTime;

    const withTrades = results.filter(r => r.trades.length > 0);

    this._logger.info('simulateAllSharedBalance finished', {
      totalPairs: pairs.length,
      pairsWithTrades: withTrades.length,
      initialBalance: initialBalance.toFixed(2),
      finalBalance: finalBalance.toFixed(2),
      totalPnl: totalPnl.toFixed(2),
      roi: roi.toFixed(2),
      peakCapitalUsed: peakCapitalUsed.toFixed(2),
      durationMs: elapsed,
    });

    return {
      initialBalance,
      finalBalance,
      totalPnl,
      roi,
      peakCapitalUsed,
      pairResults: results,
      durationMs: elapsed,
    };
  }

  /**
   * Запускает кросс-маркетный бектест по всей директории.
   *
   * @remarks
   * Алгоритм:
   * 1. Сканируем директорию — читаем meta каждого файла
   * 2. MarketPairMatcher.findPairs() — находим все пары
   * 3. Для каждой пары:
   *    a. Параллельно читаем оба файла, собираем book events
   *    b. Merge по timestamp
   *    c. На каждом шаге: обновляем стакан, проверяем расхождение
   * 4. Агрегируем результаты
   *
   * @returns Результат бектеста
   */
  async run(): Promise<CrossMarketBacktestResult> {
    const startTime = Date.now();

    this._logger.info('CrossMarketBacktestEngine starting', {
      snapshotDir: this._config.snapshotDir,
    });

    // Шаг 1: Индексируем все файлы
    const markets = await this._indexMarkets();
    this._logger.info('Markets indexed', { count: markets.length });

    // Шаг 2: Находим пары
    const matcher = new MarketPairMatcher();
    let pairs = matcher.findPairs(markets);

    // Фильтрация по типам пар
    if (this._config.pairTypes) {
      const allowed = new Set(this._config.pairTypes);
      pairs = pairs.filter(p => allowed.has(p.pairType));
    }

    // Фильтрация по активам
    if (this._config.assets) {
      const allowed = new Set(this._config.assets);
      pairs = pairs.filter(p => allowed.has(p.easy.asset));
    }

    this._logger.info('Pairs found', { count: pairs.length });

    // Шаг 3: Анализируем каждую пару
    const detector = new DivergenceDetector(this._detectorConfig);
    const pairResults: PairResult[] = [];

    for (const pair of pairs) {
      const result = await this._analyzePair(pair, detector);
      pairResults.push(result);
    }

    // Шаг 4: Агрегация
    const pairsWithDiv = pairResults.filter(r => r.divergentSnapshots > 0);
    const totalSignals = pairResults.reduce((sum, r) => sum + r.divergentSnapshots, 0);
    const totalPnl = pairResults.reduce((sum, r) => sum + r.bestPnl, 0);

    const durationMs = Date.now() - startTime;

    this._logger.info('CrossMarketBacktestEngine finished', {
      totalPairs: pairs.length,
      pairsWithDivergence: pairsWithDiv.length,
      totalSignals,
      totalPnl: totalPnl.toFixed(2),
      durationMs,
    });

    return {
      totalPairs: pairs.length,
      pairsWithDivergence: pairsWithDiv.length,
      totalSignals,
      totalPnl,
      pairResults,
      durationMs,
    };
  }

  /**
   * Строит MarketPair из двух файлов, автоматически определяя easy/hard.
   */
  private async _buildPairFromFiles(easyFilePath: string, hardFilePath: string): Promise<MarketPair> {
    this._logger.info('Building pair from files', { easyFile: easyFilePath, hardFile: hardFilePath });

    const easyInfo = await this._readMeta(easyFilePath);
    const hardInfo = await this._readMeta(hardFilePath);

    if (!easyInfo) throw new Error(`No meta found in file: ${easyFilePath}`);
    if (!hardInfo) throw new Error(`No meta found in file: ${hardFilePath}`);

    // Определяем кто easy, кто hard по RECURRENCE_RANK
    const easyRank = RECURRENCE_RANK[easyInfo.recurrence];
    const hardRank = RECURRENCE_RANK[hardInfo.recurrence];

    let actualEasy = easyInfo;
    let actualHard = hardInfo;

    if (easyRank > hardRank) {
      actualEasy = hardInfo;
      actualHard = easyInfo;
      this._logger.info('Swapped easy/hard based on recurrence rank', {
        easy: actualEasy.recurrence,
        hard: actualHard.recurrence,
      });
    }

    const pairType = `${actualHard.recurrence}-${actualEasy.recurrence}`;
    return {
      easy: actualEasy,
      hard: actualHard,
      pairType,
      overlapMs: OVERLAP_DURATION_MS[pairType] ?? 0,
    };
  }

  /**
   * Индексирует все файлы в директории снапшотов.
   * Читает только meta-строку каждого файла для извлечения asset/recurrence/endDate.
   */
  private async _indexMarkets(): Promise<MarketInfo[]> {
    const files = this._scanSnapshotFiles();
    const readerFactory = new SnapshotReaderFactory(this._logger);
    const markets: MarketInfo[] = [];

    for (const filePath of files) {
      const reader = readerFactory.create(filePath);
      try {
        for await (const line of reader.readLines()) {
          let raw: Record<string, unknown>;
          try {
            raw = JSON.parse(line) as Record<string, unknown>;
          } catch {
            break;
          }

          if (raw['t'] === 'meta') {
            const info = MarketPairMatcher.parseSnapshotMeta(
              raw as unknown as RawSnapshotMeta,
              filePath,
            );
            if (info) markets.push(info);
          }
          break; // Читаем только первую строку
        }
      } finally {
        await reader.close();
      }
    }

    return markets;
  }

  private _scanSnapshotFiles(): string[] {
    const root = this._config.snapshotDir;
    if (!root || !fs.existsSync(root)) return [];

    const dateDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name)
      .filter(date => {
        if (this._config.fromDate && date < this._config.fromDate) return false;
        if (this._config.toDate && date > this._config.toDate) return false;
        return true;
      })
      .sort();

    const files: string[] = [];
    for (const date of dateDirs) {
      const datePath = path.join(root, date);
      this._collectJsonlFiles(datePath, files);
      const polymarketPath = path.join(datePath, 'polymarket');
      if (fs.existsSync(polymarketPath)) {
        this._collectJsonlFiles(polymarketPath, files);
      }
    }

    return files.sort();
  }

  private _collectJsonlFiles(dir: string, out: string[]): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.jsonl.gz')) continue;
      out.push(path.join(dir, entry.name));
    }
  }

  /**
   * Читает meta-строку из файла снапшота и возвращает MarketInfo.
   *
   * @param filePath - Путь к NDJSON (.jsonl или .jsonl.gz) файлу
   * @returns MarketInfo или null, если meta не найдена / не распознана
   */
  private async _readMeta(filePath: string): Promise<MarketInfo | null> {
    const readerFactory = new SnapshotReaderFactory(this._logger);
    const reader = readerFactory.create(filePath);
    try {
      for await (const line of reader.readLines()) {
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
        if (raw['t'] === 'meta') {
          return MarketPairMatcher.parseSnapshotMeta(
            raw as unknown as RawSnapshotMeta,
            filePath,
          ) ?? null;
        }
        return null; // Первая строка не meta
      }
    } finally {
      await reader.close();
    }
    return null;
  }

  /**
   * Нормализует пару для стратегии: easy = lower strike, hard = higher strike.
   *
   * До момента появления обоих strike'ов live-бот не должен торговать; в backtest
   * при отсутствующем priceToBeat оставляем duration order, чтобы не ломать
   * диагностические прогоны старых snapshot'ов.
   */
  private _assignPairByStrike(pair: MarketPair): MarketPair {
    const easyStrike = pair.easy.priceToBeat;
    const hardStrike = pair.hard.priceToBeat;
    if (easyStrike === undefined || hardStrike === undefined) return pair;
    if (easyStrike <= hardStrike) return pair;

    this._logger.debug('Swapping pair legs by strike', {
      pairType: pair.pairType,
      endDate: pair.easy.endDate,
      easyRecurrenceBefore: pair.easy.recurrence,
      hardRecurrenceBefore: pair.hard.recurrence,
      easyStrikeBefore: easyStrike.toFixed(2),
      hardStrikeBefore: hardStrike.toFixed(2),
    });

    return {
      easy: pair.hard,
      hard: pair.easy,
      pairType: pair.pairType,
      overlapMs: pair.overlapMs,
    };
  }

  private async _resolveMissingStrikes(pair: MarketPair): Promise<MarketPair> {
    const [easy, hard] = await Promise.all([
      this._resolveMarketStrike(pair.easy),
      this._resolveMarketStrike(pair.hard),
    ]);
    if (easy === pair.easy && hard === pair.hard) return pair;
    return { ...pair, easy, hard };
  }

  private async _resolveMarketStrike(market: MarketInfo): Promise<MarketInfo> {
    if (market.priceToBeat !== undefined) return market;
    if (market.startEpochMs === undefined) return market;

    const startEpochMs = market.startEpochMs.toNumber();
    const restored = await this._readChainlinkPriceAtOrBefore(
      market.filePath,
      startEpochMs,
    );
    if (restored === null) return market;

    this._logger.debug('Strike restored from Chainlink snapshot history', {
      asset: market.asset,
      recurrence: market.recurrence,
      endDate: market.endDate,
      startTime: new Date(startEpochMs).toISOString(),
      strikePrice: restored.price.toFixed(2),
      source: restored.source,
      priceTs: new Date(restored.timestampMs).toISOString(),
      ageMs: startEpochMs - restored.timestampMs,
    });

    return {
      ...market,
      priceToBeat: restored.price,
    };
  }

  /**
   * Восстанавливает strike по Chainlink history внутри snapshot-файла.
   *
   * Основной режим: последняя Chainlink цена с `ts <= startTime`.
   * Fallback нужен для старых/неполных файлов, где запись могла начаться чуть
   * после открытия: берём ближайшую Chainlink цену к startTime.
   */
  private async _readChainlinkPriceAtOrBefore(
    filePath: string,
    targetMs: number,
  ): Promise<{ price: number; timestampMs: number; source: 'at-or-before' | 'nearest' } | null> {
    const readerFactory = new SnapshotReaderFactory(this._logger);
    const reader = readerFactory.create(filePath);
    let lastAtOrBefore: { price: number; timestampMs: number } | null = null;
    let nearest: { price: number; timestampMs: number } | null = null;

    try {
      for await (const line of reader.readLines()) {
        if (!line.includes('crypto_price')) continue;

        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (raw['t'] !== 'crypto_price') continue;
        if (raw['source'] !== 'chainlink') continue;
        if (typeof raw['price'] !== 'number' || !Number.isFinite(raw['price'])) continue;

        const tsRaw = raw['ts'];
        const timestampMs = typeof tsRaw === 'number' ? tsRaw : Number(tsRaw);
        if (!Number.isFinite(timestampMs)) continue;

        const point = { price: raw['price'], timestampMs };
        if (timestampMs <= targetMs) {
          if (lastAtOrBefore === null || timestampMs > lastAtOrBefore.timestampMs) {
            lastAtOrBefore = point;
          }
        }
        if (nearest === null || Math.abs(timestampMs - targetMs) < Math.abs(nearest.timestampMs - targetMs)) {
          nearest = point;
        }
      }
    } finally {
      await reader.close();
    }

    if (lastAtOrBefore !== null) {
      return { ...lastAtOrBefore, source: 'at-or-before' };
    }
    if (nearest !== null) {
      return { ...nearest, source: 'nearest' };
    }
    return null;
  }

  private _isInLiveWindow(pair: MarketPair, timestampMs: number): boolean {
    const easyEndMs = pair.easy.endEpochMs.toNumber();
    const hardEndMs = pair.hard.endEpochMs.toNumber();
    const knownStarts = [pair.easy.startEpochMs, pair.hard.startEpochMs]
      .filter((v): v is Timestamp => v !== undefined)
      .map((v) => v.toNumber())
      .filter((v) => Number.isFinite(v));
    const liveStartMs = knownStarts.length > 0
      ? Math.max(...knownStarts)
      : Math.min(easyEndMs, hardEndMs) - pair.overlapMs;
    const liveEndMs = Math.min(easyEndMs, hardEndMs);
    return timestampMs >= liveStartMs && timestampMs <= liveEndMs;
  }

  private _booksAreFresh(
    easyBook: SimpleBook,
    hardBook: SimpleBook,
    nowMs: number,
    bookStalenessMs: number,
  ): boolean {
    return nowMs - easyBook.timestampMs <= bookStalenessMs &&
      nowMs - hardBook.timestampMs <= bookStalenessMs;
  }

  /**
   * Анализирует одну пару рынков: читает оба файла, ищет расхождения.
   */
  private async _analyzePair(
    pair: MarketPair,
    detector: DivergenceDetector,
  ): Promise<PairResult> {
    const pairWithStrikes = await this._resolveMissingStrikes(pair);
    const strikePair = this._assignPairByStrike(pairWithStrikes);
    const bookStalenessMs = this._config.bookStalenessMs ?? 1500;

    // Читаем book events из обоих файлов
    const easyEvents = await this._readBookEvents(strikePair.easy.filePath, 'easy');
    const hardEvents = await this._readBookEvents(strikePair.hard.filePath, 'hard');

    // Merge по timestamp
    const merged = this._mergeTimelines(easyEvents, hardEvents);

    // Прогоняем детектор — используем только Up-книги обоих рынков
    const emptyBook: SimpleBook = { bids: [], asks: [], timestampMs: 0 };
    let easyUpBook: SimpleBook = { ...emptyBook };
    let hardUpBook: SimpleBook = { ...emptyBook };

    let totalSnapshots = 0;
    let divergentSnapshots = 0;
    let bestSignal: ArbitrageSignal | null = null;
    let bestPnl = 0;
    let sumPnlPerUnit = 0;

    for (const event of merged) {
      // Фильтруем: только Up-токен
      if (event.token !== 'up') continue;

      const book: SimpleBook = {
        bids: event.bids,
        asks: event.asks,
        timestampMs: event.timestampMs,
      };

      if (event.leg === 'easy') {
        easyUpBook = book;
      } else {
        hardUpBook = book;
      }

      // Проверяем только когда оба стакана инициализированы
      if (easyUpBook.timestampMs === 0 || hardUpBook.timestampMs === 0) continue;
      if (!this._isInLiveWindow(strikePair, event.timestampMs)) continue;
      if (!this._booksAreFresh(easyUpBook, hardUpBook, event.timestampMs, bookStalenessMs)) continue;

      totalSnapshots++;

      // После strike-based assignment только UP нужен
      const signal = detector.detect(easyUpBook, hardUpBook, strikePair, event.timestampMs);
      if (signal) {
        divergentSnapshots++;
        sumPnlPerUnit += signal.optimalDepth.pnlPerUnit;

        if (signal.optimalDepth.totalPnl > bestPnl) {
          bestPnl = signal.optimalDepth.totalPnl;
          bestSignal = signal;
        }
      }
    }

    return {
      pair: strikePair,
      totalSnapshots,
      divergentSnapshots,
      bestSignal,
      bestPnl,
      avgPnlPerUnit: divergentSnapshots > 0 ? sumPnlPerUnit / divergentSnapshots : 0,
    };
  }

  /**
   * Вычисляет реальный payoff при settlement с учётом разницы strike-цен.
   *
   * @remarks
   * Алгоритм:
   * 1. Берём priceToBeat (strike) из MarketInfo обеих ног
   * 2. Пара уже нормализована: easy = lower strike, hard = higher strike
   * 3. Берём finalPrice из meta или soft-resolution Chainlink price
   *    из окна `[endDate - 2000ms, endDate)`
   * 4. Payoff = (lowerStrike_Up_won ? 1 : 0) + (higherStrike_Up_won ? 0 : 1)
   *    - $2 = windfall (цена между strike'ами: lower_Up WIN + higher_Down WIN)
   *    - $1 = safe (обе ноги в одну сторону)
   *    - $0 = невозможно после strike-based swap (lower ≤ higher всегда)
   *
   * @param pair - Пара рынков
   * @returns Информация о settlement
   */
  private async _computeSettlement(pair: MarketPair): Promise<SettlementInfo> {
    const easyStrike = pair.easy.priceToBeat ?? null;
    const hardStrike = pair.hard.priceToBeat ?? null;

    if (easyStrike === null || hardStrike === null) {
      this._logger.debug('Missing priceToBeat, assuming $1 payoff', {
        easyStrike, hardStrike, pairType: pair.pairType,
      });
      return {
        easyStrike, hardStrike,
        settlementPrice: null, easyUpWon: null, hardUpWon: null,
        payoffPerUnit: null,
        strikesSafe: true,
      };
    }

    // После strike-based swap easy всегда имеет lower strike → всегда safe
    const strikesSafe = easyStrike <= hardStrike;

    const settlementPrice = pair.easy.finalPrice ?? pair.hard.finalPrice ??
      (this._config.approxResolution === false
        ? null
        : await this._readSoftSettlementPrice(pair));

    if (settlementPrice === null) {
      this._logger.debug('No finalPrice/soft Chainlink resolution found, assuming $1 payoff', {
        easyFile: pair.easy.filePath,
        hardFile: pair.hard.filePath,
        endDate: pair.easy.endDate,
      });
      return {
        easyStrike, hardStrike,
        settlementPrice: null, easyUpWon: null, hardUpWon: null,
        payoffPerUnit: null,
        strikesSafe,
      };
    }

    // Мы держим lowerStrike_Up + higherStrike_Down (после strike-based swap)
    const lowerUpWon = settlementPrice >= easyStrike;
    const higherUpWon = settlementPrice >= hardStrike;

    const lowerUpPayoff = lowerUpWon ? 1 : 0;
    const higherDownPayoff = higherUpWon ? 0 : 1;
    const payoffPerUnit = lowerUpPayoff + higherDownPayoff;

    this._logger.debug('Settlement computed', {
      easyStrike: easyStrike.toFixed(2),
      hardStrike: hardStrike.toFixed(2),
      settlementPrice: settlementPrice.toFixed(2),
      lowerUpWon, higherUpWon,
      payoffPerUnit,
      strikesSafe,
    });

    return {
      easyStrike, hardStrike, settlementPrice,
      easyUpWon: lowerUpWon, hardUpWon: higherUpWon, payoffPerUnit,
      strikesSafe,
    };
  }

  /**
   * Читает soft-resolution Chainlink price для пары.
   *
   * @remarks
   * Повторяет fallback из analyze-crowd-calibration:
   * берём последний Chainlink sample строго в окне `[endDate - windowMs, endDate)`.
   * Если в окне нет sample — не угадываем resolution.
   *
   * @returns Цена или null если не найдена
   */
  private async _readSoftSettlementPrice(pair: MarketPair): Promise<number | null> {
    const windowMs = this._config.approxResolutionWindowMs ?? 2_000;
    const endMs = Math.min(pair.easy.endEpochMs.toNumber(), pair.hard.endEpochMs.toNumber());
    const easy = await this._readLastChainlinkPriceInWindow(pair.easy.filePath, endMs - windowMs, endMs);
    const hard = await this._readLastChainlinkPriceInWindow(pair.hard.filePath, endMs - windowMs, endMs);
    const best = [easy, hard]
      .filter((p): p is { price: number; timestampMs: number } => p !== null)
      .sort((a, b) => b.timestampMs - a.timestampMs)[0];
    return best?.price ?? null;
  }

  private async _readLastChainlinkPriceInWindow(
    filePath: string,
    fromInclusiveMs: number,
    toExclusiveMs: number,
  ): Promise<{ price: number; timestampMs: number } | null> {
    const readerFactory = new SnapshotReaderFactory(this._logger);
    const reader = readerFactory.create(filePath);
    let best: { price: number; timestampMs: number } | null = null;

    try {
      for await (const line of reader.readLines()) {
        if (!line.includes('crypto_price')) continue;

        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (raw['t'] !== 'crypto_price') continue;
        if (raw['source'] !== 'chainlink') continue;
        if (typeof raw['price'] !== 'number' || !Number.isFinite(raw['price'])) continue;
        const timestampMs = typeof raw['ts'] === 'number' ? raw['ts'] : Number(raw['ts']);
        if (!Number.isFinite(timestampMs)) continue;
        if (timestampMs < fromInclusiveMs || timestampMs >= toExclusiveMs) continue;
        if (!best || timestampMs > best.timestampMs) best = { price: raw['price'], timestampMs };
      }
    } finally {
      await reader.close();
    }

    return best;
  }

  /**
   * Читает все book events из файла и конвертирует в NumericLevel[].
   *
   * @remarks
   * Каждый файл содержит книги двух токенов (Up и Down). Метод читает meta-строку
   * для определения Up-токена (tokenIds[0]), и тегирует каждое событие полем `token`.
   * Это позволяет вызывающему коду фильтровать по типу токена и не смешивать книги.
   *
   * @param filePath - Путь к NDJSON файлу снапшота
   * @param leg - Принадлежность к ноге (easy/hard)
   * @returns Массив тегированных книжных событий с полем token
   */
  private async _readBookEvents(
    filePath: string,
    leg: 'easy' | 'hard',
  ): Promise<TaggedBookEvent[]> {
    const readerFactory = new SnapshotReaderFactory(this._logger);
    const reader = readerFactory.create(filePath);
    const events: TaggedBookEvent[] = [];
    let upTokenId: string | null = null;

    try {
      for await (const line of reader.readLines()) {
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        // Извлекаем Up-токен из meta-строки
        if (raw['t'] === 'meta') {
          const tokenIds = raw['tokenIds'] as string[] | undefined;
          if (tokenIds && tokenIds.length > 0) {
            upTokenId = tokenIds[0];
          }
          continue;
        }

        if (raw['event_type'] !== 'book') continue;

        const rawBids = raw['bids'] as Array<{ price: string; size: string }>;
        const rawAsks = raw['asks'] as Array<{ price: string; size: string }>;
        const timestamp = raw['timestamp'] as string;

        if (!rawBids || !rawAsks || !timestamp) continue;

        // Определяем токен: Up или Down
        const assetId = raw['asset_id'] as string | undefined;
        const token: 'up' | 'down' = (upTokenId && assetId === upTokenId) ? 'up' : 'down';

        // Конвертируем в NumericLevel, best first
        // Bids: sort descending (best = highest)
        const bids = rawBids
          .map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
          .filter(l => l.price > 0 && l.size > 0)
          .sort((a, b) => b.price - a.price);

        // Asks: sort ascending (best = lowest)
        const asks = rawAsks
          .map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
          .filter(l => l.price > 0 && l.size > 0)
          .sort((a, b) => a.price - b.price);

        events.push({
          leg,
          token,
          timestampMs: parseInt(timestamp, 10),
          bids,
          asks,
        });
      }
    } finally {
      await reader.close();
    }

    if (!upTokenId) {
      this._logger.warn('No meta line with tokenIds found, cannot distinguish Up/Down tokens', { filePath });
    }

    return events;
  }

  /**
   * Мёрджит два потока событий по timestamp.
   */
  private _mergeTimelines(
    easy: readonly TaggedBookEvent[],
    hard: readonly TaggedBookEvent[],
  ): TaggedBookEvent[] {
    const merged: TaggedBookEvent[] = [];
    let i = 0;
    let j = 0;

    while (i < easy.length && j < hard.length) {
      if (easy[i].timestampMs <= hard[j].timestampMs) {
        merged.push(easy[i++]);
      } else {
        merged.push(hard[j++]);
      }
    }

    while (i < easy.length) merged.push(easy[i++]);
    while (j < hard.length) merged.push(hard[j++]);

    return merged;
  }
}
