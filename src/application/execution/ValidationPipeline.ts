/**
 * ValidationPipeline - ЧИСТАЯ функция для валидации (БЕЗ IO)
 *
 * @remarks
 * ValidationPipeline - это ДЕТЕРМИНИРОВАННАЯ функция:
 * (Order, ValidationContext) → Result<void, ValidationError>
 *
 * КРИТИЧЕСКИ ВАЖНО:
 * ✅ НЕ делает IO (не HTTP, не database, не async state)
 * ✅ Получает ValidationContext как параметр (готовый контекст, БЕЗ IO)
 * ✅ Детерминированная: одинаковый (order, context) → одинаковый result
 * ✅ Синхронная (может быть sync, но для единообразия async)
 *
 * ValidationContext получается ВНЕВЫШЕ ValidationPipeline:
 * - Production: ValidationContextProvider делает HTTP/async IO
 * - Backtest: исторический context (без IO)
 * - Simulation: synthetic context (без IO)
 * - Unit tests: mock context (без IO)
 *
 * Это позволяет:
 * - Replay (использовать исторический context)
 * - Backtest (synthetic context)
 * - Unit тестирование (без IO, без mocks)
 * - Детерминированность (одинаковый input → одинаковый output)
 *
 * Алгоритм validation:
 * 1. Проверить size constraints (min/max)
 * 2. Проверить balance (USDC для BUY, tokens для SELL)
 * 3. Проверить position limits (risk management)
 * 4. Вернуть Result (Ok или ValidationError)
 *
 * @example
 * ```typescript
 * // Production: ValidationContextProvider делает IO
 * const context = await contextProvider.getContext(tokenId); // HTTP, async
 * const result = validationPipeline.validate(order, context);  // Pure function
 *
 * // Backtest: исторический context (БЕЗ IO)
 * const historicalContext = backtestData.getContextAt(timestamp); // No IO
 * const result = validationPipeline.validate(order, historicalContext); // Same function!
 *
 * // Unit test: synthetic context
 * const mockContext: ValidationContext = {
 *   balance: 1000,
 *   marketConstraints: { minOrderSize: 10, maxOrderSize: 10000, ... },
 *   positionState: { currentPosition: 0, positionLimit: 1000 },
 *   timestamp: new Date(),
 * };
 * const result = validationPipeline.validate(order, mockContext); // Deterministic
 * ```
 */

import type { Order } from '../../domain/entities/Order.js';
import type { ValidationContext } from '../../domain/types/ValidationContext.js';
import type { ValidationError } from '../../domain/types/ValidationError.js';
import { ValidationErrorCode } from '../../domain/types/ValidationError.js';
import type { Result } from '../../shared/types/Result.js';
import { Ok, Err } from '../../shared/types/Result.js';
import type { ILogger } from '../../domain/ports/ILogger.js';

/**
 * ValidationPipeline - чистая функция для валидации
 *
 * @remarks
 * Stateless класс - можно переиспользовать instance.
 * Единственная dependency: ILogger (для structured logging).
 *
 * НЕТ dependencies на:
 * - MarketConstraintsPolicy (делает IO) ❌
 * - BalancePolicy (может делать IO) ❌
 * - PositionProvider (делает IO) ❌
 *
 * ВСЯ информация приходит через ValidationContext.
 */
export class ValidationPipeline {
  /**
   * Создаёт ValidationPipeline
   *
   * @param logger - Logger для structured logging
   *
   * @remarks
   * Logger - единственная dependency.
   * Logging НЕ влияет на детерминированность (это side effect для observability).
   */
  constructor(private readonly logger: ILogger) {}

  /**
   * Валидирует order с готовым контекстом
   *
   * @param order - Order intent (уже normalized)
   * @param context - ValidationContext (получен ВНЕВЫШЕ, БЕЗ IO)
   * @returns Result<void, ValidationError>
   *
   * @remarks
   * ЧИСТАЯ ФУНКЦИЯ:
   * - Детерминированная: (order, context) → result
   * - Не делает HTTP
   * - Не читает state
   * - Не использует Date.now() (timestamp в context)
   *
   * Алгоритм:
   * 1. Validate size constraints (min/max)
   * 2. Validate balance (USDC для BUY, tokens для SELL)
   * 3. Validate position limits (risk management)
   * 4. Return Ok(void) или Err(ValidationError)
   *
   * ВАЖНО:
   * - Validation выполняется ПОСЛЕ normalization
   * - Order должен быть уже normalized (size/price округлены)
   * - Если validation fails → ExecutionService вернёт REJECTED
   *
   * @example
   * ```typescript
   * const result = validationPipeline.validate(order, context);
   *
   * if (result.ok) {
   *   // Order прошёл все проверки, можно отправлять в Gateway
   *   await gateway.placeOrder(order);
   * } else {
   *   // Validation failed
   *   console.error('Rejected:', result.error.type);
   * }
   * ```
   */
  public validate(order: Order, context: ValidationContext): Result<void, ValidationError> {
    // Validation #1: Size constraints
    const sizeValidation = this.validateSize(order, context);
    if (!sizeValidation.ok) {
      return sizeValidation;
    }

    // Validation #2: Price constraints (опционально, если нужна проверка)
    const priceValidation = this.validatePrice(order, context);
    if (!priceValidation.ok) {
      return priceValidation;
    }

    // Validation #3: Balance
    const balanceValidation = this.validateBalance(order, context);
    if (!balanceValidation.ok) {
      return balanceValidation;
    }

    // Validation #4: Position limits
    const positionValidation = this.validatePositionLimits(order, context);
    if (!positionValidation.ok) {
      return positionValidation;
    }

    // All validations passed
    this.logger.debug('[ValidationPipeline] Order validated successfully', {
      orderId: order.id,
      tokenId: order.tokenId.substring(0, 16) + '...',
      size: order.size.value,
      price: order.price.value,
    });

    return Ok(undefined);
  }

  /**
   * Валидирует size constraints
   *
   * @remarks
   * Проверяет:
   * - size >= minOrderSize
   * - size <= maxOrderSize
   */
  private validateSize(
    order: Order,
    context: ValidationContext
  ): Result<void, ValidationError> {
    const { minOrderSize, maxOrderSize } = context.marketConstraints;

    if (order.size.value < minOrderSize) {
      this.logger.warn('[ValidationPipeline] Size below minimum', {
        size: order.size.value,
        minOrderSize,
        tokenId: order.tokenId.substring(0, 16) + '...',
      });

      return Err({
        type: 'INVALID_SIZE',
        code: ValidationErrorCode.INVALID_SIZE,
        min: minOrderSize,
        max: maxOrderSize,
        provided: order.size.value,
        tokenId: order.tokenId,
      });
    }

    if (order.size.value > maxOrderSize) {
      this.logger.warn('[ValidationPipeline] Size above maximum', {
        size: order.size.value,
        maxOrderSize,
        tokenId: order.tokenId.substring(0, 16) + '...',
      });

      return Err({
        type: 'INVALID_SIZE',
        code: ValidationErrorCode.INVALID_SIZE,
        min: minOrderSize,
        max: maxOrderSize,
        provided: order.size.value,
        tokenId: order.tokenId,
      });
    }

    return Ok(undefined);
  }

  /**
   * Валидирует price constraints
   *
   * @remarks
   * Проверяет:
   * - price >= minPrice (обычно 0.01)
   * - price <= maxPrice (обычно 0.99)
   */
  private validatePrice(
    order: Order,
    context: ValidationContext
  ): Result<void, ValidationError> {
    const { minPrice, maxPrice } = context.marketConstraints;

    if (order.price.value < minPrice) {
      this.logger.warn('[ValidationPipeline] Price below minimum', {
        price: order.price.value,
        minPrice,
      });

      return Err({
        type: 'INVALID_PRICE',
        code: ValidationErrorCode.INVALID_PRICE,
        min: minPrice,
        max: maxPrice,
        provided: order.price.value,
      });
    }

    if (order.price.value > maxPrice) {
      this.logger.warn('[ValidationPipeline] Price above maximum', {
        price: order.price.value,
        maxPrice,
      });

      return Err({
        type: 'INVALID_PRICE',
        code: ValidationErrorCode.INVALID_PRICE,
        min: minPrice,
        max: maxPrice,
        provided: order.price.value,
      });
    }

    return Ok(undefined);
  }

  /**
   * Валидирует баланс
   *
   * @remarks
   * Проверяет:
   * - BUY: required USDC = size * price <= available USDC
   * - SELL: required tokens = size <= available tokens
   *
   * NOTE: Пока проверяем только BUY (USDC balance).
   * SELL требует token balance (будет добавлено позже).
   */
  private validateBalance(
    order: Order,
    context: ValidationContext
  ): Result<void, ValidationError> {
    const availableBalance = context.balance;

    if (order.side === 'BUY') {
      // BUY: нужен USDC (cost = size * price)
      const required = order.size.value * order.price.value;

      if (required > availableBalance) {
        this.logger.warn('[ValidationPipeline] Insufficient USDC balance', {
          required: required.toFixed(2),
          available: availableBalance.toFixed(2),
          orderId: order.id,
        });

        return Err({
          type: 'INSUFFICIENT_BALANCE',
          code: ValidationErrorCode.INSUFFICIENT_BALANCE,
          required,
          available: availableBalance,
          asset: 'USDC',
        });
      }
    } else if (order.side === 'SELL') {
      // SELL: нужны tokens (size)
      // TODO: Проверить token balance когда будет PositionProvider
      // Пока пропускаем (считаем что tokens есть)
    }

    return Ok(undefined);
  }

  /**
   * Валидирует position limits
   *
   * @remarks
   * Проверяет:
   * - currentPosition + orderSize <= positionLimit
   *
   * Это risk management constraint.
   */
  private validatePositionLimits(
    order: Order,
    context: ValidationContext
  ): Result<void, ValidationError> {
    const { currentPosition, positionLimit } = context.positionState;

    // Вычисляем новую позицию после исполнения ордера
    const newPosition =
      order.side === 'BUY'
        ? currentPosition + order.size.value
        : currentPosition - order.size.value;

    if (Math.abs(newPosition) > positionLimit) {
      this.logger.warn('[ValidationPipeline] Position limit exceeded', {
        currentPosition,
        orderSize: order.size.value,
        newPosition,
        positionLimit,
        tokenId: order.tokenId.substring(0, 16) + '...',
      });

      return Err({
        type: 'POSITION_LIMIT_EXCEEDED',
        code: ValidationErrorCode.POSITION_LIMIT_EXCEEDED,
        current: currentPosition,
        limit: positionLimit,
        tokenId: order.tokenId,
      });
    }

    return Ok(undefined);
  }
}
