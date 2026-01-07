/**
 * BalancePolicy - политика для проверки баланса перед размещением ордеров
 *
 * @remarks
 * Проверяет достаточность баланса для размещения ордера.
 *
 * Алгоритм проверки:
 * 1. Для BUY ордеров: проверяет USDC баланс (cost = size * price)
 * 2. Для SELL ордеров: проверяет баланс outcome токенов (size)
 * 3. Учитывает locked баланс в открытых ордерах
 * 4. Возвращает BalanceCheckResult
 *
 * Responsibilities:
 * - Валидация баланса для BUY/SELL ордеров
 * - Расчёт required баланса (cost для BUY, size для SELL)
 * - Проверка available vs required
 * - Формирование понятных error messages
 *
 * @example
 * ```typescript
 * const policy = new BalancePolicy(logger);
 *
 * // Check balance for BUY order
 * const buyOrder = Order.create({
 *   side: OrderSide.BUY,
 *   price: Price.fromNumber(0.55),
 *   size: Quantity.fromNumber(100),
 *   tokenId: '0xabc'
 * });
 *
 * const result = policy.checkBalance(buyOrder, 1000); // 1000 USDC available
 * if (result.isValid) {
 *   console.log('Sufficient balance');
 * } else {
 *   console.error(result.reason); // "Insufficient USDC balance..."
 * }
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { Order, OrderSide } from '../../../domain/entities/Order.js';
import type { BalanceCheckResult } from './types.js';

/**
 * BalancePolicy - управление проверками баланса
 *
 * @remarks
 * Stateless класс (можно сделать методы static, но оставляем instance для логирования).
 * Thread-safe для single-threaded JS (no shared state).
 */
export class BalancePolicy {
  /**
   * Создаёт BalancePolicy
   *
   * @param logger - Logger для debugging
   *
   * @example
   * ```typescript
   * const logger = new ConsoleLogger();
   * const policy = new BalancePolicy(logger);
   * ```
   */
  constructor(private readonly logger: ILogger) {}

  /**
   * Проверяет баланс для размещения ордера
   *
   * @param order - Ордер для проверки
   * @param availableBalance - Доступный баланс (USDC для BUY, outcome tokens для SELL)
   * @returns Результат проверки баланса
   *
   * @remarks
   * Алгоритм:
   * 1. Определяет side ордера (BUY/SELL)
   * 2. Вычисляет required баланс:
   *    - BUY: cost = size * price (USDC)
   *    - SELL: required = size (outcome tokens)
   * 3. Сравнивает available vs required
   * 4. Формирует BalanceCheckResult
   *
   * NOTE: availableBalance должен уже учитывать locked баланс:
   *   availableBalance = totalBalance - lockedInOrders
   *
   * @example
   * ```typescript
   * // BUY order example
   * const buyOrder = Order.create({
   *   side: OrderSide.BUY,
   *   price: Price.fromNumber(0.55),
   *   size: Quantity.fromNumber(100),
   *   tokenId: '0xabc'
   * });
   *
   * const result = policy.checkBalance(buyOrder, 1000);
   * // Required: 100 * 0.55 = 55 USDC
   * // Available: 1000 USDC
   * // Result: { isValid: true, required: 55, available: 1000 }
   *
   * // Insufficient balance example
   * const result2 = policy.checkBalance(buyOrder, 50);
   * // Result: { isValid: false, required: 55, available: 50, reason: "Insufficient USDC balance..." }
   * ```
   */
  public checkBalance(order: Order, availableBalance: number): BalanceCheckResult {
    const side = order.side;

    // Calculate required balance based on order side
    let required: number;
    let asset: string;

    if (side === 'BUY') {
      // BUY: need USDC to purchase outcome tokens
      // cost = size * price
      const size = order.size.value;
      const price = order.price.value;
      required = size * price;
      asset = 'USDC';

      this.logger.debug(
        `[BalancePolicy] Checking BUY order balance: size=${size}, price=${price}, required=${required.toFixed(2)} ${asset}`
      );
    } else {
      // SELL: need outcome tokens to sell
      // required = size
      required = order.size.value;
      asset = 'outcome tokens';

      this.logger.debug(
        `[BalancePolicy] Checking SELL order balance: size=${required}, required=${required} ${asset}`
      );
    }

    // Check if sufficient balance
    const isValid = availableBalance >= required;

    if (isValid) {
      this.logger.debug(
        `[BalancePolicy] ✓ Sufficient balance: available=${availableBalance.toFixed(2)} >= required=${required.toFixed(2)} ${asset}`
      );

      return {
        isValid: true,
        required,
        available: availableBalance,
      };
    } else {
      const reason = this.formatInsufficientBalanceReason(side, required, availableBalance, asset);

      this.logger.warn(
        `[BalancePolicy] ✗ Insufficient balance: available=${availableBalance.toFixed(2)} < required=${required.toFixed(2)} ${asset}`
      );

      return {
        isValid: false,
        required,
        available: availableBalance,
        reason,
      };
    }
  }

  /**
   * Проверяет баланс с запасом (margin)
   *
   * @param order - Ордер для проверки
   * @param availableBalance - Доступный баланс
   * @param marginPercent - Процент запаса (0.05 = 5% margin)
   * @returns Результат проверки баланса с учётом margin
   *
   * @remarks
   * Используется для перестраховки:
   * - Гарантирует, что после ордера останется запас
   * - Полезно для предотвращения edge cases (fees, slippage)
   *
   * Алгоритм:
   * 1. Вычисляет required с margin: required * (1 + marginPercent)
   * 2. Вызывает checkBalance с увеличенным required
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   side: OrderSide.BUY,
   *   price: Price.fromNumber(0.55),
   *   size: Quantity.fromNumber(100),
   *   tokenId: '0xabc'
   * });
   *
   * // Check with 10% margin
   * const result = policy.checkBalanceWithMargin(order, 1000, 0.1);
   * // Required: 100 * 0.55 * 1.1 = 60.5 USDC (with 10% margin)
   * // Available: 1000 USDC
   * // Result: { isValid: true, required: 60.5, available: 1000 }
   * ```
   */
  public checkBalanceWithMargin(
    order: Order,
    availableBalance: number,
    marginPercent: number
  ): BalanceCheckResult {
    if (marginPercent < 0 || marginPercent > 1) {
      throw new Error(`Invalid marginPercent: ${marginPercent} (must be in [0, 1])`);
    }

    this.logger.debug(
      `[BalancePolicy] Checking balance with ${(marginPercent * 100).toFixed(1)}% margin`
    );

    // Calculate required with margin
    const side = order.side;
    const baseRequired =
      side === 'BUY'
        ? order.size.value * order.price.value
        : order.size.value;

    const requiredWithMargin = baseRequired * (1 + marginPercent);

    // Check if sufficient balance with margin
    const isValid = availableBalance >= requiredWithMargin;
    const asset = side === 'BUY' ? 'USDC' : 'outcome tokens';

    // Format result
    return {
      isValid,
      required: requiredWithMargin,
      available: availableBalance,
      reason: isValid
        ? undefined
        : this.formatInsufficientBalanceReason(
            side,
            requiredWithMargin,
            availableBalance,
            asset
          ),
    };
  }

  /**
   * Вычисляет стоимость ордера (required balance)
   *
   * @param order - Ордер
   * @returns Требуемый баланс
   *
   * @remarks
   * Utility метод для расчёта стоимости ордера.
   * - BUY: cost = size * price (USDC)
   * - SELL: cost = size (outcome tokens)
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   side: OrderSide.BUY,
   *   price: Price.fromNumber(0.55),
   *   size: Quantity.fromNumber(100),
   *   tokenId: '0xabc'
   * });
   *
   * const cost = policy.calculateOrderCost(order);
   * console.log(cost); // 55 (100 * 0.55)
   * ```
   */
  public calculateOrderCost(order: Order): number {
    if (order.side === 'BUY') {
      return order.size.value * order.price.value;
    } else {
      return order.size.value;
    }
  }

  /**
   * Форматирует reason для insufficient balance
   *
   * @param side - Сторона ордера
   * @param required - Требуемый баланс
   * @param available - Доступный баланс
   * @param asset - Название актива
   * @returns Formatted reason string
   */
  private formatInsufficientBalanceReason(
    side: OrderSide,
    required: number,
    available: number,
    asset: string
  ): string {
    const deficit = required - available;

    if (side === 'BUY') {
      return `Insufficient ${asset} balance: required ${required.toFixed(2)}, available ${available.toFixed(2)}, deficit ${deficit.toFixed(2)}`;
    } else {
      return `Insufficient ${asset}: required ${required.toFixed(2)}, available ${available.toFixed(2)}, deficit ${deficit.toFixed(2)}`;
    }
  }
}
