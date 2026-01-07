/**
 * ValidationContextProvider - получает ValidationContext (делает IO)
 *
 * @remarks
 * ValidationContextProvider ОТДЕЛЁН от ValidationPipeline.
 * ValidationPipeline = чистая функция (БЕЗ IO).
 * ValidationContextProvider = IO слой (HTTP, async state).
 *
 * Ответственность:
 * - Получить market constraints (от MarketConstraintsPolicy или cache)
 * - Получить balance (от BalanceProvider или cache)
 * - Получить position state (от PositionProvider или cache)
 * - Собрать ValidationContext
 *
 * Использование в разных сценариях:
 * - Production: делает реальные HTTP запросы
 * - Backtest: возвращает исторические данные (из database)
 * - Simulation: возвращает synthetic данные (mock)
 * - Tests: возвращает mock ValidationContext
 *
 * Это позволяет:
 * - ValidationPipeline остаётся чистой функцией (детерминированной)
 * - Легко подменить источник данных (backtest, simulation)
 * - Легко тестировать ValidationPipeline (без IO)
 *
 * @example
 * ```typescript
 * // Production
 * const contextProvider = new ValidationContextProvider(
 *   marketConstraintsPolicy,
 *   balanceProvider,
 *   positionProvider
 * );
 *
 * const context = await contextProvider.getContext(tokenId); // HTTP, async
 * const result = validationPipeline.validate(order, context);  // Pure function
 *
 * // Backtest (заменить provider на backtest implementation)
 * const backtestProvider = new BacktestValidationContextProvider(backtestData);
 * const context = await backtestProvider.getContext(tokenId, timestamp); // No HTTP
 * const result = validationPipeline.validate(order, context); // Same pipeline!
 * ```
 */

import type { ValidationContext, MarketConstraints } from '../../domain/types/ValidationContext.js';
import type { MarketConstraintsPolicy } from '../../infrastructure/exchange/policies/MarketConstraintsPolicy.js';
import type { ILogger } from '../../domain/ports/ILogger.js';

/**
 * IBalanceProvider - интерфейс для получения баланса
 *
 * @remarks
 * Абстракция над источником balance data.
 * Позволяет подменить implementation (production, backtest, mock).
 */
export interface IBalanceProvider {
  /**
   * Получает доступный баланс USDC
   *
   * @returns Доступный баланс USDC
   */
  getAvailableBalance(): Promise<number>;
}

/**
 * IPositionProvider - интерфейс для получения позиции
 *
 * @remarks
 * Абстракция над источником position data.
 * Позволяет подменить implementation (production, backtest, mock).
 */
export interface IPositionProvider {
  /**
   * Получает текущую позицию для токена
   *
   * @param tokenId - Token ID
   * @returns Position state (current position + limit)
   */
  getPositionState(tokenId: string): Promise<{
    currentPosition: number;
    positionLimit: number;
    unrealizedPnl?: number;
  }>;
}

/**
 * ValidationContextProvider - собирает ValidationContext (делает IO)
 *
 * @remarks
 * Делает HTTP запросы и async IO для получения ValidationContext.
 * ОТДЕЛЁН от ValidationPipeline (чистой функции).
 */
export class ValidationContextProvider {
  /**
   * Создаёт ValidationContextProvider
   *
   * @param marketConstraintsPolicy - Policy для получения market constraints
   * @param balanceProvider - Provider для получения balance
   * @param positionProvider - Provider для получения position state
   * @param logger - Logger для structured logging
   *
   * @remarks
   * Все dependencies делают IO (HTTP, async state).
   * ValidationContextProvider координирует их вызовы.
   */
  constructor(
    private readonly marketConstraintsPolicy: MarketConstraintsPolicy,
    private readonly balanceProvider: IBalanceProvider,
    private readonly positionProvider: IPositionProvider,
    private readonly logger: ILogger
  ) {}

  /**
   * Получает ValidationContext (с IO)
   *
   * @param tokenId - Token ID для получения constraints
   * @returns ValidationContext (готовый для ValidationPipeline)
   *
   * @remarks
   * Делает параллельные HTTP запросы:
   * 1. marketConstraintsPolicy.getConstraints(tokenId) - HTTP
   * 2. balanceProvider.getAvailableBalance() - HTTP или cache
   * 3. positionProvider.getPositionState(tokenId) - HTTP или cache
   *
   * Все запросы идут параллельно (Promise.all).
   *
   * @example
   * ```typescript
   * const context = await contextProvider.getContext(tokenId);
   *
   * // Context готов для ValidationPipeline (БЕЗ IO)
   * const result = validationPipeline.validate(order, context);
   * ```
   */
  public async getContext(tokenId: string): Promise<ValidationContext> {
    this.logger.debug('[ValidationContextProvider] Fetching validation context', {
      tokenId: tokenId.substring(0, 16) + '...',
    });

    // Fetch all data in parallel (оптимизация latency)
    const [constraints, balance, positionState] = await Promise.all([
      this.getMarketConstraints(tokenId),
      this.getBalance(),
      this.getPositionState(tokenId),
    ]);

    const context: ValidationContext = {
      balance,
      marketConstraints: constraints,
      positionState,
      timestamp: new Date(), // Timestamp когда был получен контекст
    };

    this.logger.debug('[ValidationContextProvider] Context fetched successfully', {
      tokenId: tokenId.substring(0, 16) + '...',
      balance: balance.toFixed(2),
      minOrderSize: constraints.minOrderSize,
      maxOrderSize: constraints.maxOrderSize,
      currentPosition: positionState.currentPosition,
    });

    return context;
  }

  /**
   * Получает market constraints
   *
   * @remarks
   * Делает HTTP запрос или читает из cache.
   * MarketConstraintsPolicy может кэшировать результаты.
   */
  private async getMarketConstraints(tokenId: string): Promise<MarketConstraints> {
    try {
      const constraints = await this.marketConstraintsPolicy.getConstraints(tokenId);

      // Infrastructure MarketConstraints has: minOrderSize, sizeTick, maxOrderSize?, timestamp
      // Domain MarketConstraints needs: all above + priceTick, minPrice, maxPrice
      return {
        minOrderSize: constraints.minOrderSize,
        maxOrderSize: constraints.maxOrderSize ?? 10000, // Default max if not provided
        sizeTick: constraints.sizeTick,
        priceTick: 0.01, // Default priceTick (not in infrastructure type)
        minPrice: 0.01, // Default минимум (not in infrastructure type)
        maxPrice: 0.99, // Default максимум (not in infrastructure type)
      };
    } catch (error) {
      // Fallback на default constraints если не удалось получить
      this.logger.error('[ValidationContextProvider] Failed to fetch constraints', {
        tokenId: tokenId.substring(0, 16) + '...',
        error: error instanceof Error ? error.message : String(error),
      });

      // Вернуть conservative defaults
      return {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };
    }
  }

  /**
   * Получает доступный баланс
   *
   * @remarks
   * Делает HTTP запрос или читает из cache.
   */
  private async getBalance(): Promise<number> {
    try {
      return await this.balanceProvider.getAvailableBalance();
    } catch (error) {
      this.logger.error('[ValidationContextProvider] Failed to fetch balance', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback: вернуть 0 (все ордера будут rejected по balance)
      return 0;
    }
  }

  /**
   * Получает position state
   *
   * @remarks
   * Делает HTTP запрос или читает из cache.
   */
  private async getPositionState(tokenId: string): Promise<{
    currentPosition: number;
    positionLimit: number;
    unrealizedPnl?: number;
  }> {
    try {
      return await this.positionProvider.getPositionState(tokenId);
    } catch (error) {
      this.logger.error('[ValidationContextProvider] Failed to fetch position state', {
        tokenId: tokenId.substring(0, 16) + '...',
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback: вернуть default state
      return {
        currentPosition: 0,
        positionLimit: 10000, // Conservative default
      };
    }
  }
}
