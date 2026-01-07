/**
 * ValidationContext - ВСЁ что нужно для validation (БЕЗ IO)
 *
 * @remarks
 * ValidationContext содержит ВСЮ информацию необходимую для валидации ордера.
 * Получается ВНЕВЫШЕ ValidationPipeline (например, в ExecutionService).
 *
 * ValidationPipeline = ЧИСТАЯ функция: (Order, ValidationContext) → Result
 *
 * КРИТИЧЕСКИ ВАЖНО:
 * ✅ ValidationPipeline НЕ делает IO (не HTTP, не database, не async state)
 * ✅ ValidationContext получается ВНЕВЫШЕ (ValidationContextProvider)
 * ✅ Детерминированность: одинаковый (order, context) → одинаковый result
 *
 * Это позволяет:
 * - Replay (использовать исторический context)
 * - Backtest (synthetic context)
 * - Simulation (mock context)
 * - Unit тестирование (без IO)
 *
 * @example
 * ```typescript
 * // Production: ValidationContextProvider делает IO
 * const context = await contextProvider.getContext(tokenId); // HTTP, async
 * const result = validationPipeline.validate(order, context);  // Pure function
 *
 * // Backtest: исторический context (без IO)
 * const historicalContext = backtestData.getContextAt(timestamp); // No IO
 * const result = validationPipeline.validate(order, historicalContext); // Same function!
 *
 * // Unit test: synthetic context
 * const mockContext: ValidationContext = {
 *   balance: 1000,
 *   marketConstraints: { minOrderSize: 10, ... },
 *   positionState: { currentPosition: 0, positionLimit: 1000 },
 *   timestamp: new Date(),
 * };
 * const result = validationPipeline.validate(order, mockContext); // Deterministic
 * ```
 */

/**
 * MarketConstraints - constraints для конкретного рынка
 *
 * @remarks
 * Получаются от MarketConstraintsPolicy (или из cache).
 * Содержат ВСЁ что нужно для валидации size/price.
 */
export interface MarketConstraints {
  /** Минимальный размер ордера */
  minOrderSize: number;

  /** Максимальный размер ордера */
  maxOrderSize: number;

  /** Tick size для округления размера (например, 0.01) */
  sizeTick: number;

  /** Tick size для округления цены (например, 0.01) */
  priceTick: number;

  /** Минимальная цена (обычно 0.01) */
  minPrice: number;

  /** Максимальная цена (обычно 0.99) */
  maxPrice: number;
}

/**
 * PositionState - текущее состояние позиции
 *
 * @remarks
 * Используется для проверки position limits (risk management).
 */
export interface PositionState {
  /** Текущая позиция (в токенах) */
  currentPosition: number;

  /** Максимальная позиция (risk limit) */
  positionLimit: number;

  /** Текущий P&L (опционально, для информации) */
  unrealizedPnl?: number;
}

/**
 * ValidationContext - полный контекст для валидации
 *
 * @remarks
 * Содержит ВСЮ информацию для валидации БЕЗ необходимости делать IO.
 *
 * Получение контекста (ValidationContextProvider):
 * - balance: от BalanceProvider (HTTP или cache)
 * - marketConstraints: от MarketConstraintsPolicy (HTTP или cache)
 * - positionState: от PositionProvider (HTTP или cache)
 * - timestamp: Date.now()
 *
 * ValidationPipeline просто ИСПОЛЬЗУЕТ этот контекст (БЕЗ IO).
 */
export interface ValidationContext {
  /**
   * Доступный баланс USDC
   *
   * @remarks
   * Используется для проверки BUY orders.
   * required = size * price (в USDC)
   */
  balance: number;

  /**
   * Market constraints для токена
   *
   * @remarks
   * Используется для проверки size/price.
   * - size >= minOrderSize
   * - size <= maxOrderSize
   * - price >= minPrice
   * - price <= maxPrice
   */
  marketConstraints: MarketConstraints;

  /**
   * Текущее состояние позиции
   *
   * @remarks
   * Используется для проверки position limits (risk management).
   * currentPosition + orderSize <= positionLimit
   */
  positionState: PositionState;

  /**
   * Timestamp контекста
   *
   * @remarks
   * Используется для:
   * - Replay (replay с историческим timestamp)
   * - Backtest (backtest с synthetic timestamp)
   * - Logging (когда был получен контекст)
   *
   * ВАЖНО: ValidationPipeline НЕ использует Date.now() внутри.
   * Timestamp передаётся явно через context.
   */
  timestamp: Date;
}
