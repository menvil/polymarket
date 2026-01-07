/**
 * PolymarketBalanceRestClient - REST клиент для получения балансов
 *
 * @remarks
 * Fetches balance информацию через Polymarket CLOB REST API.
 * Использует HttpClient для retry/timeout/error handling.
 *
 * Responsibilities:
 * - Fetch balances от API endpoint
 * - Возвращает ApiBalance[] (raw API формат)
 * - Поддерживает фильтрацию по asset type (USDC, OUTCOME)
 * - Не содержит маппинга (делегирует в BalanceMapper)
 *
 * @example
 * ```typescript
 * const client = new PolymarketBalanceRestClient(httpClient, logger);
 * const balances = await client.getBalances();
 * const usdcBalance = balances.find(b => b.asset === 'USDC');
 * console.log(`Available: ${usdcBalance.available} USDC`);
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import { HttpClient } from '../../../shared/http/HttpClient.js';
import type { ApiBalance } from './types.js';

/**
 * PolymarketBalanceRestClient - клиент для balances
 *
 * @remarks
 * Использует HttpClient (retry/timeout) для fetch операций.
 * Возвращает только API типы (не Domain).
 */
export class PolymarketBalanceRestClient {
  /**
   * Создаёт PolymarketBalanceRestClient
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
   * const client = new PolymarketBalanceRestClient(httpClient, logger);
   * ```
   */
  constructor(
    // @ts-expect-error - Will be used in Step 6 (унификация CLOB/Gamma clients)
    private readonly httpClient: HttpClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получает все балансы для адреса
   *
   * @returns Массив ApiBalance (USDC + outcome tokens)
   * @throws {HttpError} При ошибке API или timeout
   *
   * @remarks
   * Алгоритм:
   * 1. Вызывает GET /balances
   * 2. Парсит JSON response
   * 3. Возвращает ApiBalance[]
   *
   * NOTE: Текущая реализация использует CLOBClient (legacy).
   * В Step 6 будет рефакторинг на HttpClient.
   *
   * API endpoint format:
   * - URL: /balances или /wallet/balances
   * - Method: GET
   * - Headers: Authorization (required)
   * - Response: { balances: [{ asset, amount, available, locked }] }
   *
   * @example
   * ```typescript
   * const balances = await client.getBalances();
   * const usdc = balances.find(b => b.asset === 'USDC');
   * console.log(`USDC available: ${usdc.available}`);
   *
   * const outcomes = balances.filter(b => b.asset === 'OUTCOME');
   * console.log(`Outcome tokens: ${outcomes.length}`);
   * ```
   */
  public async getBalances(): Promise<ApiBalance[]> {
    this.logger.debug('[BalanceRestClient] Fetching balances...');

    // NOTE: В production используем реальный API endpoint
    // const response = await this.httpClient.fetchJson<{ balances: ApiBalance[] }>('/balances');
    // return response.balances;

    // MOCK: Временная заглушка для разработки
    // В Step 6 будет рефакторинг на HttpClient
    const balances = await this.fetchMockBalances();

    this.logger.debug(`[BalanceRestClient] Fetched ${balances.length} balances`);

    return balances;
  }

  /**
   * Получает баланс для конкретного актива
   *
   * @param assetId - ID актива (для USDC = contract address, для OUTCOME = tokenId)
   * @returns ApiBalance или null если актив не найден
   * @throws {HttpError} При ошибке API
   *
   * @remarks
   * Удобный метод для получения баланса одного актива.
   * Внутри вызывает getBalances() и фильтрует.
   *
   * @example
   * ```typescript
   * const usdcBalance = await client.getBalance('0x2791bca1f2de4661ed88a30c99a7a9449aa84174');
   * if (usdcBalance) {
   *   console.log(`Available: ${usdcBalance.available} USDC`);
   * }
   * ```
   */
  public async getBalance(assetId: string): Promise<ApiBalance | null> {
    const balances = await this.getBalances();
    return balances.find((b) => b.assetId === assetId) ?? null;
  }

  /**
   * Fetches mock balances для разработки
   *
   * @returns Mock ApiBalance[]
   *
   * @remarks
   * Временная заглушка.
   * В production удалить и использовать реальный API.
   */
  private async fetchMockBalances(): Promise<ApiBalance[]> {
    // Симулируем network delay
    await new Promise((resolve) => setTimeout(resolve, 50));

    return [
      {
        asset: 'USDC',
        assetId: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC on Polygon
        amount: '1000.00',
        available: '950.00',
        locked: '50.00',
      },
      {
        asset: 'OUTCOME',
        assetId: '0xabc123', // Example YES token
        amount: '100.00',
        available: '100.00',
        locked: '0.00',
      },
    ];
  }
}
