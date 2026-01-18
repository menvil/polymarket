/**
 * PayoffCalculator - расчет выплат
 *
 * @remarks
 * Доменный сервис для расчета P&L при различных исходах бинарного рынка.
 *
 * Логика выплат в бинарных рынках:
 * - Если исход UP: каждый UP токен стоит $1.00, DOWN токен стоит $0.00
 * - Если исход DOWN: каждый DOWN токен стоит $1.00, UP токен стоит $0.00
 *
 * Расчет P&L:
 * ```
 * PnL = Payoff - CostBasis
 *
 * Если исход UP:
 *   Payoff = upQuantity * $1.00 + downQuantity * $0.00 = upQuantity
 *
 * Если исход DOWN:
 *   Payoff = upQuantity * $0.00 + downQuantity * $1.00 = downQuantity
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
 * const upPosition = Position.create(...); // 100 UP at avg $0.65
 * const downPosition = Position.create(...);  // 50 DOWN at avg $0.30
 *
 * const payoff = calculator.calculate(
 *   upPosition,
 *   downPosition,
 *   Price.fromNumber(0.65),
 *   Price.fromNumber(0.35)
 * );
 *
 * console.log(`PnL if UP wins: ${payoff.pnlIfUp.amount}`);
 * console.log(`PnL if DOWN wins: ${payoff.pnlIfDown.amount}`);
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
   * P&L if UP outcome
   */
  pnlIfUp: Money;

  /**
   * P&L if DOWN outcome
   */
  pnlIfDown: Money;

  /**
   * Worst case P&L (min of UP and DOWN scenarios)
   */
  worstCasePnl: Money;

  /**
   * True if loss is guaranteed regardless of outcome
   */
  isLockedInLoss: boolean;

  /**
   * Cost basis for UP position
   */
  upCostBasis: Money;

  /**
   * Cost basis for DOWN position
   */
  downCostBasis: Money;

  /**
   * UP position quantity
   */
  upQuantity: number;

  /**
   * DOWN position quantity
   */
  downQuantity: number;
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
 * // pnlIfUp = 100 - 65 = +$35
 * // pnlIfDown = 100 - 35 = +$65
 * // worstCase = +$35
 * // isLockedInLoss = false
 *
 * // Scenario 2: Locked-in loss
 * // 100 YES at $0.70 = $70 cost
 * // 100 NO at $0.40 = $40 cost
 * // Total cost: $110 (> $100 max payoff!)
 * const payoff2 = calculator.calculate(yesPos2, noPos2, ...);
 * // pnlIfUp = 100 - 70 = +$30, but paid $110 total → -$10
 * // pnlIfDown = 100 - 40 = +$60, but paid $110 total → -$10
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
   * @param upPosition - UP position (null if no position)
   * @param downPosition - DOWN position (null if no position)
   * @param yesPrice - Current YES price (for info only)
   * @param noPrice - Current NO price (for info only)
   * @returns Payoff calculation result
   *
   * @remarks
   * Алгоритм расчета:
   *
   * 1. **Извлечение данных позиций**:
   *    ```
   *    upQuantity = upPosition?.totalQuantity ?? 0
   *    downQuantity = downPosition?.totalQuantity ?? 0
   *    upCostBasis = upPosition?.costBasis ?? 0
   *    downCostBasis = downPosition?.costBasis ?? 0
   *    ```
   *
   * 2. **Расчет payoff для YES outcome**:
   *    ```
   *    payoffIfYes = upQuantity * $1.00 + downQuantity * $0.00
   *                = upQuantity
   *    pnlIfUp = payoffIfYes - upCostBasis - downCostBasis
   *    ```
   *
   * 3. **Расчет payoff для NO outcome**:
   *    ```
   *    payoffIfNo = upQuantity * $0.00 + downQuantity * $1.00
   *               = downQuantity
   *    pnlIfDown = payoffIfNo - upCostBasis - downCostBasis
   *    ```
   *
   * 4. **Worst case и locked-in loss**:
   *    ```
   *    worstCasePnl = min(pnlIfUp, pnlIfDown)
   *    isLockedInLoss = (worstCasePnl < 0)
   *    ```
   *
   * Интерпретация результатов:
   * - `isLockedInLoss = true` → Убыток гарантирован при любом исходе
   * - `pnlIfUp > 0 && pnlIfDown > 0` → Profitable hedge (arbitrage)
   * - `pnlIfUp > 0 && pnlIfDown < 0` → Bullish position (profit if UP)
   * - `pnlIfUp < 0 && pnlIfDown > 0` → Bearish position (profit if DOWN)
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
   * // upCostBasis = 100 * 0.5 = $50
   * // downCostBasis = 100 * 0.5 = $50
   * // pnlIfUp = 100 - 50 - 50 = $0
   * // pnlIfDown = 100 - 50 - 50 = $0
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
   * // upCostBasis = 100 * 0.6 = $60
   * // downCostBasis = 100 * 0.5 = $50
   * // Total cost = $110
   * // pnlIfUp = 100 - 60 - 50 = -$10
   * // pnlIfDown = 100 - 60 - 50 = -$10
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
   * // upCostBasis = $60
   * // downCostBasis = $0
   * // pnlIfUp = 100 - 60 = +$40
   * // pnlIfDown = 0 - 60 = -$60
   * // worstCasePnl = -$60
   * // isLockedInLoss = false (can profit if UP wins)
   * ```
   */
  public calculate(
    upPosition: Position | null,
    downPosition: Position | null,
    _upPrice: Price,
    _downPrice: Price
  ): PayoffResult {
    // 1. Extract position data
    const upQuantity = upPosition ? upPosition.totalQuantity.value : 0;
    const downQuantity = downPosition ? downPosition.totalQuantity.value : 0;

    const upCostBasis = upPosition ? upPosition.getTotalCost().amount : 0;
    const downCostBasis = downPosition ? downPosition.getTotalCost().amount : 0;

    const totalCostBasis = upCostBasis + downCostBasis;

    // 2. Calculate payoff if UP wins
    // Each UP token pays $1.00, each DOWN token pays $0.00
    const payoffIfUp = upQuantity * 1.0 + downQuantity * 0.0;
    const pnlIfUp = payoffIfUp - totalCostBasis;

    // 3. Calculate payoff if DOWN wins
    // Each UP token pays $0.00, each DOWN token pays $1.00
    const payoffIfDown = upQuantity * 0.0 + downQuantity * 1.0;
    const pnlIfDown = payoffIfDown - totalCostBasis;

    // 4. Determine worst case
    const worstCasePnl = Math.min(pnlIfUp, pnlIfDown);

    // 5. Check for locked-in loss
    const isLockedInLoss = worstCasePnl < 0 && pnlIfUp < 0 && pnlIfDown < 0;

    return {
      pnlIfUp: Money.fromUSDC(pnlIfUp),
      pnlIfDown: Money.fromUSDC(pnlIfDown),
      worstCasePnl: Money.fromUSDC(worstCasePnl),
      isLockedInLoss,
      upCostBasis: Money.fromUSDC(upCostBasis),
      downCostBasis: Money.fromUSDC(downCostBasis),
      upQuantity,
      downQuantity,
    };
  }

  /**
   * Checks if position is hedged
   *
   * @param upPosition - UP position
   * @param downPosition - DOWN position
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
    upPosition: Position | null,
    downPosition: Position | null,
    threshold?: number
  ): boolean {
    // Use config default if not specified
    const hedgeThreshold = threshold ??
      ConfigLoader.getInstance().getPositionConfig().hedgeIsHedgedThreshold;

    const upQty = upPosition ? upPosition.totalQuantity.value : 0;
    const downQty = downPosition ? downPosition.totalQuantity.value : 0;

    if (upQty === 0 || downQty === 0) {
      return false;
    }

    const minQty = Math.min(upQty, downQty);
    const maxQty = Math.max(upQty, downQty);

    const hedgeRatio = minQty / maxQty;

    return hedgeRatio >= hedgeThreshold;
  }
}
