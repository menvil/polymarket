/**
 * Polymarket Market Data REST Client
 *
 * @remarks
 * Handles Polymarket Gamma API endpoints:
 * - GET /markets - Get all markets
 * - GET /markets/{tokenId} - Get specific market info
 *
 * Returns RAW API responses (NOT normalized).
 * Normalization is done by mappers in higher layers.
 *
 * **IMPORTANT**: This uses Gamma API (public API), NOT CLOB API.
 * Base URL: https://gamma-api.polymarket.com
 *
 * This replaces GammaApiClient.
 *
 * @example
 * ```typescript
 * const client = new PolymarketMarketDataRestClient(config, logger);
 *
 * const markets = await client.getActiveMarkets();
 * console.log(`Active markets: ${markets.length}`);
 *
 * const market = await client.getMarketInfo('0x123');
 * console.log(`Market: ${market.question}`);
 *
 * const constraints = await client.getMarketConstraints('0x123');
 * console.log(`Min size: ${constraints.minimum_order_size}`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { GammaMarketData } from '../../stubs/domain/services/market-discovery/types.js';
import type { IMarketDataProvider } from '../../stubs/domain/services/market-discovery/MarketDiscoveryService.js';

/**
 * Market data client configuration
 */
export interface MarketDataClientConfig {
  /** Gamma API base URL */
  baseUrl: string;

  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Market outcome response (raw API format)
 */
export interface MarketOutcomeResponse {
  /** Token ID */
  token_id: string;

  /** Outcome name (e.g., "Up", "Down") */
  name: string;

  /** Current price */
  price?: string;
}

/**
 * Market info response (raw API format from Gamma API)
 *
 * @remarks
 * Gamma API returns camelCase field names, NOT snake_case!
 *
 * Example: https://gamma-api.polymarket.com/markets
 */
export interface MarketInfoResponse {
  /** Market condition ID */
  conditionId: string;

  /** Market question */
  question: string;

  /** Market slug for URLs */
  slug?: string;

  /** CLOB token IDs - JSON string array */
  clobTokenIds: string;  // Всегда строка из API: "[\"token1\", \"token2\"]"

  /** Outcomes - JSON string array */
  outcomes: string;  // Всегда строка из API: "[\"Yes\", \"No\"]"

  /** Market status */
  active: boolean;

  /** Market closed status */
  closed: boolean;

  /** Order book enabled */
  enableOrderBook: boolean;

  /** End date (ISO string) */
  endDate: string;  // ISO format: "2026-01-25T00:00:00Z"

  /** Liquidity (string number) */
  liquidity?: string;

  /** Volume (string number) */
  volume?: string;

  /** Spread (bid-ask spread) */
  spread?: number;

  /** Best bid price */
  bestBid?: number;

  /** Best ask price */
  bestAsk?: number;

  /** Outcome prices - JSON string array */
  outcomePrices?: string;

  /** Order price minimum tick size */
  orderPriceMinTickSize?: number;

  /** Order minimum size */
  orderMinSize?: number;
}

/**
 * Market constraints
 */
export interface MarketConstraintsResponse {
  /** Minimum order VALUE in USD for BUY orders ($1) */
  minimum_order_value?: number;

  /** Minimum order SIZE in shares for SELL orders */
  minimum_order_size?: number;

  /** Maximum order size */
  maximum_order_size: number;

  /** Size tick (minimum size increment) */
  minimum_tick_size: number;

  /** Price tick (minimum price increment) */
  minimum_price_tick: number;
}

/**
 * Polymarket Market Data REST Client
 *
 * @remarks
 * Implements IMarketDataProvider for use with MarketDiscoveryService.
 * Maps raw API responses (snake_case) to domain types (camelCase).
 */
export class PolymarketMarketDataRestClient implements IMarketDataProvider {
  private readonly config: Required<MarketDataClientConfig>;
  private readonly logger: ILogger;

  /**
   * Create Polymarket market data client
   *
   * @param config - Client configuration
   * @param logger - Logger instance
   *
   * @example
   * ```typescript
   * const client = new PolymarketMarketDataRestClient({
   *   baseUrl: 'https://gamma-api.polymarket.com',
   * }, logger);
   * ```
   */
  constructor(config: MarketDataClientConfig, logger: ILogger) {
    this.config = {
      ...config,
      timeout: config.timeout ?? 30000, // 30 секунд по умолчанию
    };

    this.logger = logger.child?.('PolymarketMarketDataRestClient') ?? logger;
  }

  /**
   * Get all active markets (IMarketDataProvider implementation)
   *
   * @returns Array of market data in domain format (GammaMarketData)
   * @throws {Error} If API call fails
   *
   * @remarks
   * Implements IMarketDataProvider interface.
   * Fetches raw API data and maps to domain format (camelCase).
   *
   * @example
   * ```typescript
   * const markets = await client.getActiveMarkets();
   * console.log(`Active markets: ${markets.length}`);
   *
   * markets.forEach(market => {
   *   console.log(`${market.question} - Ends: ${market.endDate}`);
   * });
   * ```
   */
  async getActiveMarkets(): Promise<GammaMarketData[]> {
    const allMarkets: GammaMarketData[] = [];
    let offset = 0;
    const limit = 500;
    const maxPages = 50; // Max 25,000 markets

    this.logger.info('[Gamma API] Fetching active markets...');

    try {
      for (let page = 0; page < maxPages; page++) {
        const url = new URL(`${this.config.baseUrl}/markets`);
        url.searchParams.set('closed', 'false');
        url.searchParams.set('limit', limit.toString());
        url.searchParams.set('offset', offset.toString());
        url.searchParams.set('order', 'volume'); // Сортировка по объёму
        url.searchParams.set('ascending', 'false'); // По убыванию (наибольший объём первым)

        const rawMarkets = await this.fetch<MarketInfoResponse[]>(url.toString(), true);

        if (rawMarkets.length === 0) {
          break;
        }

        // Маппируем и накапливаем
        const mappedMarkets = rawMarkets.map((raw) => this.mapToDomainFormat(raw));
        allMarkets.push(...mappedMarkets);

        offset += limit;

        // Если получили меньше limit, значит достигли конца
        if (rawMarkets.length < limit) {
          break;
        }
      }

      this.logger.info('[Gamma API] Fetched active markets', {
        total: allMarkets.length,
      });

      return allMarkets;
    } catch (error) {
      this.logger.error('[Gamma API] Failed to fetch active markets', { err: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    }
  }

  /**
   * Get raw active markets (for internal use)
   *
   * @returns Array of raw market info responses
   * @throws {Error} If API call fails
   *
   * @remarks
   * Returns raw API response without mapping.
   * Use getActiveMarkets() for domain format.
   */
  async getRawActiveMarkets(): Promise<MarketInfoResponse[]> {
    this.logger.debug('Getting raw active markets');

    const url = `${this.config.baseUrl}/markets?active=true`;
    const markets = await this.fetch<MarketInfoResponse[]>(url);

    this.logger.debug('Raw active markets retrieved', {
      count: markets.length,
    });

    return markets;
  }

  /**
   * Get market info by slug or condition ID
   *
   * @param slugOrConditionId - Market slug (preferred) or condition ID (fallback)
   * @returns Market info
   * @throws {Error} If API call fails or market not found
   *
   * @remarks
   * Gamma API primarily uses **slug** (e.g., "bitcoin-up-or-down-january-8")
   * for /markets/{slug} endpoint, NOT conditionId.
   *
   * If the API returns 404, conditionId might work as fallback for some markets.
   *
   * @example
   * ```typescript
   * // Preferred: use slug
   * const market = await client.getMarketInfo('bitcoin-up-or-down-january-8');
   *
   * // Fallback: use conditionId (may not work for all markets)
   * const market2 = await client.getMarketInfo('0x123...');
   * ```
   */
  async getMarketInfo(slugOrConditionId: string): Promise<MarketInfoResponse> {
    this.logger.debug('Getting market info', { slugOrConditionId });

    const url = `${this.config.baseUrl}/markets/${slugOrConditionId}`;
    const market = await this.fetch<MarketInfoResponse>(url);

    this.logger.debug('Market info retrieved', {
      slug: market.slug,
      conditionId: market.conditionId,
      question: market.question,
      active: market.active,
    });

    return market;
  }

  /**
   * Get market constraints
   *
   * @param slugOrConditionId - Market slug (preferred) or condition ID (fallback)
   * @returns Market constraints
   * @throws {Error} If API call fails
   *
   * @remarks
   * Returns min/max sizes, tick sizes, etc.
   * If constraints are not available from API, returns safe defaults.
   *
   * **IMPORTANT**: Gamma API uses **slug** (NOT conditionId) for /markets/{id}.
   * If you pass conditionId and get HTTP 422 "id is invalid", this is expected.
   * The method will fallback to safe defaults.
   *
   * For best results, pass market.slug instead of market.conditionId.
   *
   * @example
   * ```typescript
   * // Preferred: use slug
   * const constraints = await client.getMarketConstraints('bitcoin-up-or-down-january-8');
   *
   * // Fallback: use conditionId (will return defaults on 422)
   * const constraints2 = await client.getMarketConstraints('0x123...');
   * ```
   */
  async getMarketConstraints(slugOrConditionId: string): Promise<MarketConstraintsResponse> {
    this.logger.debug('Getting market constraints', { slugOrConditionId });

    try {
      const market = await this.getMarketInfo(slugOrConditionId);

      const constraints: MarketConstraintsResponse = {
        minimum_order_value: 0, // Нет минимального значения — требуется минимум 1 акция
        minimum_order_size: market.orderMinSize ?? 10, // Минимум акций для SELL-ордеров
        maximum_order_size: 10000, // API не предоставляет максимум — используем дефолт
        minimum_tick_size: 0.01, // API не предоставляет шаг размера — используем дефолт
        minimum_price_tick: market.orderPriceMinTickSize ?? 0.0001,
      };

      this.logger.debug('Market constraints retrieved', {
        slugOrConditionId,
        constraints,
      });

      return constraints;
    } catch (error) {
      // HTTP 422 ожидаем, если передан conditionId вместо slug
      const is422 = error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 422;

      if (is422) {
        this.logger.debug('Market constraints unavailable (422 - need slug, not conditionId), using defaults', {
          slugOrConditionId,
        });
      } else {
        this.logger.warn('Failed to fetch market constraints, using defaults', {
          slugOrConditionId,
          error,
        });
      }

      // Возвращаем безопасные значения по умолчанию
      // КРИТИЧНО: minimum_order_size = 1 (запасной вариант, когда API недоступен)
      return {
        minimum_order_value: 0, // Нет минимального значения — требуется минимум 1 акция
        minimum_order_size: 1, // Безопасный дефолт: минимум 1 акция
        maximum_order_size: 10000,
        minimum_tick_size: 0.01,
        minimum_price_tick: 0.0001,
      };
    }
  }

  /**
   * Map raw API response to domain format
   *
   * @param raw - Raw market info response (camelCase from Gamma API)
   * @returns Domain format market data (camelCase)
   *
   * @remarks
   * Gamma API already returns camelCase, so mapping is minimal.
   * API returns JSON strings for clobTokenIds and outcomes - pass through as-is.
   * MarketFilter will parse them later.
   */
  private mapToDomainFormat(raw: MarketInfoResponse): GammaMarketData {
    return {
      conditionId: raw.conditionId,
      question: raw.question,
      slug: raw.slug,
      endDate: raw.endDate,  // Already ISO string from API
      active: raw.active,
      closed: raw.closed,
      enableOrderBook: raw.enableOrderBook,
      clobTokenIds: raw.clobTokenIds, // JSON-строка: "[\"token1\", \"token2\"]"
      outcomes: raw.outcomes, // JSON-строка: "[\"Yes\", \"No\"]"
      liquidity: raw.liquidity, // Строковое число из API
      spread: raw.spread, // Спред bid-ask из API
      bestBid: raw.bestBid, // Лучший bid из API
      bestAsk: raw.bestAsk, // Лучший ask из API
      orderMinSize: raw.orderMinSize, // Минимальный размер ордера из API (напр., 5 акций)
      orderPriceMinTickSize: raw.orderPriceMinTickSize, // Шаг цены из API (напр., 0.01)
      // Необязательные поля, отсутствующие в ответе API
      description: undefined,
      tags: undefined,
    };
  }

  /**
   * Generic fetch helper
   *
   * @param url - Full URL
   * @param silent - Skip debug logging (for batch operations)
   * @returns Response data
   * @throws {Error} If request fails
   */
  private async fetch<T>(url: string, silent = false): Promise<T> {
    if (!silent) {
      this.logger.debug(`GET ${url}`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();

        // HTTP 422 ожидаем — используется conditionId вместо slug
        if (response.status === 422) {
          if (!silent) {
            this.logger.debug(`HTTP 422 (expected - need slug, not conditionId)`, {
              url,
              body: errorBody,
            });
          }
        } else {
          this.logger.error(`HTTP ${response.status} error`, {
            url,
            status: response.status,
            body: errorBody,
          });
        }

        const error: any = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.statusCode = response.status;
        throw error;
      }

      const data = await response.json();

      if (!silent) {
        this.logger.debug(`GET ${url} → OK`);
      }

      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if ((error as Error).name === 'AbortError') {
        throw new Error(`Request timeout after ${this.config.timeout}ms`);
      }

      throw error;
    }
  }
}
