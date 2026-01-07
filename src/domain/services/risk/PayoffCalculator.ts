/**
 * PayoffCalculator - расчет выплат
 *
 * @remarks
 * Доменный сервис для расчета P&L при различных исходах бинарного рынка.
 *
 * Логика выплат в бинарных рынках:
 * - Если исход YES: каждый YES токен стоит $1.00, NO токен стоит $0.00
 * - Если исход NO: каждый NO токен стоит $1.00, YES токен стоит $0.00
 *
 * Расчет P&L:
 * ```
 * PnL = Payoff - CostBasis
 *
 * Если исход YES:
 *   Payoff = yesQuantity * $1.00 + noQuantity * $0.00 = yesQuantity
 *
 * Если исход NO:
 *   Payoff = yesQuantity * $0.00 + noQuantity * $1.00 = noQuantity
 * ```
 *
 * Зачем нужен PayoffCalculator?
 * - Оценка потенциальных P&L при различных исходах
 * - Обнаружение "locked-in loss" (убыток гарантирован при любом исходе)
 * - Расчет worst-case scenario для риск-менеджмента
 * - Валидация хеджирования позиций
 *
 * @example
 * ```typescript
 * const calculator = new PayoffCalculator();
 *
 * const yesPosition = Position.create(...); // 100 YES at avg $0.65
 * const noPosition = Position.create(...);  // 50 NO at avg $0.30
 *
 * const payoff = calculator.calculate(
 *   yesPosition,
 *   noPosition,
 *   Price.fromNumber(0.65),
 *   Price.fromNumber(0.35)
 * );
 *
 * console.log(`PnL if YES wins: ${payoff.pnlIfYes.amount}`);
 * console.log(`PnL if NO wins: ${payoff.pnlIfNo.amount}`);
 * console.log(`Worst case: ${payoff.worstCasePnl.amount}`);
 * console.log(`Locked-in loss: ${payoff.isLockedInLoss}`);
 * ```
 */
import { Position } from '../../entities/Position.js';
import { Price } from '../../value-objects/Price.js';
import { Money } from '../../value-objects/Money.js';
import { ConfigLoader } from '../../../infrastructure/config/ConfigLoader.js';

/**
 * Payoff calculation result
 */
export interface PayoffResult {
  /**
   * P&L if YES outcome
   */
  pnlIfYes: Money;

  /**
   * P&L if NO outcome
   */
  pnlIfNo: Money;

  /**
   * Worst case P&L (min of YES and NO scenarios)
   */
  worstCasePnl: Money;

  /**
   * True if loss is guaranteed regardless of outcome
   */
  isLockedInLoss: boolean;

  /**
   * Cost basis for YES position
   */
  yesCostBasis: Money;

  /**
   * Cost basis for NO position
   */
  noCostBasis: Money;

  /**
   * YES position quantity
   */
  yesQuantity: number;

  /**
   * NO position quantity
   */
  noQuantity: number;
}

/**
 * PayoffCalculator
 *
 * @remarks
 * Stateless сервис для расчета выплат и P&L при различных исходах.
 *
 * Алгоритм:
 * 1. Получить количество и cost basis для YES и NO позиций
 * 2. Рассчитать payoff для YES outcome: yesQty * $1.00 + noQty * $0.00
 * 3. Рассчитать payoff для NO outcome: yesQty * $0.00 + noQty * $1.00
 * 4. Вычислить P&L = payoff - costBasis для каждого сценария
 * 5. Определить worst case и проверить locked-in loss
 *
 * @example
 * ```typescript
 * const calculator = new PayoffCalculator();
 *
 * // Scenario 1: Balanced hedge (no locked-in loss)
 * // 100 YES at $0.65 = $65 cost
 * // 100 NO at $0.35 = $35 cost
 * // Total cost: $100
 * const payoff1 = calculator.calculate(yesPos1, noPos1, ...);
 * // pnlIfYes = 100 - 65 = +$35
 * // pnlIfNo = 100 - 35 = +$65
 * // worstCase = +$35
 * // isLockedInLoss = false
 *
 * // Scenario 2: Locked-in loss
 * // 100 YES at $0.70 = $70 cost
 * // 100 NO at $0.40 = $40 cost
 * // Total cost: $110 (> $100 max payoff!)
 * const payoff2 = calculator.calculate(yesPos2, noPos2, ...);
 * // pnlIfYes = 100 - 70 = +$30, but paid $110 total → -$10
 * // pnlIfNo = 100 - 40 = +$60, but paid $110 total → -$10
 * // worstCase = -$10
 * // isLockedInLoss = true
 * ```
 */
export class PayoffCalculator {
  /**
   * Creates PayoffCalculator
   *
   * @example
   * ```typescript
   * const calculator = new PayoffCalculator();
   * ```
   */
  constructor() {}

  /**
   * Calculates payoff for all outcomes
   *
   * @param yesPosition - YES position (null if no position)
   * @param noPosition - NO position (null if no position)
   * @param yesPrice - Current YES price (for info only)
   * @param noPrice - Current NO price (for info only)
   * @returns Payoff calculation result
   *
   * @remarks
   * Алгоритм расчета:
   *
   * 1. **Извлечение данных позиций**:
   *    ```
   *    yesQuantity = yesPosition?.totalQuantity ?? 0
   *    noQuantity = noPosition?.totalQuantity ?? 0
   *    yesCostBasis = yesPosition?.costBasis ?? 0
   *    noCostBasis = noPosition?.costBasis ?? 0
   *    ```
   *
   * 2. **Расчет payoff для YES outcome**:
   *    ```
   *    payoffIfYes = yesQuantity * $1.00 + noQuantity * $0.00
   *                = yesQuantity
   *    pnlIfYes = payoffIfYes - yesCostBasis - noCostBasis
   *    ```
   *
   * 3. **Расчет payoff для NO outcome**:
   *    ```
   *    payoffIfNo = yesQuantity * $0.00 + noQuantity * $1.00
   *               = noQuantity
   *    pnlIfNo = payoffIfNo - yesCostBasis - noCostBasis
   *    ```
   *
   * 4. **Worst case и locked-in loss**:
   *    ```
   *    worstCasePnl = min(pnlIfYes, pnlIfNo)
   *    isLockedInLoss = (worstCasePnl < 0)
   *    ```
   *
   * Интерпретация результатов:
   * - `isLockedInLoss = true` → Убыток гарантирован при любом исходе
   * - `pnlIfYes > 0 && pnlIfNo > 0` → Profitable hedge (arbitrage)
   * - `pnlIfYes > 0 && pnlIfNo < 0` → Bullish position (profit if YES)
   * - `pnlIfYes < 0 && pnlIfNo > 0` → Bearish position (profit if NO)
   *
   * @example
   * ```typescript
   * const calculator = new PayoffCalculator();
   *
   * // Example 1: Perfect hedge (bought both at YES=0.5, NO=0.5)
   * const yesPos1 = Position.create({
   *   tokenId: 'market-YES',
   *   side: 'YES',
   *   lots: [PositionLot.create(Quantity.fromNumber(100), Price.fromNumber(0.5))],
   * });
   * const noPos1 = Position.create({
   *   tokenId: 'market-NO',
   *   side: 'NO',
   *   lots: [PositionLot.create(Quantity.fromNumber(100), Price.fromNumber(0.5))],
   * });
   *
   * const payoff1 = calculator.calculate(
   *   yesPos1,
   *   noPos1,
   *   Price.fromNumber(0.6),
   *   Price.fromNumber(0.4)
   * );
   * // yesCostBasis = 100 * 0.5 = $50
   * // noCostBasis = 100 * 0.5 = $50
   * // pnlIfYes = 100 - 50 - 50 = $0
   * // pnlIfNo = 100 - 50 - 50 = $0
   * // worstCasePnl = $0
   * // isLockedInLoss = false
   *
   * // Example 2: Locked-in loss (bought both at YES=0.6, NO=0.5)
   * const yesPos2 = Position.create({
   *   tokenId: 'market-YES',
   *   side: 'YES',
   *   lots: [PositionLot.create(Quantity.fromNumber(100), Price.fromNumber(0.6))],
   * });
   * const noPos2 = Position.create({
   *   tokenId: 'market-NO',
   *   side: 'NO',
   *   lots: [PositionLot.create(Quantity.fromNumber(100), Price.fromNumber(0.5))],
   * });
   *
   * const payoff2 = calculator.calculate(yesPos2, noPos2, ...);
   * // yesCostBasis = 100 * 0.6 = $60
   * // noCostBasis = 100 * 0.5 = $50
   * // Total cost = $110
   * // pnlIfYes = 100 - 60 - 50 = -$10
   * // pnlIfNo = 100 - 60 - 50 = -$10
   * // worstCasePnl = -$10
   * // isLockedInLoss = true ⚠️
   *
   * // Example 3: Bullish position (only YES)
   * const yesPos3 = Position.create({
   *   tokenId: 'market-YES',
   *   side: 'YES',
   *   lots: [PositionLot.create(Quantity.fromNumber(100), Price.fromNumber(0.6))],
   * });
   *
   * const payoff3 = calculator.calculate(yesPos3, null, ...);
   * // yesCostBasis = $60
   * // noCostBasis = $0
   * // pnlIfYes = 100 - 60 = +$40
   * // pnlIfNo = 0 - 60 = -$60
   * // worstCasePnl = -$60
   * // isLockedInLoss = false (can profit if YES wins)
   * ```
   */
  public calculate(
    yesPosition: Position | null,
    noPosition: Position | null,
    _yesPrice: Price,
    _noPrice: Price
  ): PayoffResult {
    // 1. Extract position data
    const yesQuantity = yesPosition ? yesPosition.totalQuantity.value : 0;
    const noQuantity = noPosition ? noPosition.totalQuantity.value : 0;

    const yesCostBasis = yesPosition ? yesPosition.getTotalCost().amount : 0;
    const noCostBasis = noPosition ? noPosition.getTotalCost().amount : 0;

    const totalCostBasis = yesCostBasis + noCostBasis;

    // 2. Calculate payoff if YES wins
    // Each YES token pays $1.00, each NO token pays $0.00
    const payoffIfYes = yesQuantity * 1.0 + noQuantity * 0.0;
    const pnlIfYes = payoffIfYes - totalCostBasis;

    // 3. Calculate payoff if NO wins
    // Each YES token pays $0.00, each NO token pays $1.00
    const payoffIfNo = yesQuantity * 0.0 + noQuantity * 1.0;
    const pnlIfNo = payoffIfNo - totalCostBasis;

    // 4. Determine worst case
    const worstCasePnl = Math.min(pnlIfYes, pnlIfNo);

    // 5. Check for locked-in loss
    const isLockedInLoss = worstCasePnl < 0 && pnlIfYes < 0 && pnlIfNo < 0;

    return {
      pnlIfYes: Money.fromUSDC(pnlIfYes),
      pnlIfNo: Money.fromUSDC(pnlIfNo),
      worstCasePnl: Money.fromUSDC(worstCasePnl),
      isLockedInLoss,
      yesCostBasis: Money.fromUSDC(yesCostBasis),
      noCostBasis: Money.fromUSDC(noCostBasis),
      yesQuantity,
      noQuantity,
    };
  }

  /**
   * Checks if position is hedged
   *
   * @param yesPosition - YES position
   * @param noPosition - NO position
   * @param threshold - Hedge ratio threshold (default: 0.9)
   * @returns True if position is well-hedged
   *
   * @remarks
   * Позиция считается хеджированной, если соотношение YES/NO близко к 1:1.
   *
   * Формула:
   * ```
   * hedgeRatio = min(yesQty, noQty) / max(yesQty, noQty)
   * isHedged = hedgeRatio >= threshold
   * ```
   *
   * @example
   * ```typescript
   * const calculator = new PayoffCalculator();
   *
   * // Well-hedged: 100 YES, 95 NO → ratio = 95/100 = 0.95
   * const isHedged1 = calculator.isHedged(yesPos1, noPos1, 0.9);
   * console.log(isHedged1); // true
   *
   * // Not hedged: 100 YES, 50 NO → ratio = 50/100 = 0.5
   * const isHedged2 = calculator.isHedged(yesPos2, noPos2, 0.9);
   * console.log(isHedged2); // false
   * ```
   */
  public isHedged(
    yesPosition: Position | null,
    noPosition: Position | null,
    threshold?: number
  ): boolean {
    // Use config default if not specified
    const hedgeThreshold = threshold ??
      ConfigLoader.getInstance().getPositionConfig().hedgeIsHedgedThreshold;

    const yesQty = yesPosition ? yesPosition.totalQuantity.value : 0;
    const noQty = noPosition ? noPosition.totalQuantity.value : 0;

    if (yesQty === 0 || noQty === 0) {
      return false;
    }

    const minQty = Math.min(yesQty, noQty);
    const maxQty = Math.max(yesQty, noQty);

    const hedgeRatio = minQty / maxQty;

    return hedgeRatio >= hedgeThreshold;
  }
}
