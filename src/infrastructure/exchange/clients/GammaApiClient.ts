/**
 * Gamma API client for fetching Polymarket market data
 *
 * @remarks
 * Interacts with Polymarket Gamma API to fetch active markets.
 * Used for market discovery in both simulation and live modes.
 *
 * @module infrastructure/exchange/clients/GammaApiClient
 */

import type { GammaMarketData } from '../../../domain/services/market-discovery/types';
import type { ILogger } from '../../../domain/ports/ILogger';

/**
 * Gamma API client configuration
 */
export interface GammaApiClientConfig {
  /** Base API URL */
  baseUrl: string;
  /** Request timeout (ms) */
  timeout?: number;
}

/**
 * Gamma API client for Polymarket market data
 *
 * @remarks
 * Fetches active markets from Polymarket Gamma API.
 * Handles rate limiting, errors, and response parsing.
 *
 * @example
 * ```typescript
 * const client = new GammaApiClient(
 *   { baseUrl: 'https://gamma-api.polymarket.com', timeout: 10000 },
 *   logger
 * );
 *
 * const markets = await client.getActiveMarkets();
 * console.log(`Fetched ${markets.length} markets`);
 * ```
 */
export class GammaApiClient {
  private config: GammaApiClientConfig;
  private logger: ILogger;

  /**
   * Create a new Gamma API client
   *
   * @param config - Client configuration
   * @param logger - Logger instance
   *
   * @example
   * ```typescript
   * const client = new GammaApiClient(
   *   { baseUrl: 'https://gamma-api.polymarket.com' },
   *   logger
   * );
   * ```
   */
  constructor(config: GammaApiClientConfig, logger: ILogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Fetch all active markets from Gamma API
   *
   * @returns Array of market data
   * @throws {Error} If API request fails or response is invalid
   *
   * @remarks
   * Endpoint: GET /markets
   * Filters for active markets with order book enabled.
   *
   * @example
   * ```typescript
   * try {
   *   const markets = await client.getActiveMarkets();
   *   console.log(`Fetched ${markets.length} markets`);
   * } catch (err) {
   *   console.error('Failed to fetch markets:', err);
   * }
   * ```
   */
  async getActiveMarkets(): Promise<GammaMarketData[]> {
    // Fetch markets with pagination
    const allMarkets: GammaMarketData[] = [];
    let offset = 0;
    const limit = 500;
    const maxPages = 50; // Max 5000 markets

    this.logger.info('Fetching active markets from Gamma API...');

    try {
      for (let page = 0; page < maxPages; page++) {
        const url = new URL(`${this.config.baseUrl}/markets`);
        url.searchParams.set('closed', 'false');
        url.searchParams.set('limit', limit.toString());
        url.searchParams.set('offset', offset.toString());
        url.searchParams.set('order', 'volume');
        url.searchParams.set('ascending', 'false');

        this.logger.trace(`Fetching page ${page + 1}`, {
          url: url.toString(),
          offset,
          limit,
        });

        const timeout = this.config.timeout || 10000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url.toString(), {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Polymarket-MM-Bot/3.0.0',
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          this.logger.error('Gamma API error', {
            status: response.status,
            statusText: response.statusText,
          });
          throw new Error(
            `Gamma API returned ${response.status}: ${response.statusText}`
          );
        }

        const data = await response.json();

        // Validate response structure
        if (!Array.isArray(data)) {
          this.logger.error('Invalid API response format', { data });
          throw new Error('Invalid response format: expected array of markets');
        }

        if (data.length === 0) {
          this.logger.debug(`Page ${page + 1} returned no results, stopping`);
          break;
        }

        allMarkets.push(...(data as GammaMarketData[]));
        offset += limit;

        // If we got less than limit, we've reached the end
        if (data.length < limit) {
          break;
        }
      }

      this.logger.info('Fetched markets from Gamma API', {
        totalMarkets: allMarkets.length,
      });

      return allMarkets;
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          this.logger.error('Gamma API request timeout');
          throw new Error(`Gamma API request timeout`);
        }

        this.logger.error('Failed to fetch markets from Gamma API', {
          error: err.message,
        });
        throw new Error(`Gamma API request failed: ${err.message}`);
      }

      throw err;
    }
  }

  /**
   * Fetch a specific market by condition ID
   *
   * @param conditionId - Market condition ID
   * @returns Market data or null if not found
   * @throws {Error} If API request fails
   *
   * @remarks
   * Endpoint: GET /markets/{conditionId}
   *
   * @example
   * ```typescript
   * const market = await client.getMarket('0x1234...');
   * if (market) {
   *   console.log(`Market: ${market.question}`);
   * }
   * ```
   */
  async getMarket(conditionId: string): Promise<GammaMarketData | null> {
    const url = `${this.config.baseUrl}/markets/${conditionId}`;
    const timeout = this.config.timeout || 10000;

    this.logger.debug('Fetching market from Gamma API', { conditionId, url });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Polymarket-MM-Bot/3.0.0',
        },
      });

      clearTimeout(timeoutId);

      if (response.status === 404) {
        this.logger.warn('Market not found', { conditionId });
        return null;
      }

      if (!response.ok) {
        throw new Error(`Gamma API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      return data as GammaMarketData;
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          this.logger.error('Gamma API request timeout', { url, timeout });
          throw new Error(`Gamma API request timeout after ${timeout}ms`);
        }

        this.logger.error('Failed to fetch market from Gamma API', {
          url,
          conditionId,
          error: err.message,
        });
        throw new Error(`Gamma API request failed: ${err.message}`);
      }

      throw err;
    }
  }
}
