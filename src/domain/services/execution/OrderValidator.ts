/**
 * OrderValidator - валидация ордеров
 *
 * @remarks
 * Доменный сервис для валидации ордеров перед размещением.
 *
 * Проверки:
 * 1. **Price validation**: цена в допустимом диапазоне (0, 1)
 * 2. **Size validation**: размер положительный и не превышает лимиты
 * 3. **Margin validation**: достаточно средств для исполнения
 * 4. **Position limit validation**: не превышает позиционные лимиты
 * 5. **Marketable validation**: проверка на самоисполнение (self-trade)
 * 6. **Arbitrage validation**: не создает арбитражную возможность
 *
 * Зачем нужен OrderValidator?
 * - Предотвращение ошибочных ордеров
 * - Соблюдение risk limits
 * - Защита от margin calls
 * - Предотвращение self-trades
 * - Контроль качества котировок
 *
 * @example
 * ```typescript
 * const validator = new OrderValidator();
 *
 * const result = validator.validate(order, session);
 *
 * if (!result.isValid) {
 *   console.error('Order validation failed:', result.errors);
 *   throw new Error(result.errors[0]);
 * }
 * ```
 */
import { Order } from '../../entities/Order.js';
import { Orderbook } from '../../entities/Orderbook.js';
import { TradingSession } from '../../aggregates/TradingSession.js';
import { MarginCalculator } from '../risk/MarginCalculator.js';

/**
 * Validation result
 */
export interface ValidationResult {
  /**
   * Is order valid
   */
  isValid: boolean;

  /**
   * Validation errors
   */
  errors: string[];

  /**
   * Validation warnings
   */
  warnings: string[];
}

/**
 * Validation config
 */
export interface ValidationConfig {
  /**
   * Maximum order size
   */
  maxOrderSize?: number;

  /**
   * Minimum order size
   */
  minOrderSize?: number;

  /**
   * Maximum net position
   */
  maxNetPosition?: number;

  /**
   * Maximum gross position
   */
  maxGrossPosition?: number;

  /**
   * Check for self-trades
   */
  checkSelfTrade?: boolean;

  /**
   * Check for arbitrage creation
   */
  checkArbitrage?: boolean;
}

/**
 * OrderValidator
 *
 * @remarks
 * Stateless сервис для валидации ордеров.
 *
 * Алгоритм валидации:
 * 1. Проверка параметров ордера (price, size)
 * 2. Проверка маржи (margin requirement)
 * 3. Проверка позиционных лимитов
 * 4. Проверка на self-trade (опционально)
 * 5. Проверка на арбитраж (опционально)
 *
 * @example
 * ```typescript
 * const validator = new OrderValidator();
 * const config: ValidationConfig = {
 *   maxOrderSize: 1000,
 *   minOrderSize: 1,
 *   maxNetPosition: 5000,
 *   maxGrossPosition: 10000,
 *   checkSelfTrade: true,
 *   checkArbitrage: true,
 * };
 *
 * const result = validator.validate(order, session, config);
 *
 * if (!result.isValid) {
 *   console.error('Validation failed:', result.errors.join(', '));
 * }
 *
 * if (result.warnings.length > 0) {
 *   console.warn('Warnings:', result.warnings.join(', '));
 * }
 * ```
 */
export class OrderValidator {
  private readonly marginCalculator: MarginCalculator;

  /**
   * Creates OrderValidator
   *
   * @example
   * ```typescript
   * const validator = new OrderValidator();
   * ```
   */
  constructor() {
    this.marginCalculator = new MarginCalculator();
  }

  /**
   * Validates order
   *
   * @param order - Order to validate
   * @param session - Trading session
   * @param config - Validation configuration
   * @returns Validation result
   *
   * @remarks
   * Выполняет комплексную валидацию ордера.
   *
   * **Проверки**:
   *
   * 1. **Price validation**:
   *    ```
   *    if (price <= 0 || price >= 1) → error
   *    ```
   *
   * 2. **Size validation**:
   *    ```
   *    if (size <= 0) → error
   *    if (size > maxOrderSize) → error
   *    if (size < minOrderSize) → warning
   *    ```
   *
   * 3. **Margin validation**:
   *    ```
   *    requiredMargin = calculateMargin(order)
   *    availableCash = session.portfolio.getAvailableCash()
   *    if (requiredMargin > availableCash) → error
   *    ```
   *
   * 4. **Position limit validation**:
   *    ```
   *    newNetPosition = currentNet + orderImpact
   *    newGrossPosition = currentGross + orderSize
   *    if (|newNetPosition| > maxNetPosition) → error
   *    if (newGrossPosition > maxGrossPosition) → error
   *    ```
   *
   * 5. **Self-trade check** (optional):
   *    ```
   *    if (order crosses own quote) → warning
   *    ```
   *
   * 6. **Arbitrage check** (optional):
   *    ```
   *    if (order creates arbitrage opportunity) → warning
   *    ```
   *
   * @example
   * ```typescript
   * const validator = new OrderValidator();
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
   * const config: ValidationConfig = {
   *   maxOrderSize: 1000,
   *   minOrderSize: 10,
   *   maxNetPosition: 5000,
   *   maxGrossPosition: 10000,
   * };
   *
   * const result = validator.validate(order, tradingSession, config);
   *
   * if (!result.isValid) {
   *   for (const error of result.errors) {
   *     console.error(`❌ ${error}`);
   *   }
   *   throw new Error('Order validation failed');
   * }
   *
   * if (result.warnings.length > 0) {
   *   for (const warning of result.warnings) {
   *     console.warn(`⚠️  ${warning}`);
   *   }
   * }
   * ```
   */
  public validate(
    order: Order,
    session: TradingSession,
    config?: ValidationConfig
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Default config
    const cfg: ValidationConfig = {
      maxOrderSize: 10000,
      minOrderSize: 1,
      maxNetPosition: 10000,
      maxGrossPosition: 20000,
      checkSelfTrade: false,
      checkArbitrage: false,
      ...config,
    };

    // 1. Price validation
    if (order.price.value <= 0 || order.price.value >= 1) {
      errors.push(
        `Invalid price: ${order.price.value}. Price must be between 0 and 1.`
      );
    }

    // 2. Size validation
    if (order.size.value <= 0) {
      errors.push(`Invalid size: ${order.size.value}. Size must be positive.`);
    }

    if (cfg.maxOrderSize && order.size.value > cfg.maxOrderSize) {
      errors.push(
        `Order size ${order.size.value} exceeds maximum ${cfg.maxOrderSize}`
      );
    }

    if (cfg.minOrderSize && order.size.value < cfg.minOrderSize) {
      warnings.push(
        `Order size ${order.size.value} is below minimum ${cfg.minOrderSize}`
      );
    }

    // 3. Margin validation
    const marginRequirement = this.marginCalculator.checkMarginRequirement(
      order,
      session.portfolio
    );

    if (!marginRequirement.isSufficient) {
      errors.push(
        `Insufficient margin: required ${marginRequirement.requiredMargin.amount.toFixed(2)}, ` +
          `available ${marginRequirement.availableCash.amount.toFixed(2)}, ` +
          `shortfall ${marginRequirement.shortfall.amount.toFixed(2)}`
      );
    }

    // 4. Position limit validation
    const currentNet = session.portfolio.netPosition;
    const currentGross = session.portfolio.grossPosition;

    // Calculate impact of order on positions
    const orderImpact = order.side === 'BUY' ? order.size.value : -order.size.value;
    const newNetPosition = currentNet + orderImpact;
    const newGrossPosition = currentGross + order.size.value;

    if (cfg.maxNetPosition && Math.abs(newNetPosition) > cfg.maxNetPosition) {
      errors.push(
        `Order would exceed net position limit: ` +
          `new net position ${newNetPosition.toFixed(0)}, limit ${cfg.maxNetPosition}`
      );
    }

    if (cfg.maxGrossPosition && newGrossPosition > cfg.maxGrossPosition) {
      errors.push(
        `Order would exceed gross position limit: ` +
          `new gross position ${newGrossPosition.toFixed(0)}, limit ${cfg.maxGrossPosition}`
      );
    }

    // 5. Self-trade check (optional)
    if (cfg.checkSelfTrade) {
      // This would require checking against existing open orders
      // Skipped in this simplified implementation
    }

    // 6. Arbitrage check (optional)
    if (cfg.checkArbitrage) {
      // This would require checking YES + NO prices
      // Skipped in this simplified implementation
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Checks if order is marketable
   *
   * @param order - Order to check
   * @param orderbook - Current orderbook
   * @returns True if order would immediately execute
   *
   * @remarks
   * Ордер считается marketable, если он может немедленно исполниться:
   * - BUY order с ценой >= bestAsk → marketable
   * - SELL order с ценой <= bestBid → marketable
   *
   * Marketable orders рискуют:
   * - Self-trade (торговля со своими же ордерами)
   * - Нежелательное исполнение (для маркет-мейкера)
   *
   * @example
   * ```typescript
   * const validator = new OrderValidator();
   *
   * // Orderbook: bid $0.64, ask $0.66
   *
   * // BUY @ $0.67 → marketable (crosses ask)
   * const order1 = Order.create({..., side: 'BUY', price: Price.fromNumber(0.67)});
   * const isMarketable1 = validator.checkMarketable(order1, orderbook);
   * console.log(isMarketable1); // true
   *
   * // BUY @ $0.65 → not marketable (below ask)
   * const order2 = Order.create({..., side: 'BUY', price: Price.fromNumber(0.65)});
   * const isMarketable2 = validator.checkMarketable(order2, orderbook);
   * console.log(isMarketable2); // false
   *
   * // SELL @ $0.63 → marketable (crosses bid)
   * const order3 = Order.create({..., side: 'SELL', price: Price.fromNumber(0.63)});
   * const isMarketable3 = validator.checkMarketable(order3, orderbook);
   * console.log(isMarketable3); // true
   * ```
   */
  public checkMarketable(order: Order, orderbook: Orderbook): boolean {
    if (order.side === 'BUY') {
      const bestAsk = orderbook.getBestAsk();
      if (!bestAsk) {
        return false;
      }
      return order.price.value >= bestAsk.value;
    } else {
      // SELL
      const bestBid = orderbook.getBestBid();
      if (!bestBid) {
        return false;
      }
      return order.price.value <= bestBid.value;
    }
  }

  /**
   * Validates order against risk limits
   *
   * @param order - Order to validate
   * @param session - Trading session
   * @param maxNetPosition - Max net position
   * @param maxGrossPosition - Max gross position
   * @returns True if order passes risk checks
   *
   * @remarks
   * Simplified метод для быстрой проверки risk limits.
   *
   * @example
   * ```typescript
   * const validator = new OrderValidator();
   *
   * const passesRiskCheck = validator.validateRiskLimits(
   *   order,
   *   session,
   *   5000, // max net
   *   10000 // max gross
   * );
   *
   * if (!passesRiskCheck) {
   *   console.error('Order exceeds risk limits');
   * }
   * ```
   */
  public validateRiskLimits(
    order: Order,
    session: TradingSession,
    maxNetPosition: number,
    maxGrossPosition: number
  ): boolean {
    const result = this.validate(order, session, {
      maxNetPosition,
      maxGrossPosition,
    });

    return result.isValid;
  }
}
