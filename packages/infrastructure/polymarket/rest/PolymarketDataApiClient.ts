/**
 * Polymarket Data API Client
 *
 * @remarks
 * Simple HTTP client for Polymarket Data API (data-api.polymarket.com).
 * Used for endpoints that are NOT on CLOB API.
 *
 * Endpoints:
 * - GET /positions - User positions (requires Data API, not CLOB API)
 *
 * This is a lightweight client without authentication (Data API is public).
 *
 * @module infrastructure/polymarket/rest/PolymarketDataApiClient
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';

/**
 * Data API client configuration
 */
export interface DataApiClientConfig {
  /** Data API base URL (default: https://data-api.polymarket.com) */
  baseUrl?: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Polymarket Data API Client
 *
 * @remarks
 * Lightweight HTTP client for Data API endpoints.
 * No authentication required (public API).
 */
export class PolymarketDataApiClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly logger: ILogger;

  constructor(config: DataApiClientConfig, logger: ILogger) {
    this.baseUrl = config.baseUrl || 'https://data-api.polymarket.com';
    this.timeout = config.timeout || 30000;
    this.logger = logger.child?.('PolymarketDataApiClient') ?? logger;
  }

  /**
   * Execute GET request
   *
   * @param endpoint - API endpoint (e.g., '/positions')
   * @param params - Query parameters
   * @returns Response data
   * @throws {Error} If request fails
   */
  async get<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(endpoint, this.baseUrl);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    this.logger.debug('Data API request', {
      method: 'GET',
      url: url.toString(),
      params,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('Data API error', {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });

        throw new Error(
          `HTTP ${response.status}: ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
        );
      }

      const data = await response.json();

      this.logger.debug('Data API response', {
        status: response.status,
        dataLength: Array.isArray(data) ? data.length : undefined,
      });

      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error('Data API timeout', {
          endpoint,
          timeout: this.timeout,
        });
        throw new Error(`Request timeout after ${this.timeout}ms`);
      }

      throw error;
    }
  }
}
