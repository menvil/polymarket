/**
 * Polymarket Data API Client
 *
 * @remarks
 * Простой HTTP-клиент для Polymarket Data API (data-api.polymarket.com).
 * Используется для эндпоинтов, которых НЕТ в CLOB API.
 *
 * Эндпоинты:
 * - GET /positions - Позиции пользователя (требуется Data API, не CLOB API)
 *
 * Это легковесный клиент без аутентификации (Data API публичен).
 *
 * @module infrastructure/polymarket/rest/PolymarketDataApiClient
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import { ApiError } from '../../../shared/errors/TradingError.js';

/**
 * Конфигурация клиента Data API
 */
export interface DataApiClientConfig {
  /** Базовый URL Data API (по умолчанию: https://data-api.polymarket.com) */
  baseUrl?: string;

  /** Таймаут запроса в миллисекундах (по умолчанию: 30000) */
  timeout?: number;
}

/**
 * Polymarket Data API Client
 *
 * @remarks
 * Легковесный HTTP-клиент для эндпоинтов Data API.
 * Аутентификация не требуется (публичный API).
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
   * Выполнить GET запрос
   *
   * @param endpoint - Эндпоинт API (например, '/positions')
   * @param params - Параметры запроса
   * @returns Данные ответа
   * @throws {ApiError} Если запрос не удался
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

        throw new ApiError(
          `HTTP ${response.status}: ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
          {
            statusCode: response.status,
            endpoint,
            method: 'GET',
            responseBody: errorText,
          }
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
        throw new ApiError(`Request timeout after ${this.timeout}ms`, {
          endpoint,
          method: 'GET',
        });
      }

      throw error;
    }
  }
}
