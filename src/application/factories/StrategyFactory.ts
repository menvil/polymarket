/**
 * StrategyFactory - фабрика стратегий
 *
 * @remarks
 * Преобразует MarketCandidate → DumbStrategy
 *
 * Фабрика:
 * - Генерирует уникальный strategyId
 * - Извлекает tokenId из market (YES token)
 * - Создаёт DumbStrategyConfig
 * - Создаёт экземпляр DumbStrategy
 *
 * В будущем (v5):
 * - Поддержка разных типов стратегий (SMART, GRID, etc.)
 * - Адаптивный выбор параметров на основе market metadata
 *
 * @example
 * ```typescript
 * const factory = new StrategyFactory(
 *   () => new NoopTelemetrySink()
 * );
 *
 * const market = {
 *   conditionId: 'market-123',
 *   question: 'Will Bitcoin reach $100k?',
 *   outcomes: [
 *     { tokenId: 'token-yes', outcome: 'YES' },
 *     { tokenId: 'token-no', outcome: 'NO' }
 *   ],
 *   // ...
 * };
 *
 * const config = {
 *   strategyType: 'DUMB',
 *   buyPrice: 0.52,
 *   sellPrice: 0.53,
 *   size: 100
 * };
 *
 * const { strategy, config: strategyConfig } = factory.createStrategy(market, config);
 * // → DumbStrategy instance
 * ```
 */

import type { IStrategy } from '../../domain/strategies/IStrategy.js';
import type { DumbStrategyConfig } from '../../domain/strategies/dumb/DumbStrategyConfig.js';
import { DumbStrategy } from '../../domain/strategies/dumb/DumbStrategy.js';
import type { ITelemetrySink } from '../../domain/telemetry/ITelemetrySink.js';
import type { ILogger } from '../../domain/ports/ILogger.js';

/**
 * Market constraints provider interface
 *
 * @remarks
 * Abstraction for getting market-specific constraints (minOrderSize, etc.)
 */
export interface IMarketConstraintsProvider {
  getConstraints(tokenId: string): Promise<{
    minOrderSize: number;
    maxOrderSize: number;
    sizeTick: number;
    priceTick: number;
    minOrderValue: number;
  }>;
}

/**
 * MarketCandidate - кандидат на рынок для стратегии
 *
 * @remarks
 * TODO: Импортировать из MarketDiscoveryService types
 * Пока определён локально для избежания циклических зависимостей.
 */
export interface MarketCandidate {
  conditionId: string; // Market ID
  question: string; // Market question (для UI)
  slug?: string; // Market slug (for API calls - КРИТИЧНО для getMarketConstraints!)
  outcomes: Array<{
    tokenId: string;
    outcome: string; // 'YES' | 'NO'
  }>;
  expirationDate?: Date; // v5.2: Дата истечения рынка
  orderMinSize?: number; // From Gamma API (e.g., 5 shares)
  orderPriceMinTickSize?: number; // From Gamma API (e.g., 0.01)
  // ... другие поля market metadata
}

/**
 * StrategyFactoryConfig - конфигурация фабрики
 *
 * @remarks
 * Параметры для создания стратегии.
 * В будущем: адаптивный выбор на основе market metadata.
 */
export interface StrategyFactoryConfig {
  strategyType: 'DUMB'; // В будущем: 'SMART', 'GRID', etc.
  buyPrice: number; // Цена покупки
  sellPrice: number; // Цена продажи
  size: number; // Размер позиции
}

/**
 * IStrategyFactory - интерфейс фабрики стратегий
 */
export interface IStrategyFactory {
  /**
   * Создать стратегию из MarketCandidate
   *
   * @param market - Кандидат на рынок
   * @param config - Конфигурация стратегии
   * @returns { strategy, config } - Экземпляр стратегии и её конфиг
   *
   * @remarks
   * Алгоритм:
   * 1. Сгенерировать уникальный strategyId
   * 2. Извлечь tokenId из market (YES token)
   * 3. ✅ v6.0: Получить market constraints (minOrderSize)
   * 4. Создать DumbStrategyConfig (с размером из constraints)
   * 5. Создать экземпляр DumbStrategy
   * 6. Вернуть { strategy, config }
   *
   * @example
   * ```typescript
   * const { strategy, config } = await factory.createStrategy(market, {
   *   strategyType: 'DUMB',
   *   buyPrice: 0.52,
   *   sellPrice: 0.53,
   *   size: 10 // Fallback if constraints unavailable
   * });
   * ```
   */
  createStrategy(
    market: MarketCandidate,
    config: StrategyFactoryConfig
  ): Promise<{
    strategy: IStrategy;
    config: DumbStrategyConfig;
  }>;
}

/**
 * StrategyFactory - фабрика для создания стратегий
 *
 * @remarks
 * Реализация фабрики для DumbStrategy.
 * В будущем: поддержка разных типов стратегий.
 *
 * @example
 * ```typescript
 * const factory = new StrategyFactory(
 *   () => new NoopTelemetrySink()
 * );
 *
 * const { strategy, config } = factory.createStrategy(market, {
 *   strategyType: 'DUMB',
 *   buyPrice: 0.52,
 *   sellPrice: 0.53,
 *   size: 100
 * });
 * ```
 */
export class StrategyFactory implements IStrategyFactory {
  /**
   * @param telemetrySinkFactory - Фабрика для создания telemetry sink
   * @param logger - Logger instance
   *
   * @remarks
   * v6.1: orderMinSize теперь берется напрямую из market.orderMinSize (уже в MarketCandidate).
   * constraintsProvider больше не нужен - данные приходят из Gamma API в market discovery.
   *
   * Используем factory function для создания sink на каждую стратегию.
   * Это позволяет изолировать telemetry per-strategy.
   */
  constructor(
    private readonly telemetrySinkFactory: () => ITelemetrySink,
    private readonly logger?: ILogger
  ) {}

  /**
   * Создать стратегию из MarketCandidate
   *
   * @param market - Кандидат на рынок
   * @param config - Конфигурация стратегии
   * @returns { strategy, config }
   *
   * @remarks
   * Алгоритм:
   * 1. Сгенерировать strategyId = 'dumb-{conditionId}'
   * 2. Извлечь tokenId из market.outcomes (YES token)
   * 3. ✅ v6.0: Получить market constraints (minOrderSize)
   * 4. Создать DumbStrategyConfig (с размером из constraints)
   * 5. Создать DumbStrategy instance
   */
  async createStrategy(
    market: MarketCandidate,
    config: StrategyFactoryConfig
  ): Promise<{
    strategy: IStrategy;
    config: DumbStrategyConfig;
  }> {
    // 1. Сгенерировать уникальный strategyId
    const strategyId = `dumb-${market.conditionId}`;

    // 2. Извлечь tokenId из market (первый outcome)
    // Для DumbStrategy не важно какой outcome (YES/NO, Up/Down, etc.)
    if (!market.outcomes || market.outcomes.length === 0) {
      throw new Error(
        `Market ${market.conditionId} does not have any outcomes`
      );
    }
    const firstOutcome = market.outcomes[0];
    const tokenId = firstOutcome.tokenId;

    // ✅ v6.1: Use orderMinSize from market data (already fetched from Gamma API)
    // Priority: market.orderMinSize > config.size (fallback default = 1)
    // ✅ v7.7.15: Add 1% safety margin to minOrderSize to avoid "Size lower than minimum" errors
    // This accounts for:
    // - Rounding errors during sell orders (availableTokens < requiredTokens)
    // - Fee deductions
    // - Price/size tick rounding
    const baseSize = market.orderMinSize ?? config.size;
    const orderSize = market.orderMinSize ? Math.ceil(baseSize * 1.01 * 100) / 100 : baseSize;

    this.logger?.info('[StrategyFactory] Creating strategy for market', {
      conditionId: market.conditionId,
      question: market.question,
      slug: market.slug || 'N/A',
      tokenId: tokenId.substring(0, 16) + '...',
      marketOrderMinSize: market.orderMinSize,
      safetyMargin: market.orderMinSize ? '1%' : 'none',
      configSizeFallback: config.size,
      finalOrderSize: orderSize,
    });

    // 3. Создать DumbStrategyConfig
    const strategyConfig: DumbStrategyConfig = {
      id: strategyId,
      tokenId: tokenId,
      initialSide: 'buy', // Всегда начинаем с buy
      buyPrice: config.buyPrice,
      sellPrice: config.sellPrice,
      size: orderSize, // ✅ v6.0: Размер из market constraints
      outcomeName: firstOutcome.outcome, // ✅ v5.5: Имя outcome (e.g., "Up", "Down")
    };

    // 4. Создать DumbStrategy instance
    const telemetrySink = this.telemetrySinkFactory();
    const strategy = new DumbStrategy(strategyConfig, telemetrySink);

    return { strategy, config: strategyConfig };
  }
}
