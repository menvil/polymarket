/**
 * Анализатор глубины ордербука для арбитражных пар
 *
 * @remarks
 * Вычисляет кумулятивный VWAP и исполняемый размер по уровням 1..N
 * для обеих ног арбитража. Определяет оптимальную глубину исполнения —
 * уровень, на котором totalPnl максимален.
 *
 * ### Алгоритм:
 * 1. Для каждого уровня depth 1..maxDepth:
 *    - Считаем кумулятивный VWAP для hard_Up bids и easy_Up asks
 *    - Проверяем: hard_Up_VWAP > easy_Up_VWAP (расхождение живо)
 *    - exec_size = min(cum_hard_size, cum_easy_size)
 *    - cost = easy_VWAP + (1 - hard_VWAP) + fee
 *    - pnl = (1 - cost) × exec_size
 * 2. Останавливаемся когда spread ≤ 0 или depth > maxDepth
 * 3. Возвращаем профиль по всем валидным уровням
 *
 * ### Из исследования (23 марта 2026):
 * - 98% расхождений выживают до depth 5
 * - +25% PnL от использования глубины vs only best price
 * - VWAP деградирует плавно: ~0.001-0.003 за уровень
 *
 * @example
 * ```typescript
 * const analyzer = new DepthAnalyzer(new FeeCalculator(FEE_MODEL_CURRENT));
 * const profile = analyzer.analyze(hardUpBids, easyUpAsks, {
 *   maxDepth: 5,
 *   easyIsTaker: true,
 *   hardIsMaker: true,
 * });
 * if (profile.length > 0) {
 *   const best = profile[profile.length - 1]; // или найти max totalPnl
 *   console.log(`Optimal: depth=${best.depth}, pnl=$${best.totalPnl}`);
 * }
 * ```
 */

import type { NumericLevel, DepthLevel } from './types.js';
import type { FeeCalculator } from './FeeCalculator.js';

/**
 * Опции анализа глубины.
 */
export interface DepthAnalysisOptions {
  /** Максимальная глубина (default: 5) */
  readonly maxDepth: number;
  /** Easy leg — taker */
  readonly easyIsTaker: boolean;
  /** Hard leg — maker (тогда hardIsTaker = false) */
  readonly hardIsMaker: boolean;
}

/**
 * Анализатор глубины ордербука.
 *
 * @param feeCalc - Калькулятор комиссий
 */
export class DepthAnalyzer {
  constructor(private readonly _feeCalc: FeeCalculator) {}

  /**
   * Анализирует профиль глубины для арбитражной пары.
   *
   * @param hardUpBids - Bids hard_Up рынка, **best first** (убывание по цене)
   * @param easyUpAsks - Asks easy_Up рынка, **best first** (возрастание по цене)
   * @param options - Параметры анализа
   * @returns Массив DepthLevel для каждого валидного уровня; пустой если нет расхождения
   *
   * @remarks
   * Входные массивы должны быть отсортированы best-first:
   * - hardUpBids: [0.55, 0.54, 0.53, ...] (убывание)
   * - easyUpAsks: [0.48, 0.49, 0.50, ...] (возрастание)
   *
   * @throws Не бросает исключений — возвращает пустой массив при невалидных данных
   */
  analyze(
    hardUpBids: readonly NumericLevel[],
    easyUpAsks: readonly NumericLevel[],
    options: DepthAnalysisOptions,
  ): DepthLevel[] {
    const result: DepthLevel[] = [];
    const maxD = Math.min(options.maxDepth, hardUpBids.length, easyUpAsks.length);

    if (maxD === 0) return result;

    let cumHardSize = 0;
    let cumHardNotional = 0;
    let cumEasySize = 0;
    let cumEasyNotional = 0;

    for (let d = 0; d < maxD; d++) {
      const hLevel = hardUpBids[d];
      const eLevel = easyUpAsks[d];

      cumHardSize += hLevel.size;
      cumHardNotional += hLevel.price * hLevel.size;
      cumEasySize += eLevel.size;
      cumEasyNotional += eLevel.price * eLevel.size;

      const hardVwap = cumHardNotional / cumHardSize;
      const easyVwap = cumEasyNotional / cumEasySize;

      // Расхождение исчезло — останавливаемся
      const spread = hardVwap - easyVwap;
      if (spread <= 0) break;

      const hardDownAsk = 1 - hardVwap;
      const execSize = Math.min(cumHardSize, cumEasySize);
      const costPerUnit = easyVwap + hardDownAsk;

      const totalFee = this._feeCalc.pairFee(
        easyVwap,
        options.easyIsTaker,
        hardDownAsk,
        !options.hardIsMaker,
        execSize,
      );
      const feePerUnit = totalFee / execSize;

      const pnlPerUnit = 1 - costPerUnit - feePerUnit;
      const totalPnl = pnlPerUnit * execSize;

      result.push({
        depth: d + 1,
        hardUpVwap: hardVwap,
        easyUpVwap: easyVwap,
        spread,
        execSize,
        costPerUnit,
        feePerUnit,
        pnlPerUnit,
        totalPnl,
      });
    }

    return result;
  }

  /**
   * Анализирует профиль глубины для DOWN арбитража.
   *
   * @param easyUpBids - Bids easy_Up рынка, **best first** (убывание по цене)
   * @param hardUpAsks - Asks hard_Up рынка, **best first** (возрастание по цене)
   * @param options - Параметры анализа
   * @returns Массив DepthLevel для каждого валидного уровня; пустой если нет расхождения
   *
   * @remarks
   * Зеркальная версия analyze() для DOWN направления:
   * - Расхождение: easyUpBid > hardUpAsk
   * - cost = (1 - easyUpVwap) + hardUpVwap = 1 - (easyUpVwap - hardUpVwap)
   * - spread = easyUpVwap - hardUpVwap (зеркальный)
   * - pnl = 1 - cost - fee = spread - fee
   *
   * DepthLevel поля переиспользуются с семантикой:
   * - hardUpVwap = VWAP hard_Up asks (цена покупки hard_Up)
   * - easyUpVwap = VWAP easy_Up bids (цена для вычисления easy_Down ask = 1 - easyUpVwap)
   * - spread = easyUpVwap - hardUpVwap
   * - costPerUnit = (1 - easyUpVwap) + hardUpVwap
   */
  analyzeDown(
    easyUpBids: readonly NumericLevel[],
    hardUpAsks: readonly NumericLevel[],
    options: DepthAnalysisOptions,
  ): DepthLevel[] {
    const result: DepthLevel[] = [];
    const maxD = Math.min(options.maxDepth, easyUpBids.length, hardUpAsks.length);

    if (maxD === 0) return result;

    let cumEasySize = 0;
    let cumEasyNotional = 0;
    let cumHardSize = 0;
    let cumHardNotional = 0;

    for (let d = 0; d < maxD; d++) {
      const eLevel = easyUpBids[d];
      const hLevel = hardUpAsks[d];

      cumEasySize += eLevel.size;
      cumEasyNotional += eLevel.price * eLevel.size;
      cumHardSize += hLevel.size;
      cumHardNotional += hLevel.price * hLevel.size;

      const easyUpVwap = cumEasyNotional / cumEasySize;
      const hardUpVwap = cumHardNotional / cumHardSize;

      // Расхождение исчезло — останавливаемся
      const spread = easyUpVwap - hardUpVwap;
      if (spread <= 0) break;

      const easyDownAsk = 1 - easyUpVwap;
      const execSize = Math.min(cumEasySize, cumHardSize);
      const costPerUnit = easyDownAsk + hardUpVwap;

      // Для DOWN: easy_Down — taker, hard_Up — maker (зеркально UP)
      const totalFee = this._feeCalc.pairFee(
        easyDownAsk,
        options.easyIsTaker,
        hardUpVwap,
        !options.hardIsMaker,
        execSize,
      );
      const feePerUnit = totalFee / execSize;

      const pnlPerUnit = 1 - costPerUnit - feePerUnit;
      const totalPnl = pnlPerUnit * execSize;

      result.push({
        depth: d + 1,
        hardUpVwap,
        easyUpVwap,
        spread,
        execSize,
        costPerUnit,
        feePerUnit,
        pnlPerUnit,
        totalPnl,
      });
    }

    return result;
  }

  /**
   * Находит уровень с максимальным totalPnl.
   *
   * @param levels - Массив DepthLevel из analyze()
   * @returns Оптимальный уровень или undefined если массив пуст
   */
  findOptimal(levels: readonly DepthLevel[]): DepthLevel | undefined {
    if (levels.length === 0) return undefined;

    let best = levels[0];
    for (let i = 1; i < levels.length; i++) {
      if (levels[i].totalPnl > best.totalPnl) {
        best = levels[i];
      }
    }
    return best;
  }
}
