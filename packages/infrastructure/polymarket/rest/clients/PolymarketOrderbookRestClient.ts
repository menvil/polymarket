/**
 * REST-клиент стакана заявок Polymarket
 *
 * @remarks
 * Обрабатывает endpoint /book:
 * - GET /book - Получить снимок стакана заявок
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется маппером в вышестоящих слоях.
 *
 * **ВАЖНО**: Это ПУБЛИЧНЫЕ рыночные данные, НЕ данные конкретного пользователя.
 *
 * @example
 * ```typescript
 * const client = new PolymarketOrderbookRestClient(restClient, logger);
 *
 * const orderbook = await client.getOrderbook('0x123');
 * console.log(`Best bid: ${orderbook.bids[0].price}`);
 * console.log(`Best ask: ${orderbook.asks[0].price}`);
 *
 * const top10 = await client.getOrderbook('0x123', 10);
 * console.log(`Top 10 levels`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';

/**
 * Уровень стакана заявок (сырой формат API)
 */
export interface OrderbookLevelResponse {
  /** Цена (строковый формат) */
  price: string;

  /** Размер на этой цене (строковый формат) */
  size: string;
}

/**
 * Ответ со стаканом заявок (сырой формат API)
 */
export interface OrderbookResponse {
  /** Идентификатор токена */
  tokenId: string;

  /** Заявки на покупку (отсортированы по убыванию цены) */
  bids: OrderbookLevelResponse[];

  /** Заявки на продажу (отсортированы по возрастанию цены) */
  asks: OrderbookLevelResponse[];

  /** Временная метка снимка */
  timestamp: number;
}

/**
 * REST-клиент стакана заявок Polymarket
 */
export class PolymarketOrderbookRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить снимок стакана заявок
   *
   * @param tokenId - Идентификатор токена
   * @param depth - Необязательно: количество уровней для возврата (по умолчанию: все)
   * @returns Снимок стакана заявок
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Возвращает сырой ответ API. Нормализация должна выполняться маппером.
   * Это ПУБЛИЧНЫЕ данные (не требуют аутентификации).
   *
   * @example
   * ```typescript
   * // Полный стакан заявок
   * const orderbook = await client.getOrderbook('0x123');
   * console.log(`Bids: ${orderbook.bids.length}`);
   * console.log(`Asks: ${orderbook.asks.length}`);
   *
   * // Топ 10 уровней
   * const top10 = await client.getOrderbook('0x123', 10);
   * console.log(`Best bid: ${top10.bids[0].price}`);
   * console.log(`Best ask: ${top10.asks[0].price}`);
   * ```
   */
  async getOrderbook(tokenId: string, depth?: number): Promise<OrderbookResponse> {
    this.logger.debug('Getting orderbook', { tokenId, depth });

    // API ожидает параметры в формате snake_case
    const params: Record<string, string> = {
      token_id: tokenId, // КРИТИЧНО: API требует token_id, не tokenId
    };

    if (depth !== undefined) {
      params.depth = depth.toString();
    }

    const response = await this.restClient.get<OrderbookResponse>('/book', params);

    this.logger.debug('Orderbook retrieved', {
      tokenId,
      bids: response.bids.length,
      asks: response.asks.length,
      timestamp: response.timestamp,
    });

    return response;
  }

  /**
   * Получить лучший bid и ask
   *
   * @param tokenId - Идентификатор токена
   * @returns Объект с лучшими ценами bid и ask
   * @throws {ApiError} При ошибке API-вызова
   *
   * @example
   * ```typescript
   * const { bestBid, bestAsk, spread } = await client.getBestPrices('0x123');
   * console.log(`Bid: ${bestBid}, Ask: ${bestAsk}, Spread: ${spread}`);
   * ```
   */
  async getBestPrices(
    tokenId: string
  ): Promise<{ bestBid: string; bestAsk: string; spread: string }> {
    this.logger.debug('Getting best prices', { tokenId });

    const orderbook = await this.getOrderbook(tokenId, 1);

    const bestBid = orderbook.bids[0]?.price ?? '0';
    const bestAsk = orderbook.asks[0]?.price ?? '0';

    const spread = (parseFloat(bestAsk) - parseFloat(bestBid)).toFixed(4);

    this.logger.debug('Best prices retrieved', {
      tokenId,
      bestBid,
      bestAsk,
      spread,
    });

    return { bestBid, bestAsk, spread };
  }

  /**
   * Получить среднюю цену (mid price)
   *
   * @param tokenId - Идентификатор токена
   * @returns Средняя цена (среднее лучших bid и ask)
   * @throws {ApiError} При ошибке API-вызова
   *
   * @example
   * ```typescript
   * const midPrice = await client.getMidPrice('0x123');
   * console.log(`Mid price: ${midPrice}`);
   * ```
   */
  async getMidPrice(tokenId: string): Promise<string> {
    const { bestBid, bestAsk } = await this.getBestPrices(tokenId);

    const mid = (parseFloat(bestBid) + parseFloat(bestAsk)) / 2;
    const midPrice = mid.toFixed(4);

    this.logger.debug('Mid price calculated', {
      tokenId,
      midPrice,
    });

    return midPrice;
  }
}
