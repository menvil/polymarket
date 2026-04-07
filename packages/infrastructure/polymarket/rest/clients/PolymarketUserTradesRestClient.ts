/**
 * REST-клиент пользовательских сделок Polymarket
 *
 * @remarks
 * Обрабатывает endpoint /data/trades (L2-аутентифицированный):
 * - GET /data/trades - Получить историю исполнений сделок пользователя
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется маппером в вышестоящих слоях.
 *
 * **ВАЖНО**: Возвращает ИСПОЛНЕНИЯ КОНКРЕТНОГО ПОЛЬЗОВАТЕЛЯ (аутентифицированные), НЕ публичные рыночные сделки.
 * Для публичных рыночных сделок используйте PolymarketTradesRestClient.
 *
 * @example
 * ```typescript
 * const client = new PolymarketUserTradesRestClient(restClient, logger);
 *
 * // Получить все исполнения пользователя
 * const fills = await client.getUserFills();
 * console.log(`Total fills: ${fills.length}`);
 *
 * // Получить исполнения для конкретного маркета
 * const marketFills = await client.getUserFills({ market: '0x123...' });
 * console.log(`Market fills: ${marketFills.length}`);
 *
 * // Получить исполнения для конкретного актива
 * const assetFills = await client.getUserFills({ asset_id: '123456...' });
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';

/**
 * Ответ с исполнением пользователя (сырой формат API)
 *
 * @remarks
 * Представляет одно исполнение (исполненную сделку) аутентифицированного пользователя.
 */
export interface UserFillResponse {
  /** Идентификатор сделки */
  id: string;

  /**
   * ID ордера тейкера.
   * Реальный Polymarket API возвращает `taker_order_id`, а не `order_id`.
   * Если пользователь был тейкером — это наш ордер.
   */
  taker_order_id?: string;

  /**
   * ID ордера мейкера.
   * Если пользователь был мейкером — это наш ордер.
   */
  maker_order_id?: string;

  /** Роль пользователя в сделке: 'TAKER' или 'MAKER' */
  trader_side?: string;

  /** Condition ID маркета */
  market: string;

  /** Идентификатор актива (токена) */
  asset_id: string;

  /** Направление сделки (BUY или SELL) */
  side: 'BUY' | 'SELL';

  /** Цена исполнения (строковый формат) */
  price: string;

  /** Размер исполнения (строковый формат) */
  size: string;

  /** Сумма комиссии (строковый формат) */
  fee_amount?: string;

  /** Ставка комиссии в базисных пунктах */
  fee_rate_bps?: string;

  /**
   * Timestamp исполнения как Unix epoch в секундах (numeric string): "1775457709".
   * НЕ ISO строка — требует явной конвертации: `new Date(Number(match_time) * 1000)`.
   */
  match_time?: string;

  /** Ордера мейкеров (массив). Используется когда trader_side === 'MAKER'. */
  maker_orders?: Array<{ order_id: string; matched_amount: string; fee_rate_bps: string }>;

  /** Последнее обновление (Unix epoch, строка) */
  last_update?: string;

  /** Адрес мейкера */
  maker_address?: string;

  /** Идентификатор матча */
  match_id?: string;

  /** Хэш транзакции */
  transaction_hash?: string;
}

/**
 * Параметры запроса исполнений пользователя
 */
export interface UserFillsParams {
  /** Позволяет передавать объект как Record<string, unknown> */
  [key: string]: unknown;
  /** Фильтр по condition ID маркета */
  market?: string;

  /** Фильтр по идентификатору актива (токена) */
  asset_id?: string;

  /** Фильтр по адресу мейкера */
  maker_address?: string;

  /** Фильтр исполнений до этой временной метки */
  before?: number;

  /** Фильтр исполнений после этой временной метки */
  after?: number;

  /** Максимальное количество исполнений для возврата */
  limit?: number;

  /** Возвращать только первую страницу (по умолчанию: false) */
  only_first_page?: boolean;
}

/**
 * REST-клиент пользовательских сделок Polymarket
 *
 * @remarks
 * L2-аутентифицированный клиент для получения истории исполнений сделок пользователя.
 */
export class PolymarketUserTradesRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить исполнения сделок пользователя
   *
   * @param params - Необязательные параметры запроса для фильтрации
   * @returns Массив исполнений пользователя (отсортированных по убыванию временной метки)
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Требует L2-аутентификацию (заголовки с подписью HMAC-SHA256).
   * Возвращает исполненные сделки пользователя, НЕ открытые ордера.
   *
   * @example
   * ```typescript
   * // Получить все исполнения
   * const fills = await client.getUserFills();
   *
   * // Получить исполнения для конкретного маркета
   * const marketFills = await client.getUserFills({
   *   market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
   * });
   *
   * // Получить последние исполнения (за последние 24 часа)
   * const recentFills = await client.getUserFills({
   *   after: Date.now() - 24 * 60 * 60 * 1000,
   * });
   *
   * // Получить исполнения для конкретного токена
   * const tokenFills = await client.getUserFills({
   *   asset_id: '108770292557037291842343444956827763454878470740965721806292624574119111069516',
   * });
   * ```
   */
  async getUserFills(params?: UserFillsParams): Promise<UserFillResponse[]> {
    this.logger.debug('Getting user fills', params);

    // Формируем параметры запроса (API ожидает snake_case)
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

    // Вызываем аутентифицированный endpoint
    // API может вернуть массив или пагинированный объект { data: [...], next_cursor: "..." }
    const raw = await this.restClient.get<UserFillResponse[] | { data: UserFillResponse[]; next_cursor?: string }>(
      '/data/trades',
      queryParams
    );

    const fills = Array.isArray(raw) ? raw : (raw?.data ?? []);

    this.logger.info('User fills retrieved', {
      count: fills.length,
      params,
    });

    return fills;
  }

  /**
   * Получить суммарный объём исполненных сделок пользователя
   *
   * @param params - Необязательные параметры запроса для фильтрации
   * @returns Суммарный объём (сумма size * price)
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Вычисляет суммарный долларовый объём всех исполнений.
   *
   * @example
   * ```typescript
   * // Суммарный объём по всем маркетам
   * const totalVolume = await client.getTotalVolume();
   * console.log(`Total traded: $${totalVolume.toFixed(2)}`);
   *
   * // Объём для конкретного маркета
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
   * Получить статистику исполнений пользователя
   *
   * @param params - Необязательные параметры запроса для фильтрации
   * @returns Статистика исполнений (количество, объём, комиссии)
   * @throws {ApiError} При ошибке API-вызова
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
