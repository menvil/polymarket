/**
 * PolymarketOrderbookRestClient - REST клиент для получения orderbook
 *
 * @remarks
 * Fetches orderbook snapshots через Polymarket CLOB REST API.
 * Использует HttpClient для retry/timeout/error handling.
 *
 * Responsibilities:
 * - Fetch orderbook от API endpoint
 * - Возвращает ApiOrderbook (raw API формат)
 * - Не содержит маппинга (делегирует в OrderbookMapper)
 * - Не содержит бизнес-логики
 *
 * @example
 * ```typescript
 * const client = new PolymarketOrderbookRestClient(httpClient, logger);
 * const apiOrderbook = await client.getOrderbook('0xabc123');
 * console.log(`Fetched ${apiOrderbook.bids.length} bids`);
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import { HttpClient } from '../../../shared/http/HttpClient.js';
import type { ApiOrderbook } from './types.js';

/**
 * PolymarketOrderbookRestClient - клиент для orderbook
 *
 * @remarks
 * Использует HttpClient (retry/timeout) для fetch операций.
 * Возвращает только API типы (не Domain).
 */
export class PolymarketOrderbookRestClient {
  /**
   * Создаёт PolymarketOrderbookRestClient
   *
   * @param httpClient - HTTP клиент с retry/timeout
   * @param logger - Logger
   *
   * @example
   * ```typescript
   * const httpClient = new HttpClient({
   *   baseUrl: 'https://clob.polymarket.com',
   *   timeout: 10000,
   *   maxRetries: 3
   * }, logger);
   *
   * const client = new PolymarketOrderbookRestClient(httpClient, logger);
   * ```
   */
  constructor(
    // @ts-expect-error - Will be used when real API endpoint is ready (currently using mock)
    private readonly httpClient: HttpClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получает orderbook для рынка
   *
   * @param marketId - ID рынка (token ID)
   * @returns API orderbook
   * @throws {HttpError} При ошибке API или timeout
   *
   * @remarks
   * Алгоритм:
   * 1. Вызывает GET /book/{marketId}
   * 2. Парсит JSON response
   * 3. Возвращает ApiOrderbook
   *
   * NOTE: Текущая реализация возвращает mock данные.
   * В production нужен реальный API endpoint.
   *
   * API endpoint format:
   * - URL: /book/{tokenId}
   * - Method: GET
   * - Response: { asset_id, market, bids, asks, timestamp }
   *
   * @example
   * ```typescript
   * try {
   *   const orderbook = await client.getOrderbook('0xabc123');
   *   console.log(`Best bid: ${orderbook.bids[0].price}`);
   * } catch (error) {
   *   if (error instanceof HttpError) {
   *     console.error(`HTTP ${error.status}: ${error.message}`);
   *   }
   * }
   * ```
   */
  public async getOrderbook(marketId: string): Promise<ApiOrderbook> {
    this.logger.debug(`[OrderbookRestClient] Fetching orderbook for market: ${marketId.substring(0, 16)}...`);

    // NOTE: В production используем реальный API endpoint
    // const apiOrderbook = await this.httpClient.fetchJson<ApiOrderbook>(`/book/${marketId}`);

    // MOCK: Временная заглушка для разработки
    // В реальной реализации раскомментировать строку выше
    const apiOrderbook = await this.fetchMockOrderbook(marketId);

    this.logger.debug(`[OrderbookRestClient] Fetched orderbook: ${apiOrderbook.bids.length} bids, ${apiOrderbook.asks.length} asks`);

    return apiOrderbook;
  }

  /**
   * Fetches mock orderbook для разработки
   *
   * @param marketId - Market ID
   * @returns Mock ApiOrderbook
   *
   * @remarks
   * Временная заглушка.
   * В production удалить и использовать реальный API.
   */
  private async fetchMockOrderbook(marketId: string): Promise<ApiOrderbook> {
    // Симулируем network delay
    await new Promise((resolve) => setTimeout(resolve, 50));

    return {
      marketId,
      bids: [
        { price: '0.52', size: '100' },
        { price: '0.51', size: '200' },
        { price: '0.50', size: '300' },
      ],
      asks: [
        { price: '0.53', size: '150' },
        { price: '0.54', size: '250' },
        { price: '0.55', size: '350' },
      ],
      timestamp: Date.now(), // milliseconds
    };
  }
}
