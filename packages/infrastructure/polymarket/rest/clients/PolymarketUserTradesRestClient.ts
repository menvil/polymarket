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

  /**
   * UUID владельца записи трейда (Polymarket internal user id).
   *
   * @remarks
   * НЕ доказывает единоличное владение всей записью: `maker_orders[]` может
   * содержать элементы ДРУГИХ пользователей (один trade — один matched-event,
   * может объединять несколько maker-ордеров разных владельцев). Используется
   * ТОЛЬКО как один из двух ключей matching для собственных `maker_orders[]`
   * записей (см. `owner`/`maker_address` внутри `maker_orders[]`), как и в WS
   * `FillMapper.allFromPolymarketTradeEvent`.
   */
  owner?: string;

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

  /**
   * Ордера мейкеров (массив). Один trade может matched-иться против
   * НЕСКОЛЬКИХ maker-ордеров одновременно — каждый элемент представляет
   * отдельный fill отдельного maker-ордера со своим `order_id`, и элементы
   * МОГУТ принадлежать РАЗНЫМ пользователям (не только нам). Используется
   * когда `trader_side === 'MAKER'`.
   *
   * @remarks
   * `owner`/`maker_address` — ключи принадлежности КОНКРЕТНОГО элемента (не
   * top-level trade record целиком). Владение обязано проверяться на уровне
   * элемента — см. `owner`/`maker_address` матчинг в
   * `FillMapper.allFromPolymarketTradeEvent` (та же логика переиспользуется
   * REST-адаптером).
   */
  maker_orders?: Array<{
    order_id: string;
    matched_amount: string;
    price?: string;
    asset_id?: string;
    side?: 'BUY' | 'SELL';
    fee_rate_bps?: string;
    /** UUID владельца ЭТОГО maker-ордера. */
    owner?: string;
    /** ETH-адрес владельца ЭТОГО maker-ордера. */
    maker_address?: string;
  }>;

  /**
   * On-chain статус сделки (реальный формат API — `TRADE_STATUS_*` префикс,
   * например `TRADE_STATUS_CONFIRMED`). Нормализация — в вызывающем адаптере.
   */
  status?: string;

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

  /** Максимальное количество исполнений для возврата (на одну страницу) */
  limit?: number;

  /** Возвращать только первую страницу, БЕЗ следования по `next_cursor` (по умолчанию: false) */
  only_first_page?: boolean;

  /**
   * Требовать канонический пагинированный объектный ответ (`{ data, next_cursor }`)
   * на КАЖДОЙ странице — используется authoritative-вызывающими (`getTrades()`
   * для settlement/reconciliation).
   *
   * @remarks
   * Официальная схема `/data/trades` ВСЕГДА возвращает объект с `next_cursor`
   * (`"LTE="` — сентинел завершения). Bare-array ответ или объект БЕЗ
   * `next_cursor` (ни на сентинеле) — признак schema drift/неполного ответа,
   * а не «страниц больше нет»: с `requireCursor: true` это бросает `Error`
   * вместо молчаливого принятия за «готово». Non-critical helper-методы
   * (`getTotalVolume`/`getFillStats`) НЕ передают этот флаг — сохраняют
   * прежнее толерантное поведение.
   */
  requireCursor?: boolean;
}

/**
 * Значение `next_cursor`, означающее «страниц больше нет» (см. Polymarket API
 * reference: `/data/trades`).
 */
const NO_MORE_PAGES_CURSOR = 'LTE=';

/** Защита от бесконечного цикла пагинации при неожиданном поведении API. */
const MAX_PAGES = 40;

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
   *
   * @remarks
   * ### Полнота (пагинация):
   * `/data/trades` пагинирован через `next_cursor` (base64 offset, `"LTE="` —
   * сентинел «страниц больше нет»). По умолчанию (`only_first_page` не `true`)
   * этот метод СЛЕДУЕТ по `next_cursor` до сентинела и возвращает ПОЛНЫЙ
   * набор — вызывающие (`getTrades()` → settlement/reconciliation) трактуют
   * пустой/неполный ответ как authoritative, поэтому частичный результат здесь
   * недопустим. Ограничение `MAX_PAGES` защищает от бесконечного цикла при
   * неожиданном поведении API — при его исчерпании БЕЗ сентинела метод
   * бросает `Error` (НЕ возвращает частичный список молча).
   */
  async getUserFills(params?: UserFillsParams): Promise<UserFillResponse[]> {
    this.logger.debug('Getting user fills', params);

    // Формируем параметры запроса (API ожидает snake_case)
    const baseParams: Record<string, string> = {};

    if (params?.market) {
      baseParams.market = params.market;
    }

    if (params?.asset_id) {
      baseParams.asset_id = params.asset_id;
    }

    if (params?.maker_address) {
      baseParams.maker_address = params.maker_address;
    }

    if (params?.before !== undefined) {
      baseParams.before = params.before.toString();
    }

    if (params?.after !== undefined) {
      baseParams.after = params.after.toString();
    }

    if (params?.limit !== undefined) {
      baseParams.limit = params.limit.toString();
    }

    if (params?.only_first_page !== undefined) {
      baseParams.only_first_page = params.only_first_page.toString();
    }

    const onlyFirstPage = params?.only_first_page === true;
    const requireCursor = params?.requireCursor === true;
    const fills: UserFillResponse[] = [];
    let cursor: string | undefined;
    let pages = 0;

    for (;;) {
      pages++;
      const queryParams: Record<string, string> = { ...baseParams };
      if (cursor !== undefined) {
        queryParams.next_cursor = cursor;
      }

      // API может вернуть массив (без пагинации) или пагинированный объект
      // { data: [...], next_cursor: "..." }.
      const raw = await this.restClient.get<UserFillResponse[] | { data: UserFillResponse[]; next_cursor?: string }>(
        '/data/trades',
        queryParams
      );

      if (requireCursor && Array.isArray(raw)) {
        throw new Error(
          'PolymarketUserTradesRestClient.getUserFills: expected canonical paginated object response ' +
          '({ data, next_cursor }), got a bare array — schema drift, refusing to treat as complete',
        );
      }

      const pageFills = Array.isArray(raw) ? raw : (raw?.data ?? []);
      fills.push(...pageFills);
      const nextCursor = Array.isArray(raw) ? undefined : raw?.next_cursor;

      if (nextCursor === undefined && requireCursor && nextCursor !== NO_MORE_PAGES_CURSOR) {
        throw new Error(
          'PolymarketUserTradesRestClient.getUserFills: paginated response is missing next_cursor ' +
          '(not at the "LTE=" sentinel) — schema drift, refusing to treat as complete',
        );
      }

      if (onlyFirstPage || nextCursor === undefined || nextCursor === NO_MORE_PAGES_CURSOR) {
        break;
      }
      if (pages >= MAX_PAGES) {
        throw new Error(
          `PolymarketUserTradesRestClient.getUserFills: pagination did not terminate after ${MAX_PAGES} pages ` +
          `(no "${NO_MORE_PAGES_CURSOR}" sentinel) — refusing to return a possibly incomplete trade list`,
        );
      }
      cursor = nextCursor;
    }

    this.logger.info('User fills retrieved', {
      count: fills.length,
      pages,
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
