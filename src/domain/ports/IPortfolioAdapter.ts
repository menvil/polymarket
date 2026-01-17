/**
 * IPortfolioAdapter port
 *
 * @remarks
 * Интерфейс для portfolio и market data операций.
 * Часть разделения IExchangeAdapter на Execution и Portfolio (Step 3).
 *
 * Responsibilities:
 * - Получение балансов (USDC, outcome tokens)
 * - Получение позиций
 * - Получение orderbook (market data)
 *
 * Не включает:
 * - Execution операции (placeOrder, cancelOrder)
 * - Подписки на order updates
 *
 * @example
 * ```typescript
 * class PolymarketPortfolioAdapter implements IPortfolioAdapter {
 *   async getBalance(): Promise<Money> {
 *     const apiBalance = await this.balanceClient.getBalance('USDC');
 *     return Money.fromNumber(parseFloat(apiBalance.available));
 *   }
 * }
 * ```
 */
import { Orderbook } from '../entities/Orderbook.js';
import { Money } from '../value-objects/Money.js';
import { Quantity } from '../value-objects/Quantity.js';

/**
 * Portfolio adapter interface
 *
 * @remarks
 * Domain layer не зависит от конкретной реализации portfolio queries.
 * Infrastructure layer предоставляет реализацию (Polymarket, другие биржи).
 */
export interface IPortfolioAdapter {
  /**
   * Получает текущий баланс USDC
   *
   * @returns Доступный баланс (available, не включает locked)
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * - Запрашивает баланс кошелька на бирже
   * - Возвращает только available баланс (без locked средств в ордерах)
   * - Используется для синхронизации портфеля и расчёта доступного капитала
   *
   * Locked баланс можно получить через getLockedBalance() (если нужно)
   *
   * @example
   * ```typescript
   * const balance = await portfolioAdapter.getBalance();
   * console.log(`Available: ${balance.amount} USDC`);
   * ```
   */
  getBalance(): Promise<Money>;

  /**
   * Получает текущую позицию по токену
   *
   * @param tokenId - ID токена (YES или NO)
   * @returns Количество токенов
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * - Запрашивает баланс конкретного токена на бирже
   * - Используется для синхронизации позиций и расчёта inventory
   * - В Polymarket каждая позиция определяется напрямую через tokenId
   * - Не нужна пара (marketId, tokenType), достаточно tokenId
   *
   * Алгоритм:
   * 1. Fetch positions от PositionRestClient
   * 2. Фильтр по tokenId
   * 3. Возвращает size позиции
   *
   * @example
   * ```typescript
   * const upTokenId = market.outcomes[0].tokenId;
   * const position = await portfolioAdapter.getPosition(upTokenId);
   * console.log(`Position: ${position.value} YES tokens`);
   * ```
   */
  getPosition(tokenId: string): Promise<Quantity>;

  /**
   * Получает стакан заявок для рынка
   *
   * @param marketId - ID рынка (tokenId)
   * @returns Orderbook snapshot
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * - Получает текущее состояние стакана из CLOB REST API
   * - Используется для расчёта котировок и анализа ликвидности
   * - Данные могут быть закешированы (см. OrderbookRestClient)
   *
   * Алгоритм:
   * 1. Fetch ApiOrderbook от OrderbookRestClient
   * 2. Map ApiOrderbook → Domain Orderbook через OrderbookMapper
   * 3. Возвращает Domain Orderbook
   *
   * Для real-time updates используйте WebSocket подписку отдельно
   *
   * @example
   * ```typescript
   * const orderbook = await portfolioAdapter.getOrderBook('0xabc123');
   * const bestBid = orderbook.bids[0];
   * const bestAsk = orderbook.asks[0];
   * const spread = bestAsk.price.value - bestBid.price.value;
   * console.log(`Best bid: ${bestBid.price.value}, Best ask: ${bestAsk.price.value}, Spread: ${spread}`);
   * ```
   */
  getOrderBook(marketId: string): Promise<Orderbook>;

  /**
   * Получает все текущие позиции
   *
   * @returns Массив позиций (tokenId + quantity)
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Удобный метод для получения всех открытых позиций сразу.
   * Возвращает только ненулевые позиции.
   *
   * @example
   * ```typescript
   * const positions = await portfolioAdapter.getAllPositions();
   * console.log(`Open positions: ${positions.length}`);
   * positions.forEach(pos => {
   *   console.log(`${pos.tokenId}: ${pos.quantity.value}`);
   * });
   * ```
   */
  getAllPositions(): Promise<Array<{ tokenId: string; quantity: Quantity }>>;

  /**
   * Получает locked (замороженный) баланс в открытых ордерах
   *
   * @returns Locked баланс USDC
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Показывает сколько USDC заморожено в открытых ордерах.
   * Полезно для расчёта реальной доступной ликвидности.
   *
   * Formula:
   * Total balance = Available + Locked
   *
   * @example
   * ```typescript
   * const available = await portfolioAdapter.getBalance();
   * const locked = await portfolioAdapter.getLockedBalance();
   * const total = Money.fromNumber(available.amount + locked.amount);
   * console.log(`Total: ${total.amount}, Available: ${available.amount}, Locked: ${locked.amount}`);
   * ```
   */
  getLockedBalance(): Promise<Money>;
}
