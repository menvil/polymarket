/**
 * PolymarketPositionRestClient - REST клиент для получения позиций
 *
 * @remarks
 * Fetches positions через Polymarket CLOB REST API.
 * Использует HttpClient для retry/timeout/error handling.
 *
 * **ВАЖНО:** В Polymarket позиции обычно приходят через WebSocket,
 * а не через REST API. Этот клиент предоставляет fallback для
 * начальной синхронизации.
 *
 * Responsibilities:
 * - Fetch positions от API endpoint (если доступен)
 * - Возвращает ApiPosition[] (raw API формат)
 * - Не содержит маппинга (делегирует в PositionMapper)
 * - Fallback к empty positions если API недоступен
 *
 * @example
 * ```typescript
 * const client = new PolymarketPositionRestClient(httpClient, logger);
 * const positions = await client.getPositions();
 * console.log(`Open positions: ${positions.length}`);
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import { HttpClient } from '../../../shared/http/HttpClient.js';
import type { ApiPosition, ApiPortfolioSnapshot } from './types.js';

/**
 * PolymarketPositionRestClient - клиент для positions
 *
 * @remarks
 * Использует HttpClient (retry/timeout) для fetch операций.
 * Возвращает только API типы (не Domain).
 *
 * **NOTE:** Polymarket positions обычно приходят через WebSocket.
 * REST API может не предоставлять positions endpoint.
 */
export class PolymarketPositionRestClient {
  /**
   * Создаёт PolymarketPositionRestClient
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
   * const client = new PolymarketPositionRestClient(httpClient, logger);
   * ```
   */
  constructor(
    // @ts-expect-error - Will be used in Step 6 (унификация CLOB/Gamma clients)
    private readonly httpClient: HttpClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получает все открытые позиции
   *
   * @returns Массив ApiPosition
   * @throws {HttpError} При ошибке API (optional - может возвращать [])
   *
   * @remarks
   * Алгоритм:
   * 1. Попытка вызвать GET /positions
   * 2. При ошибке → возвращает [] (fallback)
   * 3. Парсит JSON response
   * 4. Возвращает ApiPosition[]
   *
   * NOTE: Polymarket positions обычно приходят через WebSocket.
   * Этот метод предоставляет fallback для начальной синхронизации.
   *
   * API endpoint format:
   * - URL: /positions
   * - Method: GET
   * - Headers: Authorization (required)
   * - Response: { positions: [{ marketId, tokenId, size, averagePrice }] }
   *
   * @example
   * ```typescript
   * const positions = await client.getPositions();
   * if (positions.length > 0) {
   *   console.log(`First position: ${positions[0].marketId}`);
   * } else {
   *   console.log('No positions (will come via WebSocket)');
   * }
   * ```
   */
  public async getPositions(): Promise<ApiPosition[]> {
    this.logger.debug('[PositionRestClient] Fetching positions...');

    try {
      // NOTE: В production используем реальный API endpoint
      // const response = await this.httpClient.fetchJson<{ positions: ApiPosition[] }>('/positions');
      // return response.positions;

      // MOCK: Временная заглушка для разработки
      const positions = await this.fetchMockPositions();

      this.logger.debug(`[PositionRestClient] Fetched ${positions.length} positions`);

      return positions;
    } catch (error) {
      // Fallback: positions приходят через WebSocket
      this.logger.warn('[PositionRestClient] Failed to fetch positions via REST (will use WebSocket)', {
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }

  /**
   * Получает позицию для конкретного токена
   *
   * @param tokenId - ID токена
   * @returns ApiPosition или null если позиция не найдена
   * @throws {HttpError} При ошибке API (optional - может возвращать null)
   *
   * @remarks
   * Удобный метод для получения одной позиции.
   * Внутри вызывает getPositions() и фильтрует.
   *
   * @example
   * ```typescript
   * const position = await client.getPosition('0xabc123');
   * if (position) {
   *   console.log(`Size: ${position.size}, Avg Price: ${position.averagePrice}`);
   * }
   * ```
   */
  public async getPosition(tokenId: string): Promise<ApiPosition | null> {
    const positions = await this.getPositions();
    return positions.find((p) => p.tokenId === tokenId) ?? null;
  }

  /**
   * Получает полный portfolio snapshot (balances + positions)
   *
   * @returns ApiPortfolioSnapshot
   * @throws {HttpError} При ошибке API
   *
   * @remarks
   * Convenience метод для получения полного snapshot портфолио.
   * Включает balances (USDC + outcome tokens) и positions.
   *
   * NOTE: В production используем отдельные endpoints для
   * balances и positions, затем комбинируем.
   *
   * @example
   * ```typescript
   * const snapshot = await client.getPortfolioSnapshot();
   * console.log(`Total value: ${snapshot.totalValue} USDC`);
   * console.log(`Balances: ${snapshot.balances.length}`);
   * console.log(`Positions: ${snapshot.positions.length}`);
   * ```
   */
  public async getPortfolioSnapshot(): Promise<ApiPortfolioSnapshot> {
    this.logger.debug('[PositionRestClient] Fetching portfolio snapshot...');

    // NOTE: В production комбинируем balances + positions
    // const balances = await balanceClient.getBalances();
    // const positions = await this.getPositions();
    // return { timestamp: Date.now(), balances, positions };

    // MOCK: Временная заглушка
    const snapshot = await this.fetchMockPortfolio();

    this.logger.debug(`[PositionRestClient] Portfolio snapshot: ${snapshot.balances.length} balances, ${snapshot.positions.length} positions`);

    return snapshot;
  }

  /**
   * Fetches mock positions для разработки
   *
   * @returns Mock ApiPosition[]
   *
   * @remarks
   * Временная заглушка.
   * В production удалить и использовать реальный API.
   */
  private async fetchMockPositions(): Promise<ApiPosition[]> {
    // Симулируем network delay
    await new Promise((resolve) => setTimeout(resolve, 50));

    return [
      {
        marketId: '0xmarket123',
        tokenId: '0xtoken-yes',
        side: 'YES',
        size: '100',
        averagePrice: '0.55',
        currentPrice: '0.58',
        unrealizedPnl: '3.00',
      },
    ];
  }

  /**
   * Fetches mock portfolio для разработки
   *
   * @returns Mock ApiPortfolioSnapshot
   */
  private async fetchMockPortfolio(): Promise<ApiPortfolioSnapshot> {
    // Симулируем network delay
    await new Promise((resolve) => setTimeout(resolve, 50));

    return {
      timestamp: Date.now(),
      balances: [
        {
          asset: 'USDC',
          assetId: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
          amount: '1000.00',
          available: '950.00',
          locked: '50.00',
        },
      ],
      positions: [
        {
          marketId: '0xmarket123',
          tokenId: '0xtoken-yes',
          side: 'YES',
          size: '100',
          averagePrice: '0.55',
          currentPrice: '0.58',
          unrealizedPnl: '3.00',
        },
      ],
      totalValue: '1003.00',
    };
  }
}
