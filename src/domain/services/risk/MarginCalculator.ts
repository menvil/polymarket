/**
 * MarginCalculator - расчет маржи
 *
 * @remarks
 * Доменный сервис для расчета требуемой маржи (margin requirement) для позиций.
 *
 * В бинарных рынках маржа работает следующим образом:
 * - При покупке YES/NO токена за $X → блокируется $X маржи
 * - При продаже YES/NO токена за $Y → блокируется $(1.00 - Y) маржи (max risk)
 * - Маржа освобождается при закрытии позиции или экспирации рынка
 *
 * Зачем нужен MarginCalculator?
 * - Проверка достаточности средств перед размещением ордера
 * - Расчет доступной маржи для новых позиций
 * - Контроль за общим risk exposure
 * - Предотвращение margin call
 *
 * @example
 * ```typescript
 * const calculator = new MarginCalculator();
 *
 * // Маржа для покупки 100 YES по $0.65
 * const marginBuy = calculator.calculateOrderMargin(
 *   'BUY',
 *   Price.fromNumber(0.65),
 *   Quantity.fromNumber(100)
 * );
 * console.log(`Required margin: $${marginBuy.amount}`); // $65
 *
 * // Маржа для продажи 100 YES по $0.65
 * const marginSell = calculator.calculateOrderMargin(
 *   'SELL',
 *   Price.fromNumber(0.65),
 *   Quantity.fromNumber(100)
 * );
 * console.log(`Required margin: $${marginSell.amount}`); // $35 (max risk)
 * ```
 */
import { Order } from '../../entities/Order.js';
import { Portfolio } from '../../aggregates/Portfolio.js';
import { Price } from '../../value-objects/Price.js';
import { Quantity } from '../../value-objects/Quantity.js';
import { Money } from '../../value-objects/Money.js';

/**
 * Margin requirement result
 */
export interface MarginRequirement {
  /**
   * Required margin amount
   */
  requiredMargin: Money;

  /**
   * Available cash
   */
  availableCash: Money;

  /**
   * Is margin sufficient
   */
  isSufficient: boolean;

  /**
   * Shortfall amount (if insufficient)
   */
  shortfall: Money;
}

/**
 * MarginCalculator
 *
 * @remarks
 * Stateless сервис для расчета margin requirements.
 *
 * Формулы расчета маржи:
 * ```
 * BUY order:
 *   requiredMargin = price * quantity
 *
 * SELL order:
 *   requiredMargin = (1.00 - price) * quantity  // max risk
 * ```
 *
 * @example
 * ```typescript
 * const calculator = new MarginCalculator();
 *
 * // Scenario 1: BUY 100 YES at $0.65
 * const margin1 = calculator.calculateOrderMargin('BUY', Price.fromNumber(0.65), Quantity.fromNumber(100));
 * // requiredMargin = 0.65 * 100 = $65
 *
 * // Scenario 2: SELL 100 YES at $0.65
 * const margin2 = calculator.calculateOrderMargin('SELL', Price.fromNumber(0.65), Quantity.fromNumber(100));
 * // requiredMargin = (1.00 - 0.65) * 100 = $35 (max risk if YES wins)
 * ```
 */
export class MarginCalculator {
  /**
   * Creates MarginCalculator
   *
   * @example
   * ```typescript
   * const calculator = new MarginCalculator();
   * ```
   */
  constructor() {}

  /**
   * Calculates required margin for order
   *
   * @param side - Order side (BUY or SELL)
   * @param price - Order price
   * @param quantity - Order quantity
   * @returns Required margin amount
   *
   * @remarks
   * Алгоритм расчета:
   *
   * **BUY order**:
   * ```
   * При покупке токена мы платим цену токена.
   * requiredMargin = price * quantity
   *
   * Пример: BUY 100 YES at $0.65 → margin = $65
   * ```
   *
   * **SELL order**:
   * ```
   * При продаже токена мы рискуем максимум (1.00 - price).
   * Если токен выиграет, мы должны заплатить $1.00 за каждый проданный токен.
   * requiredMargin = (1.00 - price) * quantity
   *
   * Пример: SELL 100 YES at $0.65 → margin = (1.00 - 0.65) * 100 = $35
   * Если YES выиграет, мы теряем $35 (получили $65, должны заплатить $100)
   * ```
   *
   * @example
   * ```typescript
   * const calculator = new MarginCalculator();
   *
   * // BUY examples
   * const margin1 = calculator.calculateOrderMargin(
   *   'BUY',
   *   Price.fromNumber(0.70),
   *   Quantity.fromNumber(100)
   * );
   * console.log(margin1.amount); // 70
   *
   * const margin2 = calculator.calculateOrderMargin(
   *   'BUY',
   *   Price.fromNumber(0.30),
   *   Quantity.fromNumber(200)
   * );
   * console.log(margin2.amount); // 60
   *
   * // SELL examples
   * const margin3 = calculator.calculateOrderMargin(
   *   'SELL',
   *   Price.fromNumber(0.70),
   *   Quantity.fromNumber(100)
   * );
   * console.log(margin3.amount); // 30 (max risk)
   *
   * const margin4 = calculator.calculateOrderMargin(
   *   'SELL',
   *   Price.fromNumber(0.30),
   *   Quantity.fromNumber(200)
   * );
   * console.log(margin4.amount); // 140 (max risk)
   * ```
   */
  public calculateOrderMargin(
    side: 'BUY' | 'SELL',
    price: Price,
    quantity: Quantity
  ): Money {
    if (side === 'BUY') {
      // BUY: margin = price * quantity
      const margin = price.value * quantity.value;
      return Money.fromUSDC(margin);
    } else {
      // SELL: margin = (1.00 - price) * quantity (max risk)
      const maxRisk = (1.0 - price.value) * quantity.value;
      return Money.fromUSDC(maxRisk);
    }
  }

  /**
   * Checks margin requirement for order
   *
   * @param order - Order to check
   * @param portfolio - Current portfolio
   * @returns Margin requirement result
   *
   * @remarks
   * Проверяет достаточность средств для размещения ордера.
   *
   * Алгоритм:
   * 1. Рассчитать требуемую маржу для ордера
   * 2. Получить available cash из portfolio
   * 3. Сравнить: isSufficient = (availableCash >= requiredMargin)
   * 4. Если недостаточно → вычислить shortfall
   *
   * @example
   * ```typescript
   * const calculator = new MarginCalculator();
   *
   * const order = Order.create({
   *   id: 'order-1',
   *   tokenId: 'market-YES',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.65),
   *   size: Quantity.fromNumber(100),
   *   status: 'PENDING',
   *   timestamp: new Date(),
   * });
   *
   * const requirement = calculator.checkMarginRequirement(order, portfolio);
   *
   * if (!requirement.isSufficient) {
   *   console.error(`Insufficient margin! Shortfall: $${requirement.shortfall.amount}`);
   *   throw new InsufficientFundsError('Not enough margin');
   * }
   * ```
   */
  public checkMarginRequirement(order: Order, portfolio: Portfolio): MarginRequirement {
    // Calculate required margin for order
    const requiredMargin = this.calculateOrderMargin(order.side, order.price, order.size);

    // Get available cash from portfolio
    const availableCash = portfolio.getAvailableCash();

    // Check sufficiency
    const isSufficient = availableCash.amount >= requiredMargin.amount;

    // Calculate shortfall if insufficient
    const shortfall = isSufficient
      ? Money.fromUSDC(0)
      : Money.fromUSDC(requiredMargin.amount - availableCash.amount);

    return {
      requiredMargin,
      availableCash,
      isSufficient,
      shortfall,
    };
  }

  /**
   * Calculates total margin for portfolio positions
   *
   * @param portfolio - Portfolio to calculate margin for
   * @returns Total margin locked in positions
   *
   * @remarks
   * Вычисляет общую маржу, заблокированную во всех позициях портфеля.
   * Маржа = cost basis всех позиций (сумма всех вложений).
   *
   * @example
   * ```typescript
   * const calculator = new MarginCalculator();
   * const totalMargin = calculator.calculatePortfolioMargin(portfolio);
   *
   * console.log(`Total margin locked: $${totalMargin.amount}`);
   * console.log(`Available cash: $${portfolio.getAvailableCash().amount}`);
   * console.log(`Total portfolio value: $${totalMargin.amount + portfolio.getAvailableCash().amount}`);
   * ```
   */
  public calculatePortfolioMargin(portfolio: Portfolio): Money {
    let totalMargin = 0;

    for (const [, position] of portfolio.positions.entries()) {
      totalMargin += position.getTotalCost().amount;
    }

    return Money.fromUSDC(totalMargin);
  }

  /**
   * Calculates maximum position size for available cash
   *
   * @param side - Order side (BUY or SELL)
   * @param price - Order price
   * @param availableCash - Available cash amount
   * @returns Maximum quantity that can be ordered
   *
   * @remarks
   * Вычисляет максимальный размер позиции, который можно открыть
   * при заданном available cash.
   *
   * Формулы:
   * ```
   * BUY: maxQuantity = availableCash / price
   * SELL: maxQuantity = availableCash / (1.00 - price)
   * ```
   *
   * @example
   * ```typescript
   * const calculator = new MarginCalculator();
   *
   * // Available cash: $1000
   * const availableCash = Money.fromUSDC(1000);
   *
   * // Max BUY at $0.65
   * const maxBuy = calculator.calculateMaxPositionSize(
   *   'BUY',
   *   Price.fromNumber(0.65),
   *   availableCash
   * );
   * console.log(maxBuy.value); // 1538 shares ($1000 / 0.65)
   *
   * // Max SELL at $0.65
   * const maxSell = calculator.calculateMaxPositionSize(
   *   'SELL',
   *   Price.fromNumber(0.65),
   *   availableCash
   * );
   * console.log(maxSell.value); // 2857 shares ($1000 / 0.35)
   * ```
   */
  public calculateMaxPositionSize(
    side: 'BUY' | 'SELL',
    price: Price,
    availableCash: Money
  ): Quantity {
    if (side === 'BUY') {
      // BUY: maxQuantity = cash / price
      const maxQuantity = availableCash.amount / price.value;
      return Quantity.fromNumber(maxQuantity);
    } else {
      // SELL: maxQuantity = cash / (1.00 - price)
      const maxRiskPerShare = 1.0 - price.value;
      if (maxRiskPerShare <= 0) {
        return Quantity.fromNumber(0);
      }
      const maxQuantity = availableCash.amount / maxRiskPerShare;
      return Quantity.fromNumber(maxQuantity);
    }
  }
}
