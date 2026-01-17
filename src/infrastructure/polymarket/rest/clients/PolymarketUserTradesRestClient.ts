/**
 * REST-клиент для сделок пользователя Polymarket
 *
 * @remarks
 * Обрабатывает эндпоинт /data/trades (с аутентификацией L2):
 * - GET /data/trades - Получить историю исполнений сделок пользователя
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется мапперами на более высоких уровнях.
 *
 * **ВАЖНО**: Возвращает исполнения КОНКРЕТНОГО ПОЛЬЗОВАТЕЛЯ (с аутентификацией), НЕ публичные рыночные сделки.
 * Для публичных рыночных сделок используйте PolymarketTradesRestClient.
 *
 * @example
 * ```typescript
 * const client = new PolymarketUserTradesRestClient(restClient, logger);
 *
 * // Get all user fills
 * const fills = await client.getUserFills();
 * console.log(`Total fills: ${fills.length}`);
 *
 * // Get fills for specific market
 * const marketFills = await client.getUserFills({ market: '0x123...' });
 * console.log(`Market fills: ${marketFills.length}`);
 *
 * // Get fills for specific asset
 * const assetFills = await client.getUserFills({ asset_id: '123456...' });
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';

/**
 * Ответ с исполнением пользователя (сырой формат API)
 *
 * @remarks
 * Представляет одно исполнение (выполненную сделку) для аутентифицированного пользователя.
 */
export interface UserFillResponse {
  /** ID сделки */
  id: string;

  /** ID ордера, который был исполнен */
  order_id: string;

  /** ID условия рынка */
  market: string;

  /** ID актива (ID токена) */
  asset_id: string;

  /** Сторона сделки (BUY или SELL) */
  side: 'BUY' | 'SELL';

  /** Цена исполнения (строковый формат) */
  price: string;

  /** Размер исполнения (строковый формат) */
  size: string;

  /** Сумма комиссии (строковый формат) */
  fee_amount?: string;

  /** Ставка комиссии в базисных пунктах */
  fee_rate_bps?: string;

  /** Временная метка исполнения (Unix миллисекунды) */
  timestamp: number;

  /** Адрес мейкера */
  maker_address?: string;

  /** ID совпадения */
  match_id?: string;

  /** Хеш транзакции */
  transaction_hash?: string;
}

/**
 * Параметры запроса исполнений пользователя
 */
export interface UserFillsParams {
  /** Фильтр по ID условия рынка */
  market?: string;

  /** Фильтр по ID актива (ID токена) */
  asset_id?: string;

  /** Фильтр по адресу мейкера */
  maker_address?: string;

  /** Фильтр исполнений до этой временной метки */
  before?: number;

  /** Фильтр исполнений после этой временной метки */
  after?: number;

  /** Максимальное количество возвращаемых исполнений */
  limit?: number;

  /** Вернуть только первую страницу (по умолчанию: false) */
  only_first_page?: boolean;
}

/**
 * REST-клиент для сделок пользователя Polymarket
 *
 * @remarks
 * Клиент с аутентификацией L2 для получения истории исполнений сделок пользователя.
 */
export class PolymarketUserTradesRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить исполнения сделок пользователя
   *
   * @param params - Опциональные параметры запроса для фильтрации
   * @returns Массив исполнений пользователя (отсортированных по временной метке по убыванию)
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Требует аутентификацию L2 (заголовки с подписью HMAC-SHA256).
   * Возвращает выполненные сделки пользователя (исполнения), НЕ открытые ордера.
   *
   * @example
   * ```typescript
   * // Get all fills
   * const fills = await client.getUserFills();
   *
   * // Get fills for specific market
   * const marketFills = await client.getUserFills({
   *   market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
   * });
   *
   * // Get recent fills (last 24 hours)
   * const recentFills = await client.getUserFills({
   *   after: Date.now() - 24 * 60 * 60 * 1000,
   * });
   *
   * // Get fills for specific token
   * const tokenFills = await client.getUserFills({
   *   asset_id: '108770292557037291842343444956827763454878470740965721806292624574119111069516',
   * });
   * ```
   */
  async getUserFills(params?: UserFillsParams): Promise<UserFillResponse[]> {
    this.logger.debug('Getting user fills', params);

    // Построить параметры запроса (API ожидает формат snake_case)
    const queryParams: Record<string, string> = {};

    if (params?.market) {
      queryParams.market = params.market;
    }

    if (params?.asset_id) {
      queryParams.asset_id = params.asset_id;
    }

    if (params?.maker_address) {
      queryParams.maker_address = params.maker_address;
    }

    if (params?.before !== undefined) {
      queryParams.before = params.before.toString();
    }

    if (params?.after !== undefined) {
      queryParams.after = params.after.toString();
    }

    if (params?.limit !== undefined) {
      queryParams.limit = params.limit.toString();
    }

    if (params?.only_first_page !== undefined) {
      queryParams.only_first_page = params.only_first_page.toString();
    }

    // Вызвать аутентифицированный эндпоинт
    const fills = await this.restClient.get<UserFillResponse[]>(
      '/data/trades',
      queryParams
    );

    this.logger.debug('User fills retrieved', {
      count: fills.length,
      params,
    });

    return fills;
  }

  /**
   * Получить общий исполненный объем для пользователя
   *
   * @param params - Опциональные параметры запроса для фильтрации
   * @returns Общий объем (сумма размер * цена)
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Вычисляет общий долларовый объем всех исполнений.
   *
   * @example
   * ```typescript
   * // Total volume across all markets
   * const totalVolume = await client.getTotalVolume();
   * console.log(`Total traded: $${totalVolume.toFixed(2)}`);
   *
   * // Volume for specific market
   * const marketVolume = await client.getTotalVolume({
   *   market: '0x123...',
   * });
   * ```
   */
  async getTotalVolume(params?: UserFillsParams): Promise<number> {
    this.logger.debug('Calculating total volume', params);

    const fills = await this.getUserFills(params);

    const totalVolume = fills.reduce((sum, fill) => {
      const price = parseFloat(fill.price);
      const size = parseFloat(fill.size);
      return sum + price * size;
    }, 0);

    this.logger.debug('Total volume calculated', {
      totalVolume,
      fillCount: fills.length,
    });

    return totalVolume;
  }

  /**
   * Получить статистику исполнений для пользователя
   *
   * @param params - Опциональные параметры запроса для фильтрации
   * @returns Статистика исполнений (количество, объем, комиссии)
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @example
   * ```typescript
   * const stats = await client.getFillStats();
   * console.log(`Fills: ${stats.count}`);
   * console.log(`Volume: $${stats.volume.toFixed(2)}`);
   * console.log(`Fees paid: $${stats.totalFees.toFixed(2)}`);
   * ```
   */
  async getFillStats(params?: UserFillsParams): Promise<{
    count: number;
    volume: number;
    totalFees: number;
    buyCount: number;
    sellCount: number;
  }> {
    this.logger.debug('Calculating fill stats', params);

    const fills = await this.getUserFills(params);

    let volume = 0;
    let totalFees = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (const fill of fills) {
      const price = parseFloat(fill.price);
      const size = parseFloat(fill.size);
      volume += price * size;

      if (fill.fee_amount) {
        totalFees += parseFloat(fill.fee_amount);
      }

      if (fill.side === 'BUY') {
        buyCount++;
      } else {
        sellCount++;
      }
    }

    const stats = {
      count: fills.length,
      volume,
      totalFees,
      buyCount,
      sellCount,
    };

    this.logger.debug('Fill stats calculated', stats);

    return stats;
  }
}
