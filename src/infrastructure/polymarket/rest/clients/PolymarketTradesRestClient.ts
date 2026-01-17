/**
 * REST-клиент для сделок Polymarket
 *
 * @remarks
 * Обрабатывает эндпоинт /trades:
 * - GET /trades - Получить историю рыночных сделок
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется мапперами на более высоких уровнях.
 *
 * **ВАЖНО**: Возвращает ПУБЛИЧНЫЕ рыночные сделки, НЕ исполнения конкретного пользователя.
 * Для истории исполнений пользователя используйте PolymarketOrderRestClient (будущая реализация).
 *
 * @example
 * ```typescript
 * const client = new PolymarketTradesRestClient(restClient, logger);
 *
 * const trades = await client.getMarketTrades('0x123', 100);
 * console.log(`Last 100 trades: ${trades.length}`);
 * console.log(`Last trade price: ${trades[0].price}`);
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';

/**
 * Ответ с рыночной сделкой (сырой формат API)
 */
export interface MarketTradeResponse {
  /** ID сделки */
  tradeId: string;

  /** ID токена */
  tokenId: string;

  /** Сторона сделки (с точки зрения тейкера) */
  side: 'BUY' | 'SELL';

  /** Цена исполнения (строковый формат) */
  price: string;

  /** Размер сделки (строковый формат) */
  size: string;

  /** Временная метка исполнения */
  timestamp: number;

  /** Адрес тейкера (опционально) */
  taker?: string;

  /** Адрес мейкера (опционально) */
  maker?: string;
}

/**
 * Ответ на запрос рыночных сделок
 */
export interface GetMarketTradesResponse {
  /** Массив сделок */
  trades: MarketTradeResponse[];
}

/**
 * REST-клиент для сделок Polymarket
 */
export class PolymarketTradesRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить историю рыночных сделок
   *
   * @param tokenId - ID токена
   * @param limit - Опционально: максимальное количество возвращаемых сделок (по умолчанию: 100)
   * @returns Массив рыночных сделок (отсортированных по временной метке по убыванию)
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Возвращает ПУБЛИЧНЫЕ рыночные сделки (НЕ исполнения конкретного пользователя).
   * Возвращает сырой ответ API. Нормализация должна выполняться маппером.
   *
   * @example
   * ```typescript
   * // Last 100 trades
   * const trades = await client.getMarketTrades('0x123');
   * console.log(`Last 100 trades: ${trades.length}`);
   *
   * // Last 50 trades
   * const recentTrades = await client.getMarketTrades('0x123', 50);
   * console.log(`Last trade price: ${recentTrades[0].price}`);
   * ```
   */
  async getMarketTrades(tokenId: string, limit?: number): Promise<MarketTradeResponse[]> {
    this.logger.debug('Getting market trades', { tokenId, limit });

    // API ожидает имена параметров в формате snake_case
    const params: Record<string, string> = {
      token_id: tokenId, // КРИТИЧНО: API требует token_id, а не tokenId
    };

    if (limit !== undefined) {
      params.limit = limit.toString();
    }

    const response = await this.restClient.get<GetMarketTradesResponse>('/trades', params);

    this.logger.debug('Market trades retrieved', {
      tokenId,
      count: response.trades.length,
    });

    return response.trades;
  }

  /**
   * Получить цену последней сделки
   *
   * @param tokenId - ID токена
   * @returns Цена последней сделки или undefined, если сделок нет
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @example
   * ```typescript
   * const lastPrice = await client.getLastTradePrice('0x123');
   *
   * if (lastPrice) {
   *   console.log(`Last trade price: ${lastPrice}`);
   * }
   * ```
   */
  async getLastTradePrice(tokenId: string): Promise<string | undefined> {
    this.logger.debug('Getting last trade price', { tokenId });

    const trades = await this.getMarketTrades(tokenId, 1);
    const lastPrice = trades[0]?.price;

    if (lastPrice) {
      this.logger.debug('Last trade price retrieved', {
        tokenId,
        price: lastPrice,
      });
    } else {
      this.logger.warn('No trades found', { tokenId });
    }

    return lastPrice;
  }

  /**
   * Получить объем торгов во временном окне
   *
   * @param tokenId - ID токена
   * @param windowMs - Временное окно в миллисекундах
   * @returns Общий объем (сумма размеров)
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Вычисляет объем путем суммирования размеров сделок в указанном временном окне.
   *
   * @example
   * ```typescript
   * // Volume in last hour
   * const hourVolume = await client.getTradeVolume('0x123', 3600000);
   * console.log(`Volume in last hour: ${hourVolume}`);
   * ```
   */
  async getTradeVolume(tokenId: string, windowMs: number): Promise<number> {
    this.logger.debug('Getting trade volume', { tokenId, windowMs });

    const now = Date.now();
    const cutoff = now - windowMs;

    // Получить сделки (может потребоваться получить больше, чем лимит, для покрытия окна)
    const trades = await this.getMarketTrades(tokenId, 1000);

    // Отфильтровать сделки в пределах окна и суммировать размеры
    const volume = trades
      .filter((trade) => trade.timestamp >= cutoff)
      .reduce((sum, trade) => sum + parseFloat(trade.size), 0);

    this.logger.debug('Trade volume calculated', {
      tokenId,
      windowMs,
      volume,
      tradesCount: trades.filter((t) => t.timestamp >= cutoff).length,
    });

    return volume;
  }
}
