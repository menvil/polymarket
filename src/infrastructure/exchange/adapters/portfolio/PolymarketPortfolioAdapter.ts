/**
 * PolymarketPortfolioAdapter - реализация IPortfolioAdapter
 *
 * @remarks
 * Адаптер для portfolio и market data операций через Polymarket CLOB.
 * Часть разделения PolymarketRestAdapter на Execution и Portfolio (Step 3).
 *
 * Responsibilities:
 * - Получение балансов (USDC, outcome tokens)
 * - Получение позиций
 * - Получение orderbook (market data)
 * - Маппинг API типов в Domain типы
 *
 * Использует:
 * - BalanceRestClient для балансов
 * - PositionRestClient для позиций
 * - OrderbookRestClient для orderbook snapshots
 * - Mappers для конвертации API ↔ Domain
 *
 * @example
 * ```typescript
 * const portfolioAdapter = new PolymarketPortfolioAdapter(
 *   balanceClient,
 *   positionClient,
 *   orderbookClient,
 *   logger
 * );
 *
 * // Get balance
 * const balance = await portfolioAdapter.getBalance();
 * console.log(`Available: ${balance.amount} USDC`);
 *
 * // Get orderbook
 * const orderbook = await portfolioAdapter.getOrderBook('0xabc');
 * console.log(`Best bid: ${orderbook.bids[0].price.value}`);
 * ```
 */

import { IPortfolioAdapter } from '../../../../domain/ports/IPortfolioAdapter.js';
import { Orderbook } from '../../../../domain/entities/Orderbook.js';
import { Money } from '../../../../domain/value-objects/Money.js';
import { Quantity } from '../../../../domain/value-objects/Quantity.js';
import { ExchangeError } from '../../../../shared/errors/TradingError.js';
import { ILogger } from '../../../../domain/ports/ILogger.js';
import { PolymarketBalanceRestClient } from '../../clients/PolymarketBalanceRestClient.js';
import { PolymarketPositionRestClient } from '../../clients/PolymarketPositionRestClient.js';
import { PolymarketOrderbookRestClient } from '../../clients/PolymarketOrderbookRestClient.js';
import { OrderbookMapper } from '../../mappers/OrderbookMapper.js';

/**
 * Polymarket Portfolio Adapter
 *
 * @remarks
 * Реализация IPortfolioAdapter для Polymarket CLOB.
 * Использует специализированные REST клиенты для portfolio queries.
 */
export class PolymarketPortfolioAdapter implements IPortfolioAdapter {
  /**
   * Создаёт Polymarket Portfolio Adapter
   *
   * @param balanceClient - Balance REST клиент
   * @param positionClient - Position REST клиент
   * @param orderbookClient - Orderbook REST клиент
   * @param logger - Логгер
   */
  constructor(
    private readonly balanceClient: PolymarketBalanceRestClient,
    private readonly positionClient: PolymarketPositionRestClient,
    private readonly orderbookClient: PolymarketOrderbookRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получает текущий баланс USDC
   *
   * @returns Доступный баланс (available, не включает locked)
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Алгоритм:
   * 1. Fetch balances от BalanceRestClient
   * 2. Фильтр по asset = 'USDC'
   * 3. Parse available balance
   * 4. Возвращает Money
   */
  public async getBalance(): Promise<Money> {
    try {
      this.logger.debug('[PortfolioAdapter] Fetching USDC balance...');

      // Fetch all balances
      const balances = await this.balanceClient.getBalances();

      // Find USDC balance
      const usdcBalance = balances.find((b) => b.asset === 'USDC');

      if (!usdcBalance) {
        this.logger.warn('[PortfolioAdapter] USDC balance not found, returning 0');
        return Money.fromUSDC(0);
      }

      // Parse available balance
      const available = parseFloat(usdcBalance.available);

      if (isNaN(available) || available < 0) {
        this.logger.error(
          `[PortfolioAdapter] Invalid available balance: ${usdcBalance.available}`
        );
        throw new Error(`Invalid available balance: ${usdcBalance.available}`);
      }

      this.logger.debug(`[PortfolioAdapter] USDC balance: ${available.toFixed(2)}`);
      return Money.fromUSDC(available);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[PortfolioAdapter] Failed to fetch balance: ${message}`);
      throw new ExchangeError(`Failed to fetch balance: ${message}`);
    }
  }

  /**
   * Получает текущую позицию по токену
   *
   * @param tokenId - ID токена (YES или NO)
   * @returns Количество токенов
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Алгоритм:
   * 1. Fetch positions от PositionRestClient
   * 2. Фильтр по tokenId
   * 3. Parse size позиции
   * 4. Возвращает Quantity
   */
  public async getPosition(tokenId: string): Promise<Quantity> {
    try {
      this.logger.debug(
        `[PortfolioAdapter] Fetching position for token ${tokenId.substring(0, 16)}...`
      );

      // Fetch all positions
      const positions = await this.positionClient.getPositions();

      // Find position for tokenId
      const position = positions.find((p) => p.tokenId === tokenId);

      if (!position) {
        this.logger.debug(`[PortfolioAdapter] No position found for token ${tokenId}, returning 0`);
        return Quantity.fromNumber(0);
      }

      // Parse size
      const size = parseFloat(position.size);

      if (isNaN(size) || size < 0) {
        this.logger.error(`[PortfolioAdapter] Invalid position size: ${position.size}`);
        throw new Error(`Invalid position size: ${position.size}`);
      }

      this.logger.debug(`[PortfolioAdapter] Position for token ${tokenId}: ${size}`);
      return Quantity.fromNumber(size);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[PortfolioAdapter] Failed to fetch position: ${message}`);
      throw new ExchangeError(`Failed to fetch position: ${message}`);
    }
  }

  /**
   * Получает стакан заявок для рынка
   *
   * @param marketId - ID рынка (tokenId)
   * @returns Orderbook snapshot
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Алгоритм:
   * 1. Fetch ApiOrderbook от OrderbookRestClient
   * 2. Map ApiOrderbook → Domain Orderbook через OrderbookMapper
   * 3. Возвращает Domain Orderbook
   */
  public async getOrderBook(marketId: string): Promise<Orderbook> {
    try {
      this.logger.debug(
        `[PortfolioAdapter] Fetching orderbook for market ${marketId.substring(0, 16)}...`
      );

      // Step 1: Fetch ApiOrderbook via client
      const apiOrderbook = await this.orderbookClient.getOrderbook(marketId);

      // Step 2: Map ApiOrderbook → Domain Orderbook
      const orderbook = OrderbookMapper.toDomain(apiOrderbook);

      this.logger.debug(
        `[PortfolioAdapter] Orderbook fetched: ${orderbook.bids.length} bids, ${orderbook.asks.length} asks`
      );
      return orderbook;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[PortfolioAdapter] Failed to fetch orderbook: ${message}`);
      throw new ExchangeError(`Failed to fetch orderbook: ${message}`);
    }
  }

  /**
   * Получает все текущие позиции
   *
   * @returns Массив позиций (tokenId + quantity)
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Возвращает только ненулевые позиции.
   */
  public async getAllPositions(): Promise<Array<{ tokenId: string; quantity: Quantity }>> {
    try {
      this.logger.debug('[PortfolioAdapter] Fetching all positions...');

      // Fetch all positions
      const positions = await this.positionClient.getPositions();

      // Convert to Domain format
      const result = positions
        .filter((p) => {
          const size = parseFloat(p.size);
          return !isNaN(size) && size > 0;
        })
        .map((p) => ({
          tokenId: p.tokenId,
          quantity: Quantity.fromNumber(parseFloat(p.size)),
        }));

      this.logger.debug(`[PortfolioAdapter] Found ${result.length} non-zero positions`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[PortfolioAdapter] Failed to fetch all positions: ${message}`);
      throw new ExchangeError(`Failed to fetch all positions: ${message}`);
    }
  }

  /**
   * Получает locked (замороженный) баланс в открытых ордерах
   *
   * @returns Locked баланс USDC
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Показывает сколько USDC заморожено в открытых ордерах.
   */
  public async getLockedBalance(): Promise<Money> {
    try {
      this.logger.debug('[PortfolioAdapter] Fetching locked balance...');

      // Fetch all balances
      const balances = await this.balanceClient.getBalances();

      // Find USDC balance
      const usdcBalance = balances.find((b) => b.asset === 'USDC');

      if (!usdcBalance) {
        this.logger.warn('[PortfolioAdapter] USDC balance not found, returning 0 locked');
        return Money.fromUSDC(0);
      }

      // Parse locked balance
      const locked = parseFloat(usdcBalance.locked);

      if (isNaN(locked) || locked < 0) {
        this.logger.error(`[PortfolioAdapter] Invalid locked balance: ${usdcBalance.locked}`);
        throw new Error(`Invalid locked balance: ${usdcBalance.locked}`);
      }

      this.logger.debug(`[PortfolioAdapter] Locked balance: ${locked.toFixed(2)}`);
      return Money.fromUSDC(locked);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[PortfolioAdapter] Failed to fetch locked balance: ${message}`);
      throw new ExchangeError(`Failed to fetch locked balance: ${message}`);
    }
  }
}
