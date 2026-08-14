/**
 * Детектор расхождений вероятностей между парами рынков
 *
 * @remarks
 * Основной компонент арбитражной стратегии. Анализирует два ордербука
 * и определяет, нарушает ли рынок математическое ограничение
 * `P(easy_Up) >= P(hard_Up)`.
 *
 * ### Сигнал расхождения:
 * Если `hard_Up_best_bid > easy_Up_best_ask` — рынок считает hard_Up
 * более вероятным чем easy_Up, что математически невозможно.
 *
 * ### Стратегия:
 * 1. Купить easy_Up по ask (taker fee по crypto-формуле Polymarket)
 * 2. Продать hard_Up по bid = купить hard_Down (maker, 0% fee)
 * 3. Гарантированный доход: min($1, $1) = $1 (один из двух резолвится в $1)
 * 4. Стоимость: easy_Up_ask + (1 - hard_Up_bid) < $1 → прибыль
 *
 * ### Три исхода:
 * | Состояние | easy_Up | hard_Down | Доход |
 * |-----------|---------|-----------|-------|
 * | Both Up   | $1      | $0        | $1    |
 * | Easy Up, Hard Down | $1 | $1   | **$2** (джекпот) |
 * | Both Down | $0      | $1        | $1    |
 *
 * @example
 * ```typescript
 * const detector = new DivergenceDetector();
 * const signal = detector.detect(easyBook, hardBook, pair, nowMs);
 * if (signal) {
 *   console.log(`Arbitrage! PnL=$${signal.optimalDepth.totalPnl}`);
 * }
 * ```
 */

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import { Timestamp } from '@polymarket/timestamp';
import type {
  SimpleBook,
  MarketPair,
  ArbitrageSignal,
  DetectorConfig,
} from './types.js';
import { DEFAULT_DETECTOR_CONFIG } from './types.js';
import { FeeCalculator } from './FeeCalculator.js';
import { DepthAnalyzer } from './DepthAnalyzer.js';

/**
 * Детектор расхождений между парой рынков.
 *
 * @example
 * ```typescript
 * const detector = new DivergenceDetector({
 *   maxDepth: 5,
 *   minSpreadAfterFees: 0.005,
 *   feeModel: FEE_MODEL_CURRENT,
 *   easyIsTaker: true,
 *   hardIsMaker: true,
 * });
 *
 * const signal = detector.detect(easyBook, hardBook, pair, Date.now());
 * ```
 */
export class DivergenceDetector {
  private readonly _config: DetectorConfig;
  private readonly _feeCalc: FeeCalculator;
  private readonly _depthAnalyzer: DepthAnalyzer;

  /**
   * @param config - Конфигурация детектора (опционально, используются значения по умолчанию)
   */
  constructor(config?: Partial<DetectorConfig>) {
    this._config = { ...DEFAULT_DETECTOR_CONFIG, ...config };
    this._feeCalc = new FeeCalculator(this._config.feeModel);
    this._depthAnalyzer = new DepthAnalyzer(this._feeCalc);
  }

  /**
   * Проверяет пару ордербуков на наличие арбитражного расхождения.
   *
   * @param easyBook - Ордербук easy рынка (longer duration)
   * @param hardBook - Ордербук hard рынка (shorter duration)
   * @param pair - Метаданные пары рынков
   * @param nowMs - Текущее время (epoch ms)
   * @returns ArbitrageSignal если расхождение обнаружено и прибыльно, иначе null
   *
   * @remarks
   * Алгоритм:
   * 1. Проверяем наличие уровней в обоих стаканах
   * 2. Quick check: `hard_Up_best_bid > easy_Up_best_ask` ?
   * 3. Если да — анализируем глубину через DepthAnalyzer
   * 4. Находим оптимальный depth (max totalPnl)
   * 5. Проверяем minSpreadAfterFees
   * 6. Формируем ArbitrageSignal
   */
  detect(
    easyBook: SimpleBook,
    hardBook: SimpleBook,
    pair: MarketPair,
    nowMs: number,
  ): ArbitrageSignal | null {
    // Проверяем наличие данных
    if (hardBook.bids.length === 0 || easyBook.asks.length === 0) {
      return null;
    }

    // Quick check: best prices
    const hardUpBestBid = hardBook.bids[0].price;
    const easyUpBestAsk = easyBook.asks[0].price;

    if (hardUpBestBid <= easyUpBestAsk) {
      return null; // Нет расхождения
    }

    // Анализ глубины
    const depthLevels = this._depthAnalyzer.analyze(
      hardBook.bids,
      easyBook.asks,
      {
        maxDepth: this._config.maxDepth,
        easyIsTaker: this._config.easyIsTaker,
        hardIsMaker: this._config.hardIsMaker,
      },
    );

    if (depthLevels.length === 0) {
      return null;
    }

    // Находим оптимальный уровень
    const optimal = this._depthAnalyzer.findOptimal(depthLevels);
    if (!optimal) return null;

    // Проверяем минимальный спред после комиссий
    if (optimal.pnlPerUnit < this._config.minSpreadAfterFees) {
      return null;
    }

    return {
      pair,
      detectedAtMs: Timestamp.of(new Decimal(nowMs)),
      depthLevels,
      optimalDepth: optimal,
      hardUpBestBid,
      easyUpBestAsk,
      direction: 'UP' as const,
    };
  }

  /**
   * Проверяет пару ордербуков на наличие DOWN арбитражного расхождения.
   *
   * @param easyBook - Ордербук easy рынка (longer duration)
   * @param hardBook - Ордербук hard рынка (shorter duration)
   * @param pair - Метаданные пары рынков
   * @param nowMs - Текущее время (epoch ms)
   * @returns ArbitrageSignal если расхождение обнаружено и прибыльно, иначе null
   *
   * @remarks
   * Зеркальная версия detect() для DOWN направления:
   * - Условие: easyUpBid > hardUpAsk
   * - Стратегия: BUY easy_Down + BUY hard_Up
   * - Strike-safe когда easyStrike > hardStrike
   *
   * ### Три исхода:
   * | Состояние            | easy_Down | hard_Up | Доход |
   * |----------------------|-----------|---------|-------|
   * | Both Up              | $0        | $1      | $1    |
   * | Easy Down, Hard Up   | $1        | $1      | **$2** |
   * | Both Down            | $1        | $0      | $1    |
   */
  detectDown(
    easyBook: SimpleBook,
    hardBook: SimpleBook,
    pair: MarketPair,
    nowMs: number,
  ): ArbitrageSignal | null {
    // Проверяем наличие данных
    if (easyBook.bids.length === 0 || hardBook.asks.length === 0) {
      return null;
    }

    // Quick check: best prices
    const easyUpBestBid = easyBook.bids[0].price;
    const hardUpBestAsk = hardBook.asks[0].price;

    if (easyUpBestBid <= hardUpBestAsk) {
      return null; // Нет расхождения
    }

    // Анализ глубины (зеркальный)
    const depthLevels = this._depthAnalyzer.analyzeDown(
      easyBook.bids,
      hardBook.asks,
      {
        maxDepth: this._config.maxDepth,
        easyIsTaker: this._config.easyIsTaker,
        hardIsMaker: this._config.hardIsMaker,
      },
    );

    if (depthLevels.length === 0) {
      return null;
    }

    // Находим оптимальный уровень
    const optimal = this._depthAnalyzer.findOptimal(depthLevels);
    if (!optimal) return null;

    // Проверяем минимальный спред после комиссий
    if (optimal.pnlPerUnit < this._config.minSpreadAfterFees) {
      return null;
    }

    return {
      pair,
      detectedAtMs: Timestamp.of(new Decimal(nowMs)),
      depthLevels,
      optimalDepth: optimal,
      hardUpBestBid: easyUpBestBid,  // семантика: «активная» сторона расхождения
      easyUpBestAsk: hardUpBestAsk,  // семантика: «пассивная» сторона
      direction: 'DOWN' as const,
    };
  }

  /**
   * Проверяет оба направления (UP и DOWN) и возвращает лучший сигнал.
   *
   * @param easyBook - Ордербук easy рынка
   * @param hardBook - Ордербук hard рынка
   * @param pair - Метаданные пары
   * @param nowMs - Текущее время
   * @returns Лучший сигнал (по pnlPerUnit) или null
   */
  detectBest(
    easyBook: SimpleBook,
    hardBook: SimpleBook,
    pair: MarketPair,
    nowMs: number,
  ): ArbitrageSignal | null {
    const up = this.detect(easyBook, hardBook, pair, nowMs);
    const down = this.detectDown(easyBook, hardBook, pair, nowMs);

    if (up && down) {
      return up.optimalDepth.pnlPerUnit >= down.optimalDepth.pnlPerUnit ? up : down;
    }
    return up ?? down;
  }

  /**
   * Возвращает текущую конфигурацию детектора.
   */
  get config(): DetectorConfig {
    return this._config;
  }

  /**
   * Возвращает внутренний калькулятор комиссий (для тестирования).
   */
  get feeCalculator(): FeeCalculator {
    return this._feeCalc;
  }
}
